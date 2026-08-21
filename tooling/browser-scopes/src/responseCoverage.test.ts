// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sourcePaths } from "@pithy-sh/cli/src/ci/sourceFiles";
import { describe, expect, it } from "vitest";
import { describeReach, reachCount, reachesWorkersRuntime } from "./reach";

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
 * - **The structural half.** No response module reaches a module that needs the Workers runtime in a way
 *   a DOM-only compile cannot see — a named import of `@cloudflare/workers-types`, or a reference
 *   directive, which `tsc` honours whatever `types: []` says. Neither is hypothetical: `@pithy-sh/secrets`
 *   failed the first while compiling green, because its wire shapes imported a *type* out of a Kysely
 *   reader, and the second is what defeated both halves of this gate at once when #419 was re-checked.
 *   `reach.ts` carries the argument for why that is one invariant rather than a list of three spellings.
 * - **The detector works.** `link/sender.ts` — the module #419 travelled through, and legitimately a
 *   Worker's — is asserted to be caught. A gate that passes whether or not the thing it checks is true
 *   is worth less than no gate, because it is read as proof. That is the half proving the walk sees *this
 *   repository*; `reach.test.ts` beside it proves the walk sees each shape, on fixtures, including the
 *   two spellings this repository does not currently contain.
 *
 * Nothing here is derived from its own subject: the expected module set is read off `packages/`, the
 * actual set is read off the fixture, and the reachability answer comes from the source tree rather
 * than from anything the fixture says about itself.
 *
 * ## What the walk is deliberately not pointed at yet, and why that is written down
 *
 * The rule is about every module a browser may import; this gate enforces it on one family. Pointed at
 * the others it fails today, and those failures are #430 rather than this commit:
 *
 * - **`src/http/scopes.ts`** — all four of them reach `core/src/capability/capability.ts` and, through
 *   it, `data/db.ts` and `kv/kv.ts`. `coverage.test.ts` holds those modules to type-only imports and
 *   they obey it; the compiler follows a type-only edge all the same. That is #315's own fix carrying
 *   #419's precondition, and unpicking it is a change to `AdminRoute`'s shape in `@pithy-sh/core`.
 * - **`src/http/schemas.ts`** — `leaderboard`'s and `support`'s reach their capability's Kysely tables.
 *   A request schema is a client's business for the same reason a response schema is, but no browser
 *   program imports one today, so it is a hazard rather than a break.
 *
 * A hole nobody names is a hole somebody later reads this file and assumes is covered.
 */

/**
 * The capability sources this gate derives its expectation from, and the fixture it holds to them.
 *
 * **Each is one expression from `import.meta.url`, and that is load-bearing rather than a style.** See
 * `coverage.test.ts` for the whole argument: `.github/scripts/crossPackageReads.ts` resolves these
 * literals statically to tell CI which suites a diff must re-run, and it cannot follow a variable.
 */
const PACKAGES = fileURLToPath(new URL("../../../packages", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./responses.ts", import.meta.url));

/** An import specifier in the fixture. Namespace imports only — see `responses.ts` for why. */
const IMPORTED_MODULE = /^import \* as [a-zA-Z]+ from "([^"]+)";$/gm;

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

  it("reaches no module that needs the Workers runtime", () => {
    // What `tsc` cannot answer. The DOM-only compile catches a reached module naming a Workers global
    // off the global scope; this catches one that imports the same types by name — which compiles
    // everywhere and is server code all the same — and one that injects them with a reference directive,
    // which `types: []` has no power to refuse.
    const offenders = modules.flatMap((path) => reachesWorkersRuntime(PACKAGES, path).map(describeReach));
    expect(offenders).toEqual([]);
  });

  it("catches a module that does need it — the detector, proven against a real one", () => {
    // `link/sender.ts` is where #419 came through and is legitimately a Worker's: it queries D1 for a
    // sender's purchases. Asserting it is *caught* is what separates "no response module reaches the
    // Workers runtime" from "the walk found nothing". Deliberately not a fixture — a synthetic offender
    // proves the regex compiles, not that it sees the repository.
    const sender = `${PACKAGES}${sep}support${sep}src${sep}link${sep}sender.ts`;
    expect(reachesWorkersRuntime(PACKAGES, sender).length).toBeGreaterThan(0);
    expect(reachCount(PACKAGES, sender)).toBeGreaterThan(1);
  });
});
