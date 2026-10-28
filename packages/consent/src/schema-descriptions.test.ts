// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { undescribedExports } from "@pithy-sh/core/src/schema/describedness";
import { describe, expect, test } from "vitest";

// `import.meta.glob` is a vite/vitest feature; declare it so the typecheck accepts it.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

// Eagerly import every source module except tests, so any newly exported schema is covered automatically
// — no manual list to keep in sync. Mirrors core's and rating's meta-test.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], { eager: true });
describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the sweep is looking at the package, not at nothing", () => {
    // A glob that matches nothing produces no findings, and no findings is what passing looks like — so the
    // population is pinned in three places, and a collapse in any one of them is loud. Each floor sits about 10%
    // under the package's own count: near-exact, not a comfortable floor.
    const walk = undescribedExports(modules);
    expect(walk.modules).toBeGreaterThanOrEqual(20);
    expect(walk.schemas).toBeGreaterThanOrEqual(26);
    expect(walk.fields).toBeGreaterThanOrEqual(106);
  });

  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const walk = undescribedExports(modules);
    expect(walk.missing, walk.missing.join("\n")).toEqual([]);
  });
});
