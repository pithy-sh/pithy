// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RemoveCapabilityOptions } from "../capabilities/remove";
import { collectMigrationSets } from "../migrations/registry";
import remove, { rejectJson } from "./remove";

/** What `pithy remove` handed the removal: the drop's environment, and the composition it reverses from. */
const seen = vi.hoisted(() => ({ calls: [] as { drop: string | undefined; migrations: string[] }[] }));

vi.mock("../capabilities/remove", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/remove")>()),
  removeCapability: async (options: RemoveCapabilityOptions) => {
    const capabilities = await options.steps.loadCapabilities();
    seen.calls.push({
      drop: options.drop?.env,
      migrations: collectMigrationSets(capabilities).flatMap((set) => Object.keys(set.migrations)),
    });
    return {
      capability: options.capability,
      present: false,
      ejected: false,
      removedBindings: [],
      keptFor: [],
      tablesRemain: false,
    };
  },
}));

describe("remove command", () => {
  test("meta and args shape — --worker names the worker to unwire", () => {
    const args = remove.args as Record<string, { type: string; default?: unknown; required?: boolean }>;
    expect(remove.meta).toMatchObject({ name: "remove" });
    expect(Object.keys(args)).toEqual(["capability", "worker", "drop", "env", "json"]);
    expect(args.capability).toMatchObject({ type: "positional", required: true });
    expect(args.worker).toMatchObject({ type: "string" });
  });
});

describe("rejectJson", () => {
  test("fast-fails on --json with a manual-command PithyError", () => {
    const failure = (() => {
      try {
        rejectJson(true);
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toMatch(/manual command/i);
  });

  test("does nothing without --json", () => {
    expect(() => rejectJson(false)).not.toThrow();
  });
});

/**
 * **`pithy remove --drop --env staging` reverses the migrations of the composition for staging (#595).**
 *
 * The Worker it unwires was picked by `commands/add.ts`'s `targetWorker`, which composed with no environment
 * stamped, and the drop reversed the migrations of that composition. A config that composes a migration for
 * staging alone had that migration left out of a drop against staging's database. The environments gate did
 * not see it, because the composition was carried out of `add.ts` by a function `remove.ts` called.
 */
describe("remove --drop composes for the environment it drops", () => {
  let dir: string;

  beforeEach(async () => {
    seen.calls.length = 0;
    dir = await mkdtemp(join(tmpdir(), "pithy-remove-env-"));
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme", environments: ["staging"] };\n');
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: "api" }));
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      [
        'const environment = process.env.ENVIRONMENT ?? "none";',
        "const noop = { up: async () => {}, down: async () => {} };",
        "export default {",
        "  capabilities: [",
        '    { name: "app", requiredBindings: [], databases: { app: { binding: "DB", tables: {}, migrationOrder: 1000, migrations: { [["0001", environment].join(":")]: noop } } } },',
        "  ],",
        "};",
        "",
      ].join("\n"),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(args: Record<string, unknown>): Promise<void> {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await remove.run?.({
        args: { capability: "app", json: false, drop: false, env: "dev", ...args },
        rawArgs: [],
      } as never);
    } finally {
      cwd.mockRestore();
      stdout.mockRestore();
    }
  }

  test("a drop for staging reverses staging's migrations, and a plain unwiring reads dev's", async () => {
    await run({ drop: true, env: "staging" });
    await run({});
    expect(seen.calls).toEqual([
      { drop: "staging", migrations: ["0001:staging"] },
      { drop: undefined, migrations: ["0001:dev"] },
    ]);
  });
});
