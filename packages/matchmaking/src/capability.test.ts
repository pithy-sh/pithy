// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isMatchmakingCapability, matchmaking } from "./capability";

const SNAPSHOT = { kind: "connect-n", rules: {} };

describe("matchmaking()", () => {
  test("resolves a valid config and exposes it on the capability", () => {
    const cap = matchmaking({ games: [{ key: "duel", snapshot: SNAPSHOT }] });
    expect(cap.name).toBe("matchmaking");
    expect(cap.matchmakingConfig.games[0]?.key).toBe("duel");
    expect(isMatchmakingCapability(cap)).toBe(true);
  });

  test("declares D1, KV, and the two Durable Object bindings", () => {
    const cap = matchmaking({ games: [{ key: "duel", snapshot: SNAPSHOT }] });
    const bindings = cap.requiredBindings.map((b) => `${b.type}:${b.name}`);
    expect(bindings).toContain("d1:DB");
    expect(bindings).toContain("kv:MATCHMAKING");
    expect(bindings).toContain("durable_object:QUEUE");
    expect(bindings).toContain("durable_object:PRESENCE");
  });

  test("rejects duplicate game keys at assembly", () => {
    expect(() =>
      matchmaking({
        games: [
          { key: "duel", snapshot: SNAPSHOT },
          { key: "duel", snapshot: SNAPSHOT },
        ],
      }),
    ).toThrow(/Duplicate game key/);
  });

  test("defaults friends on and abuse off", () => {
    const cap = matchmaking({ games: [{ key: "duel", snapshot: SNAPSHOT }] });
    expect(cap.matchmakingConfig.friends).toBe(true);
    expect(cap.matchmakingConfig.abuse.turnstile).toBe(false);
    expect(cap.matchmakingConfig.abuse.rateLimit).toBe(false);
  });

  // The README is this package's only adopter-facing wiring instruction — it has no `pithy.manifest.json`
  // yet, because it is not in the CLI's catalog. #180 moved where the Durable Object classes can be
  // imported from: they left the package entry point, which an adopter's `pithy.config.ts` imports and
  // every Node-side CLI command loads. An instruction naming `src/index` would now name a module that
  // does not export them — a worker that fails at bundle time, on the line the docs told them to write.
  test("tells the adopter to export each Durable Object from its own module, not the entry point", () => {
    const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    const classNames = matchmaking({ games: [{ key: "duel", snapshot: SNAPSHOT }] })
      .requiredBindings.filter((binding) => binding.type === "durable_object")
      .map((binding) => binding.className);

    expect(classNames).toHaveLength(2);
    for (const className of classNames) {
      const line = readme.split("\n").find((candidate) => candidate.includes(`export { ${className} }`));
      expect(line, `README states no worker export for ${className}`).toBeDefined();
      expect(line).not.toContain("@pithy-sh/matchmaking/src/index");
      expect(line).toContain("/durableObject");
    }
  });
});
