// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { entitlementGates, entitlementProvider, findEntitlementGap } from "./entitlementGap";

/** A Worker directory with the given files under `src/`, written relative to the Worker root. */
async function worker(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-entitlement-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
  return dir;
}

const gated = `
import { requireEntitlement } from "@pithy-sh/core/src/entitlement/require";
export const routes = (app) => app.get("/reports", requireEntitlement("pro"), (c) => c.json({}));
`;

const provider = defineCapability({ name: "payments", requiredBindings: [], providesEntitlements: true });
const plain = defineCapability({ name: "leaderboard", requiredBindings: [] });

describe("finding the gates", () => {
  test("a route calling requireEntitlement is found", async () => {
    const dir = await worker({ "src/routes.ts": gated });
    await expect(entitlementGates(dir)).resolves.toEqual(["src/routes.ts"]);
  });

  test("requireAnyEntitlement counts too", async () => {
    const dir = await worker({
      "src/routes.ts": `app.get("/x", requireAnyEntitlement(["pro", "lifetime"]), handler);`,
    });
    await expect(entitlementGates(dir)).resolves.toEqual(["src/routes.ts"]);
  });

  test("gates are reported once per file, sorted, however many a file carries", async () => {
    const dir = await worker({
      "src/b.ts": `requireEntitlement("pro"); requireEntitlement("team");`,
      "src/a.tsx": `requireEntitlement("pro")`,
    });
    await expect(entitlementGates(dir)).resolves.toEqual(["src/a.tsx", "src/b.ts"]);
  });

  test("a Worker with no gates has none", async () => {
    const dir = await worker({ "src/routes.ts": `app.get("/free", (c) => c.json({}));` });
    await expect(entitlementGates(dir)).resolves.toEqual([]);
  });

  test("a mention in a comment is not a gate — the pure scanner's rules apply through the walk", async () => {
    // One case here, deliberately. Comment blanking, the `/*`-in-a-string trap and the rest belong to
    // `@pithy-sh/core/src/entitlement/gateScan` and are tested there; this only proves it is wired in.
    const dir = await worker({
      "src/routes.ts": `// TODO: put requireEntitlement("pro") on this once payments lands.\napp.get("/x", h);`,
    });
    await expect(entitlementGates(dir)).resolves.toEqual([]);
  });

  test("only the Worker's own source is scanned", async () => {
    // `node_modules` holds every capability's source — including the seam's own tests and docs — so
    // scanning it would report a gap on every project that installed core.
    const dir = await worker({
      "node_modules/@pithy-sh/core/src/entitlement/require.ts": gated,
      "dist/routes.js": gated,
      "src/routes.ts": `app.get("/free", h);`,
    });
    await expect(entitlementGates(dir)).resolves.toEqual([]);
  });

  test("a Worker with no src/ directory is not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-entitlement-"));
    await expect(entitlementGates(dir)).resolves.toEqual([]);
  });
});

describe("finding the provider", () => {
  test("a capability declaring providesEntitlements is the provider", () => {
    expect(entitlementProvider([plain, provider])).toBe("payments");
  });

  test("a composed set with no provider has none", () => {
    expect(entitlementProvider([plain])).toBeNull();
  });

  test("an empty set has none", () => {
    expect(entitlementProvider([])).toBeNull();
  });
});

describe("the gap", () => {
  test("gates with no provider composed is the gap, and names the files", async () => {
    const dir = await worker({ "src/routes.ts": gated });
    await expect(findEntitlementGap(dir, [plain])).resolves.toEqual(["src/routes.ts"]);
  });

  test("gates with a provider composed is no gap", async () => {
    const dir = await worker({ "src/routes.ts": gated });
    await expect(findEntitlementGap(dir, [plain, provider])).resolves.toEqual([]);
  });

  test("no gates and no provider is no gap — most projects are not paid", async () => {
    const dir = await worker({ "src/routes.ts": `app.get("/free", h);` });
    await expect(findEntitlementGap(dir, [plain])).resolves.toEqual([]);
  });

  test("a provider with no gates is no gap — the routes may be added later", async () => {
    const dir = await worker({ "src/routes.ts": `app.get("/free", h);` });
    await expect(findEntitlementGap(dir, [provider])).resolves.toEqual([]);
  });
});
