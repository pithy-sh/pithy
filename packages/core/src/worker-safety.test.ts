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
 *
 * ## Stated as what is allowed, not as what is banned
 *
 * This scanned for the `node:` prefix and nothing else, which is a shorter rule than the one above.
 * `import { createHash } from "crypto"` is a Node builtin, resolves as one, breaks the bundle exactly
 * as `node:crypto` does — and was invisible here, as were `fs`, `path` and `buffer`. A ban that
 * enumerates one spelling of a thing with two spellings is the shape this repository has shipped
 * repeatedly, so the enumeration is gone.
 *
 * What replaces it is the positive property: **every module specifier a core source imports is either
 * relative or one of the packages core declares a dependency on.** `crypto` is not on that list, and
 * neither is a package added to an import without being added to `package.json` — which is the same
 * defect arriving from the other side. The list is a frozen literal, deliberately not read from
 * `package.json`: a dependency added to the manifest is exactly the change that should have to be made
 * here too, and a set derived from the file under test cannot notice it.
 */
const sources = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], {
  eager: true,
  query: "?raw",
  import: "default",
});

/**
 * Every non-relative module specifier a core source is allowed to name. **A frozen literal.**
 *
 * Every entry is a `dependencies` entry of `packages/core/package.json`, or a subpath export of one.
 * Nothing here is a Node builtin and nothing here ever will be: core is bundled into a Worker.
 */
const ALLOWED_SPECIFIERS: ReadonlySet<string> = new Set([
  "@cloudflare/workers-types",
  "@hono/zod-validator",
  "hono",
  "hono/http-exception",
  "hono/utils/http-status",
  "kysely",
  "kysely-d1",
  "kysely/migration",
  "zod",
]);

/** Comments stripped, so a module that *discusses* `node:crypto` is not reported for the sentence. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

/**
 * Every module specifier a source imports or re-exports, static and dynamic alike.
 *
 * Statement-shaped rather than a loose search for `from "…"`. Core writes the word "from" inside
 * template literals and error messages, and `export type Environment = "dev" | "prod";` is a line
 * starting with `export` and ending in a quoted string — a scan reading either as an import would
 * report a sentence and a type. So a statement starts at column 0 (Biome formats every import that
 * way), runs to its semicolon, and only its *trailing* specifier counts.
 */
function specifiers(source: string): string[] {
  const lines = code(source).split("\n");
  const found: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (!/^(?:import|export)\b/.test(line)) continue;
    // A binding list spans lines. Accumulate to the semicolon, but never across the start of the next
    // statement — a function body would otherwise swallow whatever followed it.
    let statement = line;
    while (
      !statement.trimEnd().endsWith(";") &&
      index + 1 < lines.length &&
      !/^(?:import|export)\b/.test(lines[index + 1] as string)
    ) {
      index += 1;
      statement += `\n${lines[index]}`;
    }
    const match = /(?:^import|\bfrom)\s*["']([^"']+)["']\s*;$/.exec(statement.trimEnd());
    if (match) found.push(match[1] as string);
  }
  for (const match of code(source).matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    found.push(match[1] as string);
  }
  return found;
}

describe("core stays Worker-safe", () => {
  test("every source module is covered by this scan", () => {
    // A glob that silently matched nothing would make the whole suite a no-op. Near-exact rather than a
    // comfortable floor: core holds 104 non-test modules as this is written, and a scan that came back
    // with 30 of them would be reporting on a package other than the one being changed.
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(100);
    // And it is *this* tree, not some other one that happens to have files in it.
    expect(Object.keys(sources)).toContain("./error/pithyError.ts");
    expect(Object.keys(sources)).toContain("./capability/capability.ts");
  });

  test("every module core imports is relative, or a package core depends on", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      for (const specifier of specifiers(source)) {
        if (specifier.startsWith(".")) continue;
        if (ALLOWED_SPECIFIERS.has(specifier)) continue;
        offenders.push(`${path} imports "${specifier}"`);
      }
    }
    expect(
      offenders,
      `Core is bundled into the adopter's Worker. These specifiers are neither relative nor a declared dependency — a Node builtin here breaks every consumer's deploy at bundle time:\n${offenders.map((line) => `  ${line}`).join("\n")}`,
    ).toEqual([]);
  });

  test("the scan reads imports, and it reads every spelling of one", () => {
    // The gate over the gate. `specifiers` is the whole check, so a form it cannot see is a hole the
    // check above cannot report — and the bare-specifier form is precisely the one that was invisible.
    // Each line here is a real import shape; each must be extracted, and the prose must not be.
    const sample = [
      'import { createHash } from "crypto";',
      'import type { Stats } from "node:fs";',
      'import "side-effect-module";',
      "import {",
      "  alpha,",
      "  beta,",
      '} from "multi-line";',
      'export { thing } from "./local";',
      'export type Environment = "dev" | "prod";',
      'const dyn = await import("node:path");',
      '// import { lie } from "commented-out";',
      'const message = `read from "somewhere"`;',
      "export function describe(): string {",
      '  return "nothing here is an import";',
      "}",
    ].join("\n");
    expect(specifiers(sample)).toEqual([
      "crypto",
      "node:fs",
      "side-effect-module",
      "multi-line",
      "./local",
      "node:path",
    ]);
  });
});
