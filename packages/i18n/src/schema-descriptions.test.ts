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
// automatically — no manual list to keep in sync. Mirrors core's meta-test.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], { eager: true });
describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the sweep is looking at the package, not at nothing", () => {
    // **The guard sixteen of nineteen of these files did without** (#326, #351). A glob that matches
    // nothing produces no findings, and no findings is what passing looks like — so the population is
    // pinned in three places, and a collapse in any one of them is loud.
    //
    // **Re-measured on 2026-08-23 (#441): 20 modules, 5 schemas, 9 fields.** The previous comment said
    // 19 modules against a glob that returned 20, and set the schema floor at 4 — which is 80% of 5,
    // not the 95% this family of guards is specified to be, and 80% of a five-member population is not
    // a guard at all.
    //
    // So each floor is 95% of that, rounded down — the same rule `core`, `auth` and `email` state, and
    // written the same way here because the four were drifting into two rules and the next person to
    // re-measure one had to pick. On twenty modules that leaves one of slack, which is the point:
    // deleting a module is not a red build. On five schemas and nine fields it leaves one each, which
    // is all a population that small can spare — and a schema leaving this package is a real event
    // anyway, worth a line in a diff.
    const walk = undescribedExports(modules);
    expect(walk.modules).toBeGreaterThanOrEqual(19);
    expect(walk.schemas).toBeGreaterThanOrEqual(4);
    expect(walk.fields).toBeGreaterThanOrEqual(8);
  });

  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const walk = undescribedExports(modules);
    expect(walk.missing, walk.missing.join("\n")).toEqual([]);
  });
});
