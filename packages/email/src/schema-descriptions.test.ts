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
// automatically — no manual list to keep in sync. Mirrors core's meta-test. `workflows/worker.ts`
// imports `cloudflare:workers` (Workers-runtime only), so it can't be eagerly imported here — exclude
// it; it exports no schemas anyway.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./workflows/worker.ts"], { eager: true });
describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the sweep is looking at the package, not at nothing", () => {
    // **The guard sixteen of nineteen of these files did without** (#326, #351). A glob that matches
    // nothing produces no findings, and no findings is what passing looks like — so the population is
    // pinned in three places, and a collapse in any one of them is loud.
    //
    // Near-exact, not a comfortable floor: measured at 57 modules, 45 schemas and 265 fields on
    // 2026-08-23 (48/39/235 on 2026-08-15), and each floor is 95% of that. The slack is there so
    // deleting a module is not a red build; it is nowhere near enough for a glob that lost the package.
    //
    // The stated count said 56 and the floor said 53 — 93% of what the glob actually returns, not the
    // 95% the line above promises. A census that is wrong about its own population is not a census, so
    // all three numbers are re-measured here rather than nudged.
    const walk = undescribedExports(modules);
    expect(walk.modules).toBeGreaterThanOrEqual(54);
    expect(walk.schemas).toBeGreaterThanOrEqual(42);
    expect(walk.fields).toBeGreaterThanOrEqual(251);
  });

  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const walk = undescribedExports(modules);
    expect(walk.missing, walk.missing.join("\n")).toEqual([]);
  });
});
