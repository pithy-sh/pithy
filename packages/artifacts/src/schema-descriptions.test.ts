// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { undescribedExports } from "@pithy-sh/core/src/schema/describedness";
import { describe, expect, test } from "vitest";

// `import.meta.glob` is a vite/vitest feature; declare it so plain `tsc` typecheck accepts it.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

// Eagerly import every source module except tests, so a newly exported schema is covered with no list to keep.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], { eager: true });
describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the sweep is looking at the package, not at nothing", () => {
    // Pinned near the measured population (2026-10-18: 17 modules, 25 schemas, 80 fields), so a glob that lost
    // the package is loud rather than green.
    const walk = undescribedExports(modules);
    expect(walk.modules).toBeGreaterThanOrEqual(15);
    expect(walk.schemas).toBeGreaterThanOrEqual(20);
    expect(walk.fields).toBeGreaterThanOrEqual(60);
  });

  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const walk = undescribedExports(modules);
    expect(walk.missing, walk.missing.join("\n")).toEqual([]);
  });
});
