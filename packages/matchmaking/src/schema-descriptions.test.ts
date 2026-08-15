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

// Eagerly import every source module except tests, so any newly exported schema is covered automatically.
// Mirrors core's and leaderboard's meta-test.
//
// Only the Durable Object modules and the test-worker shell are excluded: they import `cloudflare:workers`,
// which resolves in the Workers runtime and nowhere else. Their exported schemas are re-exported from the
// pure `config`/`data`/`queue/matching` modules, which this test does cover.
//
// `index.ts` used to be excluded here too, for the same reason — it re-exported both DO classes. #180 cut
// that edge, and dropping it from this list is what proves it: the entry point an adopter's
// `pithy.config.ts` imports now loads in a node environment.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./testWorker.ts", "!./**/durableObject.ts"], {
  eager: true,
});
describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the sweep is looking at the package, not at nothing", () => {
    // **The guard sixteen of nineteen of these files did without** (#326, #351). A glob that matches
    // nothing produces no findings, and no findings is what passing looks like — so the population is
    // pinned in three places, and a collapse in any one of them is loud.
    //
    // Near-exact, not a comfortable floor: measured at 24 modules, 29 schemas and 76 fields on
    // 2026-08-15, and each floor is 95% of that. The slack is there so deleting a module is not a red
    // build; it is nowhere near enough for a glob that lost the package.
    const walk = undescribedExports(modules);
    expect(walk.modules).toBeGreaterThanOrEqual(22);
    expect(walk.schemas).toBeGreaterThanOrEqual(27);
    expect(walk.fields).toBeGreaterThanOrEqual(72);
  });

  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const walk = undescribedExports(modules);
    expect(walk.missing, walk.missing.join("\n")).toEqual([]);
  });
});
