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
// automatically — no manual list to keep in sync. Mirrors core's meta-test. `rank/worker.entry.ts` is the
// deployed worker's default-export shell and pulls in Workers-runtime types only, so it is excluded here
// along with the tests.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./rank/worker.entry.ts"], { eager: true });
describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the sweep is looking at the package, not at nothing", () => {
    // **The guard sixteen of nineteen of these files did without** (#326, #351). A glob that matches
    // nothing produces no findings, and no findings is what passing looks like — so the population is
    // pinned in three places, and a collapse in any one of them is loud.
    //
    // Near-exact, not a comfortable floor: measured at 27 modules, 27 schemas and 56 fields on
    // 2026-08-15, and each floor is 95% of that. The slack is there so deleting a module is not a red
    // build; it is nowhere near enough for a glob that lost the package.
    const walk = undescribedExports(modules);
    expect(walk.modules).toBeGreaterThanOrEqual(25);
    expect(walk.schemas).toBeGreaterThanOrEqual(25);
    expect(walk.fields).toBeGreaterThanOrEqual(53);
  });

  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const walk = undescribedExports(modules);
    expect(walk.missing, walk.missing.join("\n")).toEqual([]);
  });
});
