// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserProgram } from "./program";

/**
 * The instrument, held to each shape somebody has got past a gate here.
 *
 * `responseCoverage.test.ts` proves the gate sees **this repository**: it asserts that `link/sender.ts`,
 * a real module that really is a Worker's, pulls in the Workers types. That assertion is the one no
 * fixture can fake, and it is why it lives there rather than here.
 *
 * It cannot prove the rest. Most of the ways a module can fail the rule **have no producer in this
 * repository today** — nothing writes a `.js`-suffixed specifier into a reached module, no reached `.ts`
 * carries a reference directive — so a real-tree assertion about either would pass on an empty set
 * forever. This file is the other half, and the division is the one that makes both worth having: **the
 * real tree proves the gate is pointed at the repository; the fixtures prove it recognises what it finds
 * there.**
 *
 * ## Every fixture here is a defect that was reproduced, not a shape somebody imagined
 *
 * The gate this replaces was a regex walk over source text, and the regex was wrong three times in two
 * rounds. `program.ts` carries the argument for why that made the instrument the defect. These are the
 * cases, kept, because the claim being made is that the compiler answers all of them at once and a
 * claim like that is worth a fixture per instance:
 *
 * - **A named import of the Workers types.** Compiles anywhere, so `types: []` never objected.
 * - **A reference directive.** Defeated the old walk and `tsc` at the same time: the specifier pattern
 *   matched statements, and `tsc` honours a directive whatever `types: []` says. That second half is
 *   precisely *why* the compiler catches it now — honouring it and listing the file are one event.
 * - **A directive inside a template literal.** `@pithy-sh/vite` emits one into a declaration file it
 *   writes. Text a module produces is not ambient types a module acquires, and a gate that cannot tell
 *   them apart is a gate somebody turns off.
 * - **A comment inside a multi-line import list.** The pattern was `[^;]*?`, so one semicolon in a
 *   comment hid the whole statement. Planted in `packages/`, this re-attached the #419 chain at exit 0.
 * - **A `.json` import.** `resolveJsonModule` makes it a real compiler-followed edge, and the old
 *   resolver threw on it — 23 of the 53 modules it refused across the tree.
 * - **A `.js`-suffixed specifier.** Bundler resolution follows it to the `.ts` beside it. The old
 *   resolver tried two candidates and dropped the rest in silence.
 *
 * Each fixture is a whole miniature `packages/`, written to a scratch directory and torn down after,
 * with its own `node_modules/@cloudflare/workers-types` so the offending import resolves to something
 * the classifier can name. Nothing here reads the kit, which is also why this file adds no cross-package
 * read for `.github/scripts/crossPackageReads.ts` to plan on.
 *
 * Each fixture is one `tsc` run, about half a second on the Go compiler. That is the price of asking the
 * compiler instead of guessing at its grammar, and it is worth paying.
 */

/** A miniature `packages/`, one entry per file: root-relative path to source. */
type Tree = Readonly<Record<string, string>>;

/** The compile options under gate. Extended by every fixture, so no fixture can drift from the real one. */
const BASE = fileURLToPath(new URL("../tsconfig.responses.json", import.meta.url));

/** The header every kit module carries, so a fixture is not accidentally a special case. */
const HEADER = "// SPDX-FileCopyrightText: 2026 Pithy\n// SPDX-License-Identifier: MIT\n\n";

/** Enough of `@cloudflare/workers-types` to be resolvable and to declare the one name these use. */
const WORKERS_TYPES: Tree = {
  "node_modules/@cloudflare/workers-types/package.json": JSON.stringify({
    name: "@cloudflare/workers-types",
    version: "0.0.0",
    types: "index.d.ts",
  }),
  "node_modules/@cloudflare/workers-types/index.d.ts": "export interface D1Database {\n  readonly d1: true;\n}\n",
};

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "pithy-browser-scopes-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Writes `tree` under a fresh directory and answers where its root is. */
function write(name: string, tree: Tree): string {
  const root = join(scratch, name);
  for (const [path, source] of Object.entries({ ...WORKERS_TYPES, ...tree })) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source, "utf8");
  }
  return root;
}

/** One fixture's answer: what a browser program rooted at `alpha/src/http/responses.ts` includes. */
function included(name: string, tree: Tree) {
  const root = write(name, tree);
  return browserProgram({ base: BASE, roots: [join(root, "alpha/src/http/responses.ts")], ours: [root] });
}

describe("what a browser's program includes, asked of the compiler", () => {
  it("clears a graph that needs nothing of a Worker", () => {
    // The vacuity floor, and it is the first assertion for a reason: every other test below asserts that
    // something is *found*, and a classifier that answered "dependency" to everything would pass them all.
    const program = included("clean", {
      "alpha/src/http/responses.ts": `${HEADER}import { SCOPE } from "../data/scope";\nexport const wire = SCOPE;\n`,
      "alpha/src/data/scope.ts": `${HEADER}export const SCOPE = "user";\n`,
    });
    expect(program.dependencies).toEqual([]);
    expect(program.strangers).toEqual([]);
    expect(program.ours).toEqual(["alpha/src/data/scope.ts", "alpha/src/http/responses.ts"]);
  });

  it("names the Workers types when a reached module imports them", () => {
    // The half `tsc` under `types: []` cannot refuse. `import type { D1Database } from
    // "@cloudflare/workers-types"` compiles in a browser program and is the server data layer all the
    // same — which is exactly what `@pithy-sh/secrets` was when #419 was re-checked: green, and wrong.
    const program = included("named", {
      "alpha/src/http/responses.ts": `${HEADER}export type { Db } from "../link/sender";\n`,
      "alpha/src/link/sender.ts": `${HEADER}import type { D1Database } from "@cloudflare/workers-types";\nexport type Db = D1Database;\n`,
    });
    expect(program.dependencies).toEqual(["@cloudflare/workers-types"]);
    expect(program.ours).toContain("alpha/src/link/sender.ts");
  });

  it("names them through a `.js`-suffixed specifier, which is the one that let #419 back through", () => {
    // Bundler resolution follows `../link/sender.js` to the `.ts` beside it. The old walker did not: it
    // tried two candidates, matched neither, and discarded the edge with no signal. One re-export in
    // this spelling put the whole server data layer back under a response schema at exit 0. The
    // compiler needs no candidate list, because resolving a specifier is the thing it does.
    const program = included("emitted-suffix", {
      "alpha/src/http/responses.ts": `${HEADER}export { Db as LeakDb } from "../data/leak.js";\n`,
      "alpha/src/data/leak.ts": `${HEADER}export type { Db } from "../link/sender.js";\n`,
      "alpha/src/link/sender.ts": `${HEADER}import type { D1Database } from "@cloudflare/workers-types";\nexport type Db = D1Database;\n`,
    });
    expect(program.dependencies).toEqual(["@cloudflare/workers-types"]);
    expect(program.ours).toContain("alpha/src/link/sender.ts");
  });

  it("names them through a comment carrying a semicolon, which hid a whole import statement", () => {
    // The third spelling, reproduced in `packages/` and not imagined: the specifier pattern was
    // `^\s*(?:import|export)\b[^;]*?from\s*"…"`, and `[^;]*?` means one semicolon anywhere in the
    // statement stops it matching. A comment in a multi-line import list is the ordinary way to get one,
    // and the edge was dropped with no signal — the fail-closed throw keys on specifiers the pattern
    // *found* and could not resolve, so it never fires on a statement the pattern never matched.
    const program = included("commented-import", {
      "alpha/src/http/responses.ts": `${HEADER}export { LEAK } from "../data/leak";\n`,
      "alpha/src/data/leak.ts":
        `${HEADER}import {\n  MAX, // the cap on linked purchases; 25 rows\n} from "../link/sender";\n\n` +
        "export const LEAK = MAX;\n",
      "alpha/src/link/sender.ts":
        `${HEADER}import type { D1Database } from "@cloudflare/workers-types";\n` +
        "export const MAX = 25;\nexport type Db = D1Database;\n",
    });
    expect(program.dependencies).toEqual(["@cloudflare/workers-types"]);
    expect(program.ours).toContain("alpha/src/link/sender.ts");
  });

  it("names them through a reference directive, which `types: []` has no power to refuse", () => {
    // The spelling that defeated both halves of the old gate at once. It is caught now for the same
    // reason it was dangerous: `tsc` honours the directive, and honouring it *is* putting the file in
    // the program. There is no separate detector to keep in step.
    const program = included("directive", {
      "alpha/src/http/responses.ts": `${HEADER}export { SCOPE } from "../data/leak";\n`,
      "alpha/src/data/leak.ts":
        `${HEADER}/// <reference types="@cloudflare/workers-types" />\n\n` +
        'export const SCOPE = "user";\nexport function q(d1: D1Database) {\n  return d1;\n}\n',
    });
    expect(program.dependencies).toEqual(["@cloudflare/workers-types"]);
  });

  it("does not mistake a directive inside a template literal for one the module carries", () => {
    // `@pithy-sh/vite`'s `clientEnvDeclaration.ts` writes a `vite/client` reference into the declaration
    // file it emits. That is text it produces, not ambient types it acquires. The old walk kept this
    // apart with a line anchor and got the *general* case wrong in the other direction: a scaffold
    // template literal in `cli/src/project/workerScaffold.ts` holding `import config from
    // "../pithy.config";` made 30 modules throw on an import statement that does not exist. A compiler
    // reads a template literal as one token and has never had either problem.
    const program = included("emitted-directive", {
      "alpha/src/http/responses.ts": `${HEADER}export { PREAMBLE } from "../data/emit";\n`,
      "alpha/src/data/emit.ts":
        `${HEADER}export const PREAMBLE = \`/// <reference types="@cloudflare/workers-types" />\n` +
        'import config from "../pithy.config";\n`;\n',
    });
    expect(program.dependencies).toEqual([]);
    expect(program.strangers).toEqual([]);
  });

  it("files a `.json` import where it belongs, which is not as a fault", () => {
    // `resolveJsonModule` is on in the base config, so this is a real edge the compiler follows. The old
    // resolver had no candidate for it and threw — 23 of the 53 modules it refused across `packages/`.
    // A gate that refuses legitimate code the moment its roots widen is a gate somebody switches off.
    const program = included("json", {
      "alpha/src/http/responses.ts": `${HEADER}import fixture from "../data/fixture.json";\nexport const wire = fixture;\n`,
      "alpha/src/data/fixture.json": '{ "id": "one" }\n',
    });
    expect(program.dependencies).toEqual([]);
    expect(program.strangers).toEqual([]);
    expect(program.ours).toContain("alpha/src/data/fixture.json");
  });

  it("names a subpath of the Workers types, and follows a dynamic import to it", () => {
    // Two list-shaped holes in one fixture. `link/sender.ts` reaches its optional capabilities through a
    // dynamic import; the types package has subpaths, and a detector matching only the exact string
    // would be the count-of-spellings mistake at the smallest possible scale. The package *name* is what
    // the classifier reports, so a subpath is the same answer as the root.
    const program = included("subpath", {
      "alpha/src/http/responses.ts": `${HEADER}export async function load() {\n  return import("../link/sender");\n}\n`,
      "alpha/src/link/sender.ts": `${HEADER}import type { D1Database } from "@cloudflare/workers-types/experimental";\nexport type Db = D1Database;\n`,
      "node_modules/@cloudflare/workers-types/experimental.d.ts":
        "export interface D1Database {\n  readonly d1: true;\n}\n",
    });
    expect(program.dependencies).toEqual(["@cloudflare/workers-types"]);
  });

  it("refuses a root outside the directory it was told owns the subject", () => {
    // `rootDir` is the first `ours` entry, and a `rootDir` no input is under is `TS6059` on every file in
    // the program — a compile that fails for a reason having nothing to do with the rule. Caught here
    // rather than read out of a wall of diagnostics.
    const root = write("outside", { "alpha/src/http/responses.ts": `${HEADER}export const wire = 1;\n` });
    expect(() =>
      browserProgram({ base: BASE, roots: [join(root, "alpha/src/http/responses.ts")], ours: [join(root, "beta")] }),
    ).toThrow(/is not under/);
  });
});
