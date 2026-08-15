// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { undescribedExports } from "@pithy-sh/core/src/schema/describedness";
import { describe, expect, test } from "vitest";

// `import.meta.glob` is a vite/vitest feature; declare it so plain `tsc` typecheck accepts it.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

/**
 * **CLAUDE.md §Zod: the schemas are the documentation.** Every object, enum and union carries a
 * `.describe()`, and so does every field of every object.
 *
 * Eagerly import every source module except tests, so any newly exported schema is covered
 * automatically — there is no manual list to keep in sync. Mirrors core's meta-test.
 *
 * ## Two things this could not observe
 *
 * **It had no anti-vacuity guard.** Sixteen of the nineteen packages carrying this sweep had none: a
 * glob that matched nothing, a `src` that moved, or a build that exported no schema left `missing`
 * empty and the test green, over nothing. So the population is now pinned — the modules found, the Zod
 * exports found, and the fields actually visited. All nineteen pin theirs (#351).
 *
 * **It only walked object fields.** The walk recursed into `ZodObject` shapes and stopped, so an object
 * inside an array, inside an `.optional()`, inside a record or inside a union member was never reached
 * — and those are where the undescribed fields actually accumulate, because a field wrapped in anything
 * at all looks described from the outside. #326 deepened it here and only here; #351 moved it to
 * `@pithy-sh/core/src/schema/describedness`, where all nineteen packages get the same depth from one
 * implementation rather than nineteen that drift.
 */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], { eager: true });
describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the sweep is looking at the package, not at nothing", () => {
    // **The guard sixteen of nineteen of these files did without** (#326, #351). A glob that matches
    // nothing produces no findings, and no findings is what passing looks like — so the population is
    // pinned in three places, and a collapse in any one of them is loud.
    //
    // Near-exact, not a comfortable floor: measured at 19 modules, 10 schemas and 95 fields on
    // 2026-08-15, and each floor is 95% of that. The slack is there so deleting a module is not a red
    // build; it is nowhere near enough for a glob that lost the package.
    const walk = undescribedExports(modules);
    expect(walk.modules).toBeGreaterThanOrEqual(18);
    expect(walk.schemas).toBeGreaterThanOrEqual(9);
    expect(walk.fields).toBeGreaterThanOrEqual(90);
  });

  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const walk = undescribedExports(modules);
    expect(walk.missing, walk.missing.join("\n")).toEqual([]);
  });
});
