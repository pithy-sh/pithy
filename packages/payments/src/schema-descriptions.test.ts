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
// Mirrors core's meta-test. Every module here imports `@cloudflare/workers-types` type-only (erased), so
// they load fine in node. Two exclusions, both by necessity rather than by choice, and neither exports a
// schema: `workflows/worker.ts` imports `cloudflare:workers` at runtime, which no node loader can resolve
// (the Workflow's parameters live in `workflows/specs.ts`, which is covered here), and
// `client/paddlePrices.iife.ts` is the browser build's entry — the one module in this package that *runs* when
// it is imported, reaching for `document.currentScript` the moment it does. Importing either would fail
// the whole meta-test rather than the module, so nothing escapes the check by being excluded.
const modules = import.meta.glob(
  ["./**/*.ts", "!./**/*.test.ts", "!./workflows/worker.ts", "!./client/paddlePrices.iife.ts"],
  { eager: true },
);
describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the sweep is looking at the package, not at nothing", () => {
    // **The guard sixteen of nineteen of these files did without** (#326, #351). A glob that matches
    // nothing produces no findings, and no findings is what passing looks like — so the population is
    // pinned in three places, and a collapse in any one of them is loud.
    //
    // Near-exact, not a comfortable floor: measured at 115 modules, 142 schemas and 652 fields on
    // 2026-08-15, and each floor is 95% of that. The slack is there so deleting a module is not a red
    // build; it is nowhere near enough for a glob that lost the package.
    const walk = undescribedExports(modules);
    expect(walk.modules).toBeGreaterThanOrEqual(109);
    expect(walk.schemas).toBeGreaterThanOrEqual(134);
    expect(walk.fields).toBeGreaterThanOrEqual(619);
  });

  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const walk = undescribedExports(modules);
    expect(walk.missing, walk.missing.join("\n")).toEqual([]);
  });
});
