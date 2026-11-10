// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { undescribedExports } from "./schema/describedness";

// `import.meta.glob` is a vite/vitest feature; declare it so the typecheck accepts it.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

// Eagerly import every source module except tests, so any newly exported schema is covered
// automatically — there is no manual list to keep in sync.
// The presence room's Durable Object module is left out: it imports `cloudflare:workers`, which exists only in
// workerd, and exports no schema.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./presence/durableObject.ts"], {
  eager: true,
});
describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the sweep is looking at the package, not at nothing", () => {
    // A glob that matches nothing produces no findings, and no findings is what passing looks like, so the
    // population is pinned in three places. Each floor is near-exact, about 95% of what the package holds:
    // enough slack that deleting a module is not a red build, nowhere near enough for a glob that lost the
    // package. One edit to a shared schema such as `publicFields` moves the field count by hundreds, so after
    // one the floor is re-measured, never nudged until it goes green.
    const walk = undescribedExports(modules);
    expect(walk.modules).toBeGreaterThanOrEqual(122);
    expect(walk.schemas).toBeGreaterThanOrEqual(108);
    expect(walk.fields).toBeGreaterThanOrEqual(1368);
  });

  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const walk = undescribedExports(modules);
    expect(walk.missing, walk.missing.join("\n")).toEqual([]);
  });
});
