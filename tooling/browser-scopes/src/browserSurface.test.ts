// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { browserProgram, projectFiles } from "./program";
import { responseModules, schemaModules, scopeHomes, specifierFor } from "./surfaces";

/**
 * What keeps this package's fixtures from being gates that cannot fail.
 *
 * The compiles in `tsconfig.client.json`, `tsconfig.responses.json` and `tsconfig.schemas.json` prove one
 * thing well: **the modules those fixtures name are compilable by a DOM-only program.** They prove
 * nothing about the ones a fixture does not name, and nothing about a reached module that spells its
 * Workers types correctly. Both holes are the shape #419 came through, so both are closed here.
 *
 * The subject is three families and one rule. **The rule, stated once: a module a browser may import
 * reaches no module that needs the Workers runtime.** The families are the scope declarations (#315),
 * the response schemas (#419) and the request schemas (#430) — everything §HTTP puts on a route line
 * that a management client has to hold in its own hands.
 *
 * Five assertions, and they do different work:
 *
 * - **Coverage.** Every module of every family appears where it must: each `src/http/responses.ts` in
 *   `responses.ts`, each `src/http/schemas.ts` in `schemas.ts`. Derived from the tree, not from a list:
 *   a capability landing tomorrow is covered by the commit that adds it. The path is the derivation
 *   because §HTTP makes it one — one response module and one request-schema module per capability, and
 *   no judgment about which files count.
 * - **The structural half.** No module of any family pulls in a package a browser build cannot have.
 *   `tsc` under `types: []` refuses whatever fails in a browser's ambient environment; this refuses what
 *   compiles fine and is the server data layer anyway — a named import of `@cloudflare/workers-types`, a
 *   reference directive, `kysely`, `kysely-d1`. Neither half is hypothetical: `@pithy-sh/secrets` failed
 *   the second while compiling green, because its wire shapes imported a *type* out of a Kysely reader.
 * - **The detector works.** `link/sender.ts` — the module #419 traveled through, and legitimately a
 *   Worker's — is asserted to be caught, **by the same function that clears the rest**. A gate that
 *   passes whether or not the thing it checks is true is worth less than no gate, because it is read as
 *   proof. That is the half proving the gate sees *this repository*; `program.test.ts` beside it proves
 *   it recognizes each shape, on fixtures, including the ones this repository does not contain.
 * - **Every program is run.** A `tsconfig.*.json` on disk that the `typecheck` script does not name is a
 *   browser program nobody compiles, which is exactly the shape of a gate that cannot fail. Both sides
 *   are read off disk.
 * - **Every source file is in a program.** One level below that: a `src/*.ts` no project's `include`
 *   reaches is compiled by nothing. Vitest transpiles a test file without typechecking it, so such a
 *   module runs, passes, and is never held to `tsc` at all — and the `include` lists here are
 *   hand-written, because this package's sources are split across a Node-typed program and four DOM-only
 *   ones and `src/**` would hand a browser fixture the ambient types a browser lacks. Derived from the
 *   tree on one side and from `tsc --listFilesOnly` on the other, so neither the list nor the walk is
 *   asked to agree with itself.
 *
 * Nothing here is derived from its own subject: the expected module sets are read off `packages/`, the
 * actual sets are read off the fixtures, and the answer about what a program contains comes from `tsc`
 * rather than from anything a fixture says about itself.
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
 * module**, so a failure names the capability that pulled the package in, and `typecheck`'s own
 * diagnostics name the file and the line for anything a browser's environment can refuse.
 *
 * ## What this is pointed at, and what it still is not (Jim, 2026-08-22)
 *
 * This section used to record the hole #430 was filed for: the scope declarations and the request
 * schemas failed the rule, and this file was pointed only at the response schemas. It is pointed at all
 * three now, and what that took is worth keeping.
 *
 * **The scope family is derived by declaration, never by path.** The obvious glob — a capability's
 * `src/http/scopes.ts` — finds four of the eight modules that were failing. `@pithy-sh/audit`,
 * `@pithy-sh/auth`, `@pithy-sh/email` and `@pithy-sh/secrets` declare their scopes in a file called
 * `guards.ts` that holds no guard, byte-identical in its import list to a `scopes.ts`. A glob would have
 * closed this issue half-way and said so nowhere. See `surfaces.ts`.
 *
 * **Ten modules failed and thirty-nine faults cleared**, measured on 2026-08-22: eight scope homes each
 * pulling `@cloudflare/workers-types`, `hono`, `kysely` and `kysely-d1` through one type-only edge into
 * `core/src/controlPlane/discovery/health.ts`, plus `leaderboard`'s and `support`'s request schemas
 * reaching their own Kysely readers — and `croner`, through a board-key regex that sat in the module
 * that validates a cron window.
 *
 * What is still not covered, and deliberately:
 *
 * - **`tsconfig.probe.json`** pulls in `@cloudflare/workers-types`, `hono`, `kysely`, `kysely-d1` and
 *   `zod`, and for that program it is the point rather than a finding. `probe.ts` imports
 *   `capability.ts` on purpose, to keep three of #315's four errors reproducible. Its subject is what a
 *   browser's `lib` refuses, which is `tsc`'s half.
 * - **`vitest.config.ts`**, which sits beside `src` rather than in it and is therefore outside the
 *   `rootDir` every project here declares. No package in this repository typechecks its own vitest
 *   config; that is a repository-wide decision and not this gate's subject. The subject is `src`.
 * - **Every other module in `packages/`.** The rule is about what a browser may import, and these three
 *   families are what §HTTP says a browser imports. A capability that hands a client some fourth kind of
 *   module has widened the surface, and widening this file is part of that change.
 *
 * A hole nobody names is a hole somebody later reads this file and assumes is covered.
 */

/**
 * The capability sources this gate derives its expectation from, and the fixtures it holds to them.
 *
 * **Each is one expression from `import.meta.url`, and that is load-bearing rather than a style.** See
 * `coverage.test.ts` for the whole argument: `.github/scripts/crossPackageReads.ts` resolves these
 * literals statically to tell CI which suites a diff must re-run, and it cannot follow a variable. It is
 * also why `surfaces.ts` takes the directory as a parameter instead of computing it — a literal that
 * leaves a `*.test.ts` file stops being found at all.
 */
const PACKAGES = fileURLToPath(new URL("../../../packages", import.meta.url));
const RESPONSES = fileURLToPath(new URL("./responses.ts", import.meta.url));
const SCHEMAS = fileURLToPath(new URL("./schemas.ts", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(PACKAGE_DIR, "src");

/**
 * The options that define "a browser's program", borrowed from one of the four that declare them.
 *
 * All four say the same two lines — `lib: ["ES2022", "DOM", "DOM.Iterable"]` and `types: []` — and the
 * last assertion in this file is what keeps them all compiled. Which one is extended here does not
 * matter; that a real one is, rather than a copy written for the sweep, does.
 */
const BASE = fileURLToPath(new URL("../tsconfig.responses.json", import.meta.url));

/** An import specifier in a fixture. Namespace imports only — see `responses.ts` for why. */
const IMPORTED_MODULE = /^import \* as [a-zA-Z]+ from "([^"]+)";$/gm;

/**
 * A TypeScript project file in this package: `tsconfig.json`, `tsconfig.client.json`, and the rest.
 *
 * **Anything at all in the middle, and that is the fix rather than laziness.** This read
 * `(\.[a-z]+)?` and so matched only a single lower-case middle segment: `tsconfig.es2022.json`,
 * `tsconfig.dom-only.json` and `tsconfig.responses.strict.json` were each a browser program on disk
 * that the assertion below reported as fine. Planted, `tsconfig.extra.json` turned it red and
 * `tsconfig.extra2.json` did not — a gate that cannot fail on a name one character away from the one it
 * catches. The names here are conventional, not constrained, so the pattern constrains only what
 * TypeScript does: a `tsconfig` prefix and a `.json` suffix.
 */
const TSCONFIG = /^tsconfig(\..+)?\.json$/;

/**
 * The packages a browser build may have, and the whole list.
 *
 * **An allowlist, deliberately.** A blocklist naming `@cloudflare/workers-types` would be the
 * count-of-spellings mistake one level up: `kysely-d1`, `wrangler` and
 * `@cloudflare/vitest-plugin` are the same fault wearing other names, and a list of them is a list
 * somebody is always one entry behind on. This fails closed. A package arriving that nobody argued for
 * turns the gate red, and the fix is one line here with a reason beside it.
 *
 * `zod` is the whole list because §HTTP makes both halves of a route contract a Zod object — a
 * management client validating what a customer's Worker answered, and bounding what it sends, needs the
 * schema at runtime, in the browser, and zod ships a browser build. **`croner` is the one that will look
 * like a missing entry.** It is genuinely browser-capable, and it was reached to validate a board-key
 * regex; the fix was to move the regex, not to widen this list. The allowlist is what a browser build may
 * have, not what it can survive.
 */
const BROWSER_SAFE: readonly string[] = ["zod"];

/**
 * What a browser program rooted at `module` pulls in that a browser build cannot have.
 *
 * One function, applied to every module that must clear it and to the one that must not. A detector
 * written separately from the rule it detects is a detector that can drift out of agreement with it.
 */
function faults(module: string): string[] {
  const program = browserProgram({ base: BASE, roots: [module], ours: [PACKAGES] });
  const name = relative(PACKAGES, module);

  // The vacuity floor, per module rather than over the set. An empty program clears every filter below,
  // and an empty program is what a broken root path, a moved tsconfig or a `tsc` that failed to launch
  // all produce. **Root membership rather than a count**, because a count is a per-family number this
  // file would have to hold: `core/src/controlPlane/scope/scope.ts` and three capabilities' request
  // schemas are one-file programs that import nothing but `zod`, and are exactly right. A program that
  // does not contain its own root did not compile its root, which is the failure the count was aimed at.
  if (!program.ours.includes(name)) return [`${name} compiled to a program of ${program.ours.length} kit files`];

  return [
    ...program.dependencies.filter((one) => !BROWSER_SAFE.includes(one)).map((one) => `${name} pulls in ${one}`),
    ...program.strangers.map((file) => `${name} pulls in ${file}, which is neither kit source nor a package`),
  ];
}

/**
 * Every TypeScript project this package declares, by file name, sorted.
 *
 * Read off the directory rather than listed, and read once: the two assertions that use it ask different
 * questions of the same set — is each project run, and is each source file in one — and a second walk is
 * a second thing to drift.
 */
function projects(): string[] {
  return readdirSync(PACKAGE_DIR)
    .filter((name) => TSCONFIG.test(name))
    .sort();
}

/** Every specifier a fixture names, sorted. */
function named(fixture: string): string[] {
  const source = readFileSync(fixture, "utf8");
  return [...source.matchAll(IMPORTED_MODULE)].map(([, specifier]) => specifier as string).sort();
}

describe("every module a browser may import is reachable from a browser program", () => {
  const responses = responseModules(PACKAGES);
  const schemas = schemaModules(PACKAGES);
  const scopes = [...scopeHomes(PACKAGES).keys()];

  it("finds the three families at all", () => {
    // The vacuity floor, set against the real population rather than against zero. Eight capabilities
    // ship admin responses, fifteen ship request schemas, and nine modules declare a control-plane
    // scope. A walk that silently stopped finding them — a rename, a `keep` predicate that stopped
    // matching — would otherwise turn every assertion below into a loop over an empty set, which passes.
    expect(responses.length).toBeGreaterThanOrEqual(8);
    expect(schemas.length).toBeGreaterThanOrEqual(15);
    expect(scopes.length).toBeGreaterThanOrEqual(9);
    for (const path of responses) expect(basename(path)).toBe("responses.ts");
    for (const path of schemas) expect(basename(path)).toBe("schemas.ts");
  });

  it("names every response module in responses.ts", () => {
    expect(named(RESPONSES)).toEqual(responses.map((path) => specifierFor(PACKAGES, path)).sort());
  });

  it("names every request-schema module in schemas.ts", () => {
    expect(named(SCHEMAS)).toEqual(schemas.map((path) => specifierFor(PACKAGES, path)).sort());
  });

  it("pulls in nothing a browser build cannot have", () => {
    // What `tsc` cannot answer on its own. The DOM-only compile catches a reached module naming a
    // Workers global off the global scope; this catches one that imports the same types by name — which
    // compiles everywhere and is server code all the same — and one that injects them with a reference
    // directive, which `types: []` has no power to refuse. Both arrive here the same way: as a file in
    // the program's own list.
    //
    // One list over all three families rather than three assertions, because the rule is one rule and a
    // failure should read as "these modules, this package" whichever family they came from.
    const every = [...new Set([...responses, ...schemas, ...scopes])].sort();
    expect(every.flatMap(faults)).toEqual([]);
  });

  it("catches a module that does need it — the detector, proven against a real one", () => {
    // `link/sender.ts` is where #419 came through and is legitimately a Worker's: it queries D1 for a
    // sender's purchases. Asserting it is *caught* is what separates "no browser module pulls in the
    // Workers runtime" from "the gate found nothing". Deliberately not a fixture — a synthetic offender
    // proves the classifier sorts a list, not that the list is this repository's.
    const sender = `${PACKAGES}${sep}support${sep}src${sep}link${sep}sender.ts`;
    expect(faults(sender)).toEqual([
      "support/src/link/sender.ts pulls in @cloudflare/workers-types",
      "support/src/link/sender.ts pulls in kysely",
      "support/src/link/sender.ts pulls in kysely-d1",
    ]);
  });

  it("compiles every browser program this package declares", () => {
    // The gate on the gates. A fixture and its `tsconfig.*.json` are half of the rule — the half `tsc`
    // owns, and the half `--listFilesOnly` deliberately skips — so a program the `typecheck` script does
    // not name is a fixture nobody ever compiles. That is not a weaker gate; it is a file that looks like
    // one. Both sides are read off disk: the projects from the directory, the invocations from the
    // manifest, so adding a fifth program is red until the script runs it.
    const declared = projects();
    expect(declared.length).toBeGreaterThanOrEqual(5);

    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      scripts: { typecheck: string };
    };
    const invoked = [...manifest.scripts.typecheck.matchAll(/tsc -p (\S+)/g)].map(([, project]) => project).sort();
    expect(invoked).toEqual(declared);
  });

  it("typechecks every source file this package ships", () => {
    // One level below the assertion above, and the hole it leaves. That one binds the `typecheck` script
    // to the projects on disk; nothing bound a project's `include` to the source on disk. So a new
    // `src/*.ts` that nobody adds to a list is compiled by no program at all — vitest transpiles a test
    // file without typechecking it, so the module runs, passes, and is never held to `tsc`.
    //
    // The lists are hand-written here for a reason, which is why the hole is real rather than a style
    // choice: `src/schemas.ts` and `src/responses.ts` belong to DOM-only programs, and a `src/**/*.ts` in
    // `tsconfig.json` would compile them a second time under `types: ["node"]` — handing a browser
    // fixture exactly the ambient types a browser does not have.
    //
    // Membership rather than the `include` lists themselves, because a module reached by an import is
    // typechecked whether or not a list names it: `program.ts` is compiled through `program.test.ts` and
    // that is correct. `tsc --listFilesOnly` is what knows the difference, and it is the same question
    // this whole package answers with the same instrument.
    const sources = readdirSync(SRC, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();

    // The vacuity floor. An empty walk — a renamed directory, a `withFileTypes` shape that changed —
    // satisfies the containment below without compiling anything.
    expect(sources.length).toBeGreaterThanOrEqual(11);

    const compiled = new Set(projects().flatMap((project) => projectFiles(join(PACKAGE_DIR, project))));
    expect(sources.filter((file) => !compiled.has(file)).map((file) => relative(PACKAGE_DIR, file))).toEqual([]);
  });
});
