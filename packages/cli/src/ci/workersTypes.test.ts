// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { isShippedSource, readSource, sourcePaths } from "./sourceFiles";

/**
 * **A package that imports `@cloudflare/workers-types` by name from shipped source declares it as a
 * `dependency`.**
 *
 * #315 settled this for `@pithy-sh/core`, and `tooling/browser-scopes/src/probe.ts:28-30` wrote the
 * argument down in two halves: "Importing them by name is what makes the dependency real, and
 * `@pithy-sh/core` declaring `@cloudflare/workers-types` as a dependency rather than a devDependency is
 * what makes it satisfiable." Fourteen other packages had the first half and not the second (#431).
 *
 * **Nothing in this tree could notice.** Bun hoists the workspace and the root `package.json` `overrides`
 * pins one copy for every member, so a sibling's devDependency resolves for every program here. The
 * consumer is where it fails, and the consumer is not us: no package publishes `dist`, every one declares
 * `"exports": { "./src/*": "./src/*.ts" }`, so an adopter installing `@pithy-sh/auth` type-checks *our*
 * `src/data/tables.ts` inside *their* program. A devDependency is not installed for them. `docs/STACK.md`
 * (§ Capability packages) has said `bun add zod @cloudflare/workers-types` — `bun add`, not `bun add -d` —
 * the whole time; the manifests drifted from it one copied sibling at a time, which is why this is a gate
 * and not a review note.
 *
 * ## Scoped to one package, on purpose
 *
 * The shape of the real rule is broader: **every bare specifier a shipped source imports is a declared
 * dependency of the package that ships it.** `packages/core/src/worker-safety.test.ts` already asserts it
 * for core, against a frozen `ALLOWED_SPECIFIERS`. It is not asserted repository-wide yet, because the
 * same sweep that measures this issue also finds `zod` imported from twenty-five shipped `packages/cli`
 * modules, and `vitest` and `miniflare` reached from `src/test-utils/*.ts` files that ship because nobody
 * excluded them. Promoting a test framework to a runtime dependency of the CLI would be the wrong fix; the
 * right one is probably to stop publishing those files, and that is a decision with its own blast radius.
 * A gate carrying an exception list of decisions nobody has made is the rot `turboInputs.test.ts` refuses.
 * So this file claims exactly what it checks, and the name says the same.
 *
 * ## The ambient form, and why it is measured rather than described
 *
 * An import-by-name scan is blind to the other half of the same defect — a source naming `D1Database` off
 * the global scope, resolving through its own `tsconfig.json` `types`, importing nothing. The adopter
 * breaks identically: they compile our `src` and get `Cannot find name`. This gate reads every one of
 * those packages as a clean devDependency-only package.
 *
 * A sentence naming the exception is not enough, and this file proves it: the first one named
 * `packages/cloudflare` as the survivor and cleared `packages/audit` and `packages/rating`, and all three
 * put a global `D1Database` in an exported signature. So the blind spot is swept instead —
 * {@link AMBIENT} is the measured set, deep-compared.
 *
 * **The sweep reads every workspace member, and that is the whole of its worth.** Its first draft read the
 * two in {@link DECLARED_ONLY}, which is 2 of 25, and reported `{}` as though the tree were clean. It was
 * not: thirteen shipped files in `auth`, `cli`, `core`, `email` and `matchmaking` named a Workers global
 * with no import, `packages/matchmaking/src/data/tables.ts` byte-for-byte the shape `packages/rating` had
 * just been fixed out of. A gate whose population is a subset of the rule's is worse than none, because
 * its green is read as the rule holding. All thirteen are fixed here rather than recorded, so
 * {@link AMBIENT} is empty and the sweep is what keeps it that way. Empty is the assertion, not the
 * absence of one.
 */

/** `packages/cli/src/ci` → the repository. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** The package under the gate. One specifier — see the header for why the general rule is not asserted. */
const WORKERS_TYPES = "@cloudflare/workers-types";

/**
 * The one range every declaration states. **A frozen literal.**
 *
 * The declarations are ambient global types. Two versions resolved side by side in one adopter's program
 * produce duplicate-identifier errors, and one identical caret range across every package is what lets any
 * package manager dedupe to a single copy. Promotion makes that matter more, not less: fourteen packages
 * that were invisible to an adopter's resolver now participate in it.
 */
const RANGE = "^5.20260729.1";

/** The dependency sections a manifest can declare a package in. `overrides` is not one — it is a pin. */
const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/** The workspace globs from the root `package.json`, minus their `/*`. */
const WORKSPACE_GROUPS = ["packages", "tooling", "apps"];

/**
 * Every package that declares the Workers types and imports them from no shipped source. **A frozen
 * literal, asserted in both directions.**
 *
 * Without it, promoting all twenty declarations "to be safe" would pass the gate above — and the two
 * below would each be a runtime dependency nothing needs.
 *
 * **A reason here is why the package imports nothing, never that it reaches the globals some other way.**
 * Saying that distinguishes nothing — every package here could say it, and three of these entries once
 * did, as though it were an all-clear. Whether *any* package's shipped source names a Workers global is
 * measured, in {@link AMBIENT}, over the whole workspace, so no entry below has to claim it.
 *
 * Each key is a package directory, relative to the repository root. Each value is why.
 */
const DECLARED_ONLY: Record<string, string> = {
  "packages/turnstile":
    "Genuinely nothing: its verifier is a `fetch` to Cloudflare's siteverify endpoint, and the `Response` it reads is a global every Node program already has. Clean in {@link AMBIENT} too, so a devDependency is what it is.",
  "tooling/vite-adopter":
    "Not a published capability at all — the fixture that compiles an adopter's `pithy()` call against pinned Vite copies. Its Workers types are a compiler input.",
};

/**
 * Every package that imports the Workers types from shipped source, and how many of its files do.
 *
 * **A frozen literal, and near-exact rather than a floor.** A sweep over a population asserts what the
 * population is (`sweepPopulation.test.ts`), and its shape #8 — an anti-vacuity guard far below the real
 * population — is what a `toBeGreaterThan(3)` here would be. A scan that came back with three packages
 * would be reporting on a tree other than this one, and every assertion below it would be worthless.
 *
 * Measured 2026-08-22. A file added or removed moves a count, which is the point: the number is a second
 * reader of the same change.
 */
const IMPORTERS: Record<string, number> = {
  "packages/audit": 2,
  "packages/auth": 3,
  "packages/cli": 10,
  "packages/cloudflare": 2,
  "packages/core": 12,
  "packages/email": 8,
  "packages/leaderboard": 5,
  "packages/ledger": 4,
  "packages/matchmaking": 8,
  "packages/media": 7,
  "packages/multiplayer": 5,
  "packages/payments": 14,
  "packages/rating": 2,
  "packages/secrets": 4,
  "packages/storage": 6,
  "packages/support": 8,
  "packages/testers": 7,
  "packages/vector": 3,
};

/**
 * Which workspace members name a Workers global off the global scope from shipped source, and which
 * names. **A frozen literal, deep-compared — measured over every member, never asserted in prose.**
 *
 * This is the half of the record a sentence kept getting wrong. `packages/cloudflare` was written down as
 * the one surviving instance and `packages/audit` and `packages/rating` as clean, and all three named
 * `D1Database` in an exported signature. A reader who trusted the entries learned the opposite of the
 * tree. That is not a slip a longer sentence fixes: an entry saying a package reaches the globals through
 * its own `tsconfig.json` was true of every package here, so it read as an all-clear while carrying no
 * claim at all.
 *
 * **It is empty, and that is a finding rather than a default.** Nineteen files across eight packages were
 * fixed in the change that measured them — the names are imported, and the packages are declared like
 * every other importer. What stays behind is the sweep. A package that stops importing a name it still
 * uses lands back here and fails, which is the only reason emptiness is worth asserting.
 *
 * The measurement is also self-widening, and it proved that twice. `D1Result` was reached off the global
 * scope in two `packages/cloudflare` files and this record missed it, because {@link vocabulary} can only
 * look for names the tree imports somewhere and the sole named import of `D1Result` was in a `.test.ts`,
 * which is not shipped source. Importing it in `d1Manager.ts` put it in the vocabulary, and the next sweep
 * found the second file immediately. Then widening the population from two packages to all twenty-five
 * found thirteen more files with nothing else changed.
 *
 * Files, not lines. A line number is stale the next time anything above it moves, and a record that has
 * gone stale in a way nobody notices is what this exists to stop.
 */
const AMBIENT: Record<string, Record<string, readonly string[]>> = {};

/** Comments stripped, so a module that *discusses* a specifier is not reported for the sentence. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

/**
 * Every module specifier a source imports or re-exports, static and dynamic alike.
 *
 * Ported from `packages/core/src/worker-safety.test.ts`, deliberately rather than shared: `@pithy-sh/core`
 * cannot import from `@pithy-sh/cli` (the graph runs the other way), and a test file is not an export. Two
 * copies of thirty lines is the cheaper of the two wrongs, and the sample below pins this one on its own.
 *
 * Statement-shaped rather than a loose search for `from "…"`. This repository's docblocks are long and
 * quote sentences, and `export type Environment = "dev" | "prod";` is a line starting with `export` and
 * ending in a quoted string. A naive scan over `packages/payments` returned "our Stripe account is wrong"
 * and "we never looked" as module specifiers. So a statement starts at column 0 (Biome formats every
 * import that way), runs to its semicolon, and only its *trailing* specifier counts.
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

/** `path` under the repository root, in posix separators — how a failure names a file to edit. */
function named(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

/** One manifest in the tree, parsed. */
interface Manifest {
  /** Its directory, relative to the repository root, in posix separators: `packages/auth`. */
  readonly directory: string;
  /** Whether it is a workspace member — `<group>/<name>`, for one of {@link WORKSPACE_GROUPS}. */
  readonly member: boolean;
  /** What it parsed to. A manifest that will not parse is a failure the assertions below report. */
  readonly json: Record<string, unknown>;
}

/**
 * Every `package.json` in this repository's own source, parsed.
 *
 * One walk, `./sourceFiles` — the only permitted traversal here, and `sourceFiles.test.ts` fails the build
 * on a module that writes its own. It already skips `node_modules`, `dist` and the vendored
 * `packages/cli/templates` copy, which is every place a second manifest could be read as a first one.
 */
const MANIFESTS: Manifest[] = sourcePaths(REPO_ROOT, { keep: (name) => name === "package.json" }).map((path) => {
  const segments = named(path).split("/");
  const directory = segments.slice(0, -1).join("/");
  return {
    directory: directory === "" ? "." : directory,
    member: segments.length === 3 && WORKSPACE_GROUPS.includes(segments[0] as string),
    json: JSON.parse(readSource(path) ?? "{}") as Record<string, unknown>,
  };
});

/** Which sections of `manifest` declare `WORKERS_TYPES`, and at what range. */
function declarations(manifest: Manifest): Array<{ section: string; range: unknown }> {
  const found: Array<{ section: string; range: unknown }> = [];
  for (const section of SECTIONS) {
    const entries = manifest.json[section] as Record<string, unknown> | undefined;
    if (entries !== undefined && WORKERS_TYPES in entries) found.push({ section, range: entries[WORKERS_TYPES] });
  }
  return found;
}

/** The shipped sources under `<directory>/src` that import `WORKERS_TYPES`, relative to the root. */
function importers(directory: string): string[] {
  const found: string[] = [];
  for (const path of sourcePaths(resolve(REPO_ROOT, directory, "src"), { keep: isShippedSource })) {
    const text = readSource(path);
    if (text !== null && specifiers(text).includes(WORKERS_TYPES)) found.push(named(path));
  }
  return found;
}

/**
 * Every name this repository reaches for in the Workers types, from both directions.
 *
 * The derived half is every binding some shipped source imports by name from `WORKERS_TYPES`, anywhere in
 * the tree. It grows on its own, which is what makes the scan below more than a spot check.
 *
 * The cited half is every name {@link AMBIENT} claims as evidence, and it is empty today because the
 * record is. It is kept because derivation alone has a floor: a name no shipped source imports anywhere
 * is in no import list to be read off, so a package reaching it ambiently is invisible. `D1Meta` was
 * exactly that until this change imported it, and `D1Result` was found only once a sibling file's import
 * put it in reach. A future entry citing a name nothing imports widens the vocabulary the same way, and
 * folding the citations in is not circular: the record states where it looked, and the scan then has to
 * find each cited name still there.
 *
 * Both halves are then filtered by {@link platformGlobal} — see there for why.
 */
function vocabulary(): string[] {
  return workersNames().filter((name) => !platformGlobal(name));
}

/** The unfiltered derivation: every name reached for, platform globals and Workers-only names alike. */
function workersNames(): string[] {
  const names = new Set<string>(Object.values(AMBIENT).flatMap((files) => Object.values(files).flat()));
  for (const path of sourcePaths(REPO_ROOT, { keep: isShippedSource })) {
    const text = readSource(path);
    if (text === null) continue;
    for (const name of exportedNames(code(text), WORKERS_TYPES)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Whether `name` is a global of the JavaScript platform itself, rather than one Workers adds.
 *
 * `@cloudflare/workers-types` re-declares a good deal of the web platform, so a name entering the
 * vocabulary is not by itself evidence that it entered *from* Workers. `ReadableStream` did exactly that:
 * `packages/storage/src/object/store.ts` imports it by name, so the derivation picked it up, and the sweep
 * then read `packages/core/src/createEntrypoint.ts` naming a bare `ReadableStream<Uint8Array>` as the same
 * defect. It is not. That file casts `Response.body`, which is the platform's stream in Node, Deno,
 * workerd and a browser alike — `packages/storage/src/http/serve.ts` says so out loud, writing
 * `globalThis.ReadableStream` where it needs the platform one beside the imported one. **An adopter
 * compiling our source resolves that name whatever their `types` says. It is not the ambient defect, and
 * reporting it would push a pointless import into a file to buy a green.**
 *
 * So the rule is: **a name the host already declares is excluded, and the host is asked rather than
 * listed.** `name in globalThis` is measured, in this Node process, against the same floor every published
 * package states (`engines.node` >= 22) — so it cannot go stale the way a frozen list of DOM names would,
 * and it costs no second record to keep true. This is a node-environment test for that reason; run under
 * `@cloudflare/vitest-plugin` it would be asking workerd what workerd adds, which is the opposite question.
 *
 * The one shape it cannot see is a **type-only** platform name — `ResponseInit` is declared by every host
 * and is a value in none, so it would survive the filter and land in {@link AMBIENT}. That fails loudly
 * rather than silently, which is the right way round: the sweep reports the file, and whoever reads it
 * decides. Nothing in the vocabulary is that shape today.
 */
function platformGlobal(name: string): boolean {
  return name in globalThis;
}

/**
 * Every import clause in `source` — the text between `import` and its `from "…"` — for `from`, or for any
 * specifier when `from` is undefined.
 *
 * `export … from` is deliberately not matched: it re-exports, it binds nothing locally, and the two
 * readers below both ask about bindings.
 */
function importClauses(source: string, from?: string): string[] {
  const specifier = from === undefined ? "[^\"']+" : from;
  const pattern = new RegExp(`(?:^|\\n)import\\s+([^"';]*?)\\s*from\\s*["']${specifier}["']`, "g");
  return [...source.matchAll(pattern)].map((match) => match[1] as string);
}

/** One import clause, split into what it takes from the module and what it binds in the file. */
interface Clause {
  /** The names as the module exports them — `default` for a default import, nothing for a namespace. */
  readonly exported: string[];
  /** The identifiers bound here: the alias where there is one, the default's name, the namespace object. */
  readonly bound: string[];
}

/**
 * A clause, both ways. **The two questions are different and one answer used to serve both.**
 *
 * {@link vocabulary} asks which of the module's names this tree reaches, so `{ D1Database as DB }` counts
 * as `D1Database` — the exported name is what resolves. {@link ambient} asks which identifiers a file has
 * already bound, so the same clause counts as `DB`: reading it as `D1Database` made the scan believe an
 * aliased import was an unresolved global, and report a file that is correct. Default and namespace
 * imports were captured in neither direction.
 */
function parseClause(clause: string): Clause {
  const exported: string[] = [];
  const bound: string[] = [];
  for (const binding of (/\{([^}]*)\}/.exec(clause)?.[1] ?? "").split(",")) {
    const text = binding.replace(/^\s*type\s+/, "").trim();
    if (text === "") continue;
    const [name, alias] = text.split(/\s+as\s+/).map((part) => part.trim());
    exported.push(name as string);
    bound.push((alias ?? name) as string);
  }
  // Whatever sits outside the braces: `Default`, `* as ns`, or the `Default,` ahead of them.
  for (const part of clause.replace(/\{[^}]*\}/, "").split(",")) {
    const text = part.replace(/^\s*type\s+/, "").trim();
    if (text === "") continue;
    const namespace = /^\*\s+as\s+(.+)$/.exec(text);
    if (namespace !== null) {
      bound.push((namespace[1] as string).trim());
      continue;
    }
    exported.push("default");
    bound.push(text);
  }
  return { exported, bound };
}

/** The names `source` imports from `from`, as `from` exports them. */
function exportedNames(source: string, from: string): string[] {
  return importClauses(source, from).flatMap((clause) => parseClause(clause).exported);
}

/** Every identifier `source`'s imports bind — from any module, under whatever name the file uses. */
function boundNames(source: string): string[] {
  return importClauses(source).flatMap((clause) => parseClause(clause).bound);
}

/**
 * The shipped sources under `<directory>/src` that name one of `names` without binding it, and which.
 *
 * A name the file imports from anywhere is resolved by that import, not by the compiler's `types` entry,
 * so it is not the defect. Everything left resolves off the global scope or not at all.
 *
 * A qualified use is not a bare name: `ns.D1Database` is resolved by whatever bound `ns`, and `this.d1Result`
 * is not the type at all. So the match refuses a preceding `.`, along with the identifier characters `\b`
 * alone would already have refused on the other side.
 */
function ambient(directory: string, names: readonly string[]): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const path of sourcePaths(resolve(REPO_ROOT, directory, "src"), { keep: isShippedSource })) {
    const text = readSource(path);
    if (text === null) continue;
    const stripped = code(text);
    const bound = new Set(boundNames(stripped));
    const used = names.filter((name) => !bound.has(name) && new RegExp(`(?<![.\\w$])${name}\\b`).test(stripped));
    if (used.length > 0) found[named(path)] = used;
  }
  return found;
}

/** Every workspace member, with what it declares and what it imports. */
const MEMBERS = MANIFESTS.filter((manifest) => manifest.member).map((manifest) => ({
  directory: manifest.directory,
  name: (manifest.json.name as string | undefined) ?? manifest.directory,
  sections: declarations(manifest).map(({ section }) => section),
  importers: importers(manifest.directory),
}));

/**
 * Whether `version` satisfies a caret range — same major, and no older within it.
 *
 * Hand-rolled because this module has one job and `semver` is not a dependency of this package. A caret
 * over a `5.x` line is the only shape in play, and the sample test below pins what it answers.
 */
function satisfiesCaret(version: string, range: string): boolean {
  const parts = (value: string) => value.replace(/^\^/, "").split(".").map(Number);
  const [major, minor, patch] = parts(version);
  const [floorMajor, floorMinor, floorPatch] = parts(range);
  if ([major, minor, patch, floorMajor, floorMinor, floorPatch].some((part) => !Number.isInteger(part))) return false;
  if (major !== floorMajor) return false;
  if ((minor as number) !== (floorMinor as number)) return (minor as number) > (floorMinor as number);
  return (patch as number) >= (floorPatch as number);
}

describe("the Workers types are declared the way they are used", () => {
  test("this is the set of packages that import them from shipped source", () => {
    // The anti-vacuity guard. Every assertion below sweeps the same population, so a walk that came back
    // empty — a moved `src`, a `keep` that matches nothing — would make the whole file green over nothing.
    const found = Object.fromEntries(
      MEMBERS.filter((member) => member.importers.length > 0).map((member) => [
        member.directory,
        member.importers.length,
      ]),
    );
    expect(found).toEqual(IMPORTERS);
    // And it is *this* tree, not some other one that happens to have TypeScript in it.
    const everyImporter = MEMBERS.flatMap((member) => member.importers);
    expect(everyImporter).toContain("packages/core/src/kv/kv.ts");
    expect(everyImporter).toContain("packages/payments/src/data/tables.ts");
  });

  test("every package that imports them declares them as a dependency", () => {
    const offenders = MEMBERS.filter((member) => member.importers.length > 0)
      .filter((member) => !member.sections.includes("dependencies") && !member.sections.includes("peerDependencies"))
      .map(
        (member) => `${member.name} (${member.directory}) declares it in ${member.sections.join(", ") || "nothing"}`,
      );
    expect(
      offenders,
      `Every package here ships raw \`src/*.ts\`, so an adopter compiles our source in their program — where a devDependency of ours is not installed. \`tooling/browser-scopes/src/probe.ts\` states it: importing a package by name is what makes the dependency real, and declaring it as a dependency rather than a devDependency is what makes it satisfiable. Move the entry to \`dependencies\`, keep the range \`${RANGE}\`, and run \`bun install\`:\n${offenders.map((line) => `  ${line}`).join("\n")}`,
    ).toEqual([]);
  });

  test("these and only these declare them without importing them, and they stay devDependencies", () => {
    const declaredOnly = MEMBERS.filter((member) => member.sections.length > 0 && member.importers.length === 0);
    const directories = declaredOnly.map((member) => member.directory);
    expect(
      directories.filter((directory) => !(directory in DECLARED_ONLY)),
      "these declare the Workers types and import them from nothing shipped — say why, in DECLARED_ONLY, or drop the declaration",
    ).toEqual([]);
    expect(
      Object.keys(DECLARED_ONLY).filter((directory) => !directories.includes(directory)),
      "written down as declaring without importing, and no longer doing one or the other — the entry says nothing true",
    ).toEqual([]);
    // The other half, and the one that makes the record load-bearing rather than decorative: promoting
    // all twenty declarations "to be safe" satisfies the gate above and puts a several-megabyte pile of
    // `.d.ts` into two adopters' installs for nothing. A package that imports nothing declares nothing
    // at runtime.
    expect(
      declaredOnly.filter((member) => member.sections.includes("dependencies")).map((member) => member.directory),
      "these import the Workers types from no shipped source, so a runtime dependency is a payload an adopter installs and never resolves — move it back to devDependencies",
    ).toEqual([]);
  });

  test("the record says which member reaches the globals ambiently, and where", () => {
    const names = vocabulary();
    // The anti-vacuity guard again, and it needs both halves: a vocabulary that came back empty, or one
    // that lost the name only the record cites, would report every package clean.
    expect(names).toContain("D1Database");
    expect(names).toContain("D1Meta");
    // And the exclusion is live rather than merely written down: the derivation reaches `ReadableStream`,
    // because `packages/storage` imports it by name, and `platformGlobal` takes it back out again.
    expect(workersNames()).toContain("ReadableStream");
    expect(names).not.toContain("ReadableStream");

    // Every member, not the two that declare without importing. Reading a subset here is what let
    // thirteen files sit under a green gate (#431); see the header.
    const found: Record<string, Record<string, string[]>> = {};
    for (const member of MEMBERS) {
      const sites = ambient(member.directory, names);
      if (Object.keys(sites).length > 0) found[member.directory] = sites;
    }
    expect(
      found,
      "AMBIENT and the tree disagree. Every file here names a Workers global and imports nothing, so the gate above reads its package as clean and an adopter's compiler does not — import the names, which is what #431 did to the nineteen this record used to hold, or correct AMBIENT and say why the file is an exception",
    ).toEqual(AMBIENT);
  });

  test("every declaration in the workspace states one range", () => {
    const stated = MANIFESTS.flatMap((manifest) =>
      declarations(manifest).map(({ section, range }) => ({
        where: `${manifest.directory}/package.json (${section})`,
        range,
      })),
    );
    // `workerScaffold.ts` writes an adopter's first Worker manifest and is the copy nobody re-reads —
    // the same argument `compatibilityDates.test.ts` makes about the same file, and the same drift
    // `.changeset/138-worker-add-installs.md` records.
    const scaffold = "packages/cli/src/project/workerScaffold.ts";
    const scaffolder = readSource(resolve(REPO_ROOT, scaffold));
    // A moved file and a rewritten one both used to arrive as `range: undefined` in the list below, which
    // failed as "these state a different range" — a report about drift, for a regression that is the gate
    // going blind. The two things that can actually have happened are named where they happen.
    expect(
      scaffolder,
      `${scaffold} is not there. It is the manifest \`pithy init\` writes an adopter's first Worker from, and this gate reads its range out of the file by path — follow the file and fix the path, or the range \`pithy init\` ships stops being checked at all`,
    ).not.toBeNull();
    const literal = new RegExp(`"${WORKERS_TYPES}":\\s*"([^"]+)"`).exec(scaffolder ?? "")?.[1];
    expect(
      literal,
      `${scaffold} no longer writes a "${WORKERS_TYPES}" entry. Either the scaffolded Worker stopped declaring the types — say so here and drop this check — or the declaration moved, and this gate is now reading a file that no longer holds it`,
    ).toBeDefined();
    stated.push({ where: scaffold, range: literal });

    // Twenty workspace manifests, the starter Worker `pithy init` copies, and the scaffolder literal.
    // Pinned rather than floored: a walk that read nothing would satisfy any floor, and a declaration
    // landing or leaving is a change whose author should confirm the number rather than inherit it.
    expect(stated.length, "the set of declarations moved — count them, then say so here").toBe(22);
    expect(
      stated.filter((entry) => entry.range !== RANGE),
      "these state a different range. Two versions of an ambient global type in one adopter's program are duplicate-identifier errors, so all of them dedupe to one copy or none of them do",
    ).toEqual([]);

    // And the root pin, which is what the whole workspace actually resolves to. It is a concrete version
    // rather than a range, and it has to sit inside the range every package publishes — otherwise this
    // tree type-checks against a copy no adopter would ever install. See the `"//"` block beside it.
    const root = MANIFESTS.find((manifest) => manifest.directory === ".");
    const pin = (root?.json.overrides as Record<string, unknown> | undefined)?.[WORKERS_TYPES];
    expect(
      typeof pin === "string" && satisfiesCaret(pin, RANGE),
      `the root override ${String(pin)} is outside ${RANGE}`,
    ).toBe(true);
  });

  test("the scan reads imports, and it reads every spelling of one", () => {
    // The gate over the gate. `specifiers` is the whole check, so a form it cannot see is a package this
    // file reports as clean. Each line here is a real import shape; each must be extracted, and the prose
    // — which is what a naive `from "…"` scan returned from this repository's docblocks — must not be.
    const sample = [
      'import type { D1Database } from "@cloudflare/workers-types";',
      "import type {",
      "  R2Bucket,",
      "  R2Object,",
      '} from "@cloudflare/workers-types";',
      'import "side-effect-module";',
      'export { thing } from "./local";',
      'export type Environment = "dev" | "prod";',
      'const dyn = await import("node:path");',
      '// import { lie } from "commented-out";',
      "/**",
      " * Every reconciliation we ran came back saying our Stripe account is wrong, and we never looked.",
      " */",
      "export function describe(): string {",
      '  return "nothing here is an import";',
      "}",
    ].join("\n");
    expect(specifiers(sample)).toEqual([
      "@cloudflare/workers-types",
      "@cloudflare/workers-types",
      "side-effect-module",
      "./local",
      "node:path",
    ]);
  });

  test("an import is read one way for the vocabulary and the other way for the sweep", () => {
    // The gate over the other gate. `ambient` treats a bound identifier as resolved, so a form the parser
    // cannot bind is a file this sweep reports as broken when it is correct — and the alias form did
    // exactly that until it was split from the vocabulary's question (#431).
    const sample = [
      'import type { D1Database as DB, KVNamespace } from "@cloudflare/workers-types";',
      'import { Miniflare } from "miniflare";',
      'import defaultExport from "./thing";',
      'import * as path from "node:path";',
      'import "side-effect-module";',
      'export { KVNamespace } from "./re-export";',
    ].join("\n");
    // What the module exports, for {@link vocabulary}: the alias is dropped, the re-export is not an import.
    expect(exportedNames(sample, "@cloudflare/workers-types")).toEqual(["D1Database", "KVNamespace"]);
    // What the file binds, for {@link ambient}: the alias, the default's name, the namespace object.
    expect(boundNames(sample)).toEqual(["DB", "KVNamespace", "Miniflare", "defaultExport", "path"]);
    // And the two ends of it, through the scan itself: an aliased import is not an ambient use, and a
    // qualified one belongs to whatever bound the namespace.
    const bound = new Set(boundNames(sample));
    expect(bound.has("D1Database")).toBe(false);
    expect(/(?<![.\w$])D1Database\b/.test("const x: path.D1Database = y;")).toBe(false);
  });

  test("the caret check answers what the root pin is checked against", () => {
    expect(satisfiesCaret("5.20260804.1", "^5.20260729.1")).toBe(true);
    expect(satisfiesCaret("5.20260729.1", "^5.20260729.1")).toBe(true);
    expect(satisfiesCaret("5.20260729.0", "^5.20260729.1")).toBe(false);
    expect(satisfiesCaret("5.20260601.9", "^5.20260729.1")).toBe(false);
    expect(satisfiesCaret("6.20260804.1", "^5.20260729.1")).toBe(false);
    expect(satisfiesCaret("workspace:*", "^5.20260729.1")).toBe(false);
  });
});
