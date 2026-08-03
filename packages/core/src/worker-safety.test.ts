// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";

// `import.meta.glob` is a vite/vitest feature; declare it so plain `tsc` typecheck accepts it.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true; query: "?raw"; import: "default" }): Record<string, string>;
  }
}

/**
 * `@pithy-sh/core` is bundled into the adopter's Worker, so it must depend on **no Node builtin**.
 * A `node:crypto` import for a hash, or a `node:path` for a join, breaks every consumer's deploy —
 * and does it at bundle time, far from whoever added the import.
 *
 * The rule is easy to state and easy to violate by reflex, so it is asserted over the whole package
 * rather than trusted per file. Every source module is read raw and scanned; the test list is the
 * file list, so a new module is covered the moment it lands.
 *
 * `@cloudflare/workers-types` is core's only ambient type dependency (see its `tsconfig.json`),
 * which is what makes a Node import a type error in most places already — but `import type` and a
 * dynamic `await import()` both slip past that, and this catches them.
 */
const sources = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], {
  eager: true,
  query: "?raw",
  import: "default",
});

/** Matches a static or dynamic `node:` specifier in any import form. */
const NODE_BUILTIN = /(?:from\s*|import\s*\(\s*)["']node:([a-z/]+)["']/g;

describe("core stays Worker-safe", () => {
  test("every source module is covered by this scan", () => {
    // A glob that silently matched nothing would make the whole suite a no-op.
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  test("no module imports a node: builtin", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      for (const match of source.matchAll(NODE_BUILTIN)) {
        offenders.push(`${path} imports node:${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
