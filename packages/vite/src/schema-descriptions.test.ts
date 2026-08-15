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

// Eagerly import every source module except tests, so any newly exported schema is covered
// automatically — there is no manual list to keep in sync.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], { eager: true });

describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the sweep is looking at the package, not at nothing", () => {
    // The glob is the only thing this package's sweep can pin, and it must still be pinned: a package
    // that exports no schema and a glob that matched no module are the same green run otherwise.
    // Exact rather than near-exact, because four is small enough that 95% of it is noise.
    expect(undescribedExports(modules).modules).toBeGreaterThanOrEqual(4);
  });

  /**
   * This package exports no schema: it validates through `@pithy-sh/core`'s `ClientProjection` rather
   * than declaring shapes of its own. So rather than a describe-check that polices nothing, this
   * asserts the *reason* it polices nothing — and fails the moment that stops being true, pointing at
   * what to do. A weakened assertion (`schemas >= 0`) would read as coverage while asserting nothing.
   */
  test("exports no Zod schema — the sweep below is correct, and vacuous until one lands", () => {
    expect(undescribedExports(modules).schemas).toBe(0);
  });

  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const walk = undescribedExports(modules);
    expect(walk.missing, walk.missing.join("\n")).toEqual([]);
  });
});
