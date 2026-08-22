// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sourcePaths } from "@pithy-sh/cli/src/ci/sourceFiles";
import { describe, expect, it } from "vitest";
import { browserProgram } from "./program";

/**
 * What keeps `responses.ts` from being a gate that cannot fail.
 *
 * The compile in `tsconfig.responses.json` proves one thing well: **the response modules the fixture
 * names are compilable by a DOM-only program.** It proves nothing about the ones the fixture does not
 * name, and nothing about a reached module that spells its Workers types correctly. Both holes are the
 * shape #419 came through, so both are closed here.
 *
 * Three assertions, and they do different work:
 *
 * - **Coverage.** Every `src/http/responses.ts` the kit ships appears in the fixture. Derived from the
 *   tree, not from a list: a capability landing tomorrow is covered by the commit that adds it. The
 *   path is the derivation because §HTTP makes it one — "every admin response is a Zod object,
 *   exported from the capability's `src/http/responses.ts`" — so there is exactly one such module per
 *   capability and no judgement about which files count.
 * - **The structural half.** No response module's program pulls in a package a browser build cannot
 *   have. `tsc` under `types: []` refuses whatever fails in a browser's ambient environment; this
 *   refuses what compiles fine and is the server data layer anyway — a named import of
 *   `@cloudflare/workers-types`, a reference directive, `kysely`, `kysely-d1`. Neither half is
 *   hypothetical: `@pithy-sh/secrets` failed the second while compiling green, because its wire shapes
 *   imported a *type* out of a Kysely reader.
 * - **The detector works.** `link/sender.ts` — the module #419 travelled through, and legitimately a
 *   Worker's — is asserted to be caught, **by the same function that clears the eight above**. A gate
 *   that passes whether or not the thing it checks is true is worth less than no gate, because it is
 *   read as proof. That is the half proving the gate sees *this repository*; `program.test.ts` beside it
 *   proves it recognises each shape, on fixtures, including the ones this repository does not contain.
 *
 * Nothing here is derived from its own subject: the expected module set is read off `packages/`, the
 * actual set is read off the fixture, and the answer about what a program contains comes from `tsc`
 * rather than from anything the fixture says about itself.
 *
 * ## The structural half is the compiler's answer now, not a walk's (Jim, 2026-08-21)
 *
 * This bullet used to read *"no response module reaches a module that needs the Workers runtime in a way
 * a DOM-only compile cannot see"*, and it was answered by `reach.ts`, a walk over the import graph
 * driven by a regex over source text. The claim was right and the instrument was not: the regex was
 * wrong three times in two rounds, and it threw on 53 of 1,912 modules in the tree for reasons that were
 * not faults at all. `program.ts` carries that argument in full. What changed here is only who answers:
 * `tsc --listFiles` reports which files the program included, and every spelling the walk chased is one
 * entry in that list.
 *
 * One thing was given up with it. The walk printed a trail — `responses.ts -> sender.ts -> tables.ts` —
 * and a file list prints none. What stands in its place is per-capability attribution: **one program per
 * response module**, so a failure names the capability that pulled the package in, and `typecheck`'s own
 * diagnostics name the file and the line for anything a browser's environment can refuse. Eight `tsc`
 * runs, about half a second in total.
 *
 * ## What the gate is deliberately not pointed at yet, and why that is written down
 *
 * The rule is about every module a browser may import; this gate enforces it on one family. Pointed at
 * the others it fails today, and those failures are #430 rather than this commit. **Measured, not
 * assumed** — these are the packages each of this package's other two programs pulls in, from
 * `tsc --listFiles` on 2026-08-21:
 *
 * - **`tsconfig.client.json`** — `@cloudflare/workers-types`, `hono`, `kysely`, `kysely-d1`, `zod`. The
 *   four `src/http/scopes.ts` modules reach `core/src/capability/capability.ts` and, through it,
 *   `data/db.ts` and `kv/kv.ts`. `coverage.test.ts` holds those modules to type-only imports and they
 *   obey it; the compiler follows a type-only edge all the same. That is #315's own fix carrying #419's
 *   precondition, and unpicking it is a change to `AdminRoute`'s shape in `@pithy-sh/core`.
 * - **`tsconfig.probe.json`** — the same five, and for that program it is the point rather than a
 *   finding. `probe.ts` imports `capability.ts` on purpose, to keep three of #315's four errors
 *   reproducible. Its subject is what a browser's `lib` refuses, which is `tsc`'s half.
 * - **`src/http/schemas.ts`** — `leaderboard`'s and `support`'s reach their capability's Kysely tables.
 *   A request schema is a client's business for the same reason a response schema is, but no browser
 *   program imports one today, so it is a hazard rather than a break.
 *
 * A hole nobody names is a hole somebody later reads this file and assumes is covered.
 */

/**
 * The capability sources this gate derives its expectation from, and the fixtures it holds to them.
 *
 * **Each is one expression from `import.meta.url`, and that is load-bearing rather than a style.** See
 * `coverage.test.ts` for the whole argument: `.github/scripts/crossPackageReads.ts` resolves these
 * literals statically to tell CI which suites a diff must re-run, and it cannot follow a variable.
 */
const PACKAGES = fileURLToPath(new URL("../../../packages", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./responses.ts", import.meta.url));
const BASE = fileURLToPath(new URL("../tsconfig.responses.json", import.meta.url));

/** An import specifier in the fixture. Namespace imports only — see `responses.ts` for why. */
const IMPORTED_MODULE = /^import \* as [a-zA-Z]+ from "([^"]+)";$/gm;

/**
 * The packages a browser build may have, and the whole list.
 *
 * **An allowlist, deliberately.** A blocklist naming `@cloudflare/workers-types` would be the
 * count-of-spellings mistake one level up: `kysely-d1`, `wrangler` and
 * `@cloudflare/vitest-plugin` are the same fault wearing other names, and a list of them is a list
 * somebody is always one entry behind on. This fails closed. A package arriving that nobody argued for
 * turns the gate red, and the fix is one line here with a reason beside it.
 *
 * `zod` is the whole list because §HTTP makes a response a Zod object — a management client validating
 * what a customer's Worker answered needs the schema at runtime, in the browser, and zod ships a browser
 * build. Nothing else has ever been reached from these eight modules.
 */
const BROWSER_SAFE: readonly string[] = ["zod"];

/** `packages/<name>/src/http/responses.ts` → `@pithy-sh/<name>/src/http/responses`. */
function specifierFor(path: string): string {
  const [pkg, ...rest] = relative(PACKAGES, path).split(sep);
  return `@pithy-sh/${pkg}/${rest.join("/").replace(/\.ts$/, "")}`;
}

/** Every response-schema module the kit ships, by the one path §HTTP gives them. */
function responseModules(): string[] {
  return sourcePaths(PACKAGES, { keep: (name) => name === "responses.ts" }).filter((path) =>
    dirname(path).endsWith(`${sep}src${sep}http`),
  );
}

/**
 * What a browser program rooted at `module` pulls in that a browser build cannot have.
 *
 * One function, applied to the eight that must clear it and to the one that must not. A detector written
 * separately from the rule it detects is a detector that can drift out of agreement with it.
 */
function faults(module: string): string[] {
  const program = browserProgram({ base: BASE, roots: [module], ours: [PACKAGES] });
  const name = relative(PACKAGES, module);

  // The vacuity floor, per module rather than over the set. An empty program clears every filter below,
  // and an empty program is what a broken root path, a moved tsconfig or a `tsc` that failed to launch
  // all produce. Every response module imports zod and at least one sibling, so two is the floor.
  if (program.ours.length < 2) return [`${name} compiled to a program of ${program.ours.length} kit files`];

  return [
    ...program.dependencies.filter((one) => !BROWSER_SAFE.includes(one)).map((one) => `${name} pulls in ${one}`),
    ...program.strangers.map((file) => `${name} pulls in ${file}, which is neither kit source nor a package`),
  ];
}

describe("every response schema is reachable from a browser program", () => {
  const modules = responseModules();

  it("finds the response modules at all", () => {
    // The vacuity floor, set against the real population rather than against zero. Eight capabilities
    // ship admin responses today. A walk that silently stopped finding them — a rename, a `keep`
    // predicate that stopped matching — would otherwise turn every assertion below into a loop over an
    // empty set, which passes.
    expect(modules.length).toBeGreaterThanOrEqual(8);
    for (const path of modules) expect(basename(path)).toBe("responses.ts");
  });

  it("names every one of them in responses.ts", () => {
    const source = readFileSync(FIXTURE, "utf8");
    const imported = [...source.matchAll(IMPORTED_MODULE)].map(([, specifier]) => specifier as string);
    expect(imported.sort()).toEqual(modules.map(specifierFor).sort());
  });

  it("pulls in nothing a browser build cannot have", () => {
    // What `tsc` cannot answer on its own. The DOM-only compile catches a reached module naming a
    // Workers global off the global scope; this catches one that imports the same types by name — which
    // compiles everywhere and is server code all the same — and one that injects them with a reference
    // directive, which `types: []` has no power to refuse. Both arrive here the same way: as a file in
    // the program's own list.
    expect(modules.flatMap(faults)).toEqual([]);
  });

  it("catches a module that does need it — the detector, proven against a real one", () => {
    // `link/sender.ts` is where #419 came through and is legitimately a Worker's: it queries D1 for a
    // sender's purchases. Asserting it is *caught* is what separates "no response module pulls in the
    // Workers runtime" from "the gate found nothing". Deliberately not a fixture — a synthetic offender
    // proves the classifier sorts a list, not that the list is this repository's.
    const sender = `${PACKAGES}${sep}support${sep}src${sep}link${sep}sender.ts`;
    expect(faults(sender)).toEqual([
      "support/src/link/sender.ts pulls in @cloudflare/workers-types",
      "support/src/link/sender.ts pulls in kysely",
      "support/src/link/sender.ts pulls in kysely-d1",
    ]);
  });
});
