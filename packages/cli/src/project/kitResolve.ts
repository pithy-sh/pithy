// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * **A `@pithy-sh/*` module, resolved from the project — never from wherever the CLI is installed.**
 *
 * ## The defect this exists to remove (#533)
 *
 * Every optional capability was reached with a bare specifier: `import("@pithy-sh/payments/src/capability")`.
 * A bare specifier in ESM resolves relative to the **importing module's** own location, so a globally
 * installed `pithy` walked up from its own `dist/` and asked its own `node_modules`. The CLI read the
 * project's `pithy.config.ts`, learned that the project composes `payments`, and then resolved the module
 * that config named against itself.
 *
 * The visible half was a refusal: `pithy payments provision` on a project with `@pithy-sh/payments@0.2.1`
 * installed and composed answered *"The payments capability is not installed. Run `pithy add payments`."*
 * Both halves of that sentence are wrong, and the action is the worse one — `pithy add` scaffolds into a
 * `pithy.config.ts` an adopter hand-built, so trusting it rewrites working configuration to work around a
 * resolution bug.
 *
 * The silent half was worse. The six packages the CLI itself depends on — `cloudflare`, `core`, `email`,
 * `secrets`, `turnstile`, `ui-react` — *did* resolve, to **the CLI's copies**. A global cli 0.2.2 ran
 * `@pithy-sh/email@0.1.7`'s resolver against a project pinned to `0.1.6` and never said a word, because
 * every brand check in the kit is structural and structure did not change. What drifted was resolver
 * behavior and the contents of the Worker that got deployed.
 *
 * A local install worked only by accident of location: `<project>/node_modules/.bin/pithy` starts inside
 * the project, so walking up from the CLI's `dist/` lands in the project's own `node_modules`.
 *
 * ## The rule
 *
 * **The project decides what its capabilities are.** Every module named by a project's configuration is
 * resolved from `<projectDir>/package.json`, which is where that configuration was read from. A call site
 * that cannot name a project root cannot use this — and that is the point: `process.cwd()` is not a
 * substitute, because `pithy dev`'s host resolvers run with a worktree as the cwd, and reading an ambient
 * is the same implicit-base habit that produced the bug.
 *
 * A CLI-owned module — one the CLI depends on for its own behavior rather than the adopter's — keeps its
 * bare `import()` and says why on the line. `ci/kitResolution.test.ts` holds both directions: a bare
 * `@pithy-sh` import under `packages/cli/src` either goes through this module, or is written down there
 * with its reason, or is one of the static imports that gate records as the residue this cannot reach.
 *
 * ## The project is its root *and* its Workers
 *
 * The first round of #533 read "the project" as one directory, and that left the issue's own sentence
 * reproducible in the layout the kit tells adopters to adopt. **Capabilities are per Worker** (CLAUDE.md
 * §CLI & configuration): `apps/<name>/pithy.config.ts` is what composes them, it is imported by absolute
 * path so its own `import "@pithy-sh/payments/…"` resolves from `apps/<name>/`, and a package manager that
 * does not hoist — pnpm's default, and pnpm is first-class in `project/packageManager.ts` — installs it
 * exactly there. Against that project a root-only walk answered *"The payments capability is not
 * installed. Run `pithy add payments`"*, which is the sentence the issue was filed about, about a package
 * the Worker beside it loads without complaint.
 *
 * So the chain the root walks is the *first* place looked, not the only one: each Worker's own
 * `node_modules` follows it. `apps/` is the Worker registry (`project/workers.ts`), and this asks it a
 * narrower question than `discoverWorkers` does — not *is this a Worker in the dev set* but *does this
 * directory hold an install* — so no manifest is read and a Worker mid-scaffold is not a hole. Nothing
 * outside `apps/` is consulted.
 *
 * **Root first is a rule and not an accident.** Every project that resolves today keeps resolving the
 * identical file; the only thing that changed is that a refusal became an answer. Compare
 * {@link import("../capabilities/manifests").composedManifests}, which reaches the same two places and
 * ranks them the other way round: it is asked about **one** Worker, so that Worker's copy wins and the
 * project is described by what it runs (#507). A `pithy <capability>` command has no Worker in hand — it
 * is the *project's* payments configuration it is provisioning, and `commands/payments.ts` already reads
 * that from the first composing Worker — so there is no Worker whose copy could be preferred, and
 * preferring some Worker's would move the answer for every hoisted project to make a rare disagreement
 * come out differently. `doctor/capabilityReach.ts` reports a composed capability that is in neither place.
 *
 * ## Why the resolver's answer is not trusted on its own
 *
 * **A resolver is a runtime's opinion, and the two runtimes this code runs under disagree about the one
 * question that matters here.** Node walks the `node_modules` chain and throws when the chain comes up
 * empty. Bun walks the same chain and then, finding nothing, answers out of its **global install cache**:
 *
 * ```text
 * # a project with no node_modules anywhere on its ancestor chain
 * BUN   @pithy-sh/payments/src/capability => ~/.bun/install/cache/@pithy-sh/payments@0.2.1@@@1/dist/capability.js
 * NODE  @pithy-sh/payments/src/capability => MODULE_NOT_FOUND
 * ```
 *
 * That is #533 again with a different `node_modules` on the end of it. Under Bun the CLI would load a
 * capability the project has never installed, at whatever version some unrelated install once cached, and
 * {@link import("./kitSource").kitSource} would hand wrangler a worker directory **inside the cache** to
 * deploy under the adopter's name. `not-installed` would be unreachable, so the one refusal that is
 * allowed to say `pithy add` could never be earned, and the adopter would be told the opposite of the
 * truth: `@pithy-sh/payments is installed, but nothing resolves "zod"`.
 *
 * `packages/cli/src/bin.ts` is `#!/usr/bin/env node`, and so is vitest's own binary — which is why
 * `bunx vitest` runs this repository's suite on **Node 24** and not on Bun, and why the divergence above
 * had to be *measured* with a probe rather than met in a failing test. A guarantee that holds only in the
 * runtime the suite happens to use is a guarantee nothing checks. **So the resolution is anchored rather
 * than trusted**, in both runtimes and in whatever the next one does. The package's home
 * directory is found first by {@link packageDirFrom}, a plain walk of the same chain that answers
 * identically in every runtime because it asks the filesystem instead of a resolver; the resolver is only
 * asked *afterwards*, for the subpath, and its answer is refused unless it lands inside that home. Both
 * runtimes now give the same answer to *is this package the project's*, and the difference between them
 * is reduced to what it should be — which file inside a package a subpath maps to, where they agree.
 *
 * ## Why `createRequire` and not `import.meta.resolve`
 *
 * Node 22's `import.meta.resolve` is single-argument — the parent form is behind
 * `--experimental-import-meta-resolve` — so there is no way to ask it about a base other than the calling
 * module. `createRequire(<base>).resolve()` selects the identical file here: no `@pithy-sh/*` package
 * declares an `import` or `require` condition (all 22 map `./src/*` to `{ types, default }` and nothing
 * else), so the CJS and ESM resolvers agree on every specifier this is used with — on the *subpath*
 * question, which is the only one left to them.
 *
 * ## What this does not reach, and is a separate change
 *
 * **A static bare import cannot be re-based at all.** Ninety-odd of them across thirty-nine files import
 * values out of `@pithy-sh/secrets`, `@pithy-sh/email`, `@pithy-sh/turnstile` and `@pithy-sh/ui-react` —
 * migrations, namers, a secret registry, a template resolver — and those come from the CLI's copy whatever
 * this module does. `ci/kitResolution.test.ts` records that residue file by file so it cannot grow
 * unnoticed. What moved here is the *artifact* half: the worker directory those commands hand to wrangler
 * is the project's, because it is what gets deployed under the adopter's name and runs against the
 * adopter's database. That leaves a deploy filling the project's committed template with the CLI's
 * resolver, which is a narrower skew than shipping the CLI's Worker outright but is not nothing. Closing
 * it means removing those static imports, which is its own issue.
 */

/** `@pithy-sh/payments` from `@pithy-sh/payments/src/capability` — the package, not the subpath. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/**
 * Where `pkg` lives on the `node_modules` chain `projectDir` walks, or `null`.
 *
 * The same lookup `project/packageManager.ts` does, and the reason it is a directory walk rather than a
 * resolution is {@link packageInstalledFrom}'s. It is also the reason it is the *anchor*: a walk asks the
 * filesystem a question with one answer, so Node and Bun cannot differ about it.
 *
 * **One base's chain, which is not the whole of what a project has** — see {@link kitPackage}, which adds
 * the Workers. Exported for the tests that stage a bare project, where "the root chain carries nothing" is
 * the fact the staging rests on.
 */
export function packageDirFrom(projectDir: string, pkg: string): string | null {
  let dir = projectDir;
  for (;;) {
    const home = join(dir, "node_modules", pkg);
    if (existsSync(join(home, "package.json"))) return home;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The project's Worker directories — `apps/*`, and nothing else.
 *
 * The Worker registry read for the one fact resolution needs — which directories can hold an install — so
 * it is a `readdir` and nothing else. `discoverWorkers` keys on `pithy.worker.jsonc` because it is
 * assembling the *dev set*, where a directory declaring no manifest is not a process to start; here a
 * `node_modules/@pithy-sh/payments/package.json` under `apps/api` is an install whether or not the Worker
 * beside it has been scaffolded yet, and a missed one is a refusal an adopter cannot act on.
 *
 * Sorted, so two Workers that disagree about a version resolve the same way on every machine rather than
 * in whatever order the filesystem hands them back.
 */
function workerBases(projectDir: string): string[] {
  try {
    return readdirSync(join(projectDir, "apps"))
      .sort()
      .map((entry) => join(projectDir, "apps", entry));
  } catch {
    return []; // no apps/ — a project with no Workers yet, or one that is not laid out that way
  }
}

/** Where a package sits for `projectDir`, and the base that found it — root first, then the Workers. */
interface KitPackage {
  /** The base whose chain named it: the project root, or `apps/<name>`. Resolution is done from here. */
  readonly base: string;
  /** The package's own directory — the anchor every resolved path must land inside. */
  readonly home: string;
}

/**
 * Where `pkg` lives for `projectDir` — its root chain, else one of its Workers' own `node_modules`.
 *
 * The one lookup both halves of this module ask, so *is it installed* and *where does it resolve from*
 * cannot answer differently. A Worker's directory is checked directly rather than walked, because
 * everything above it is the root's chain and that has already been asked.
 */
function kitPackage(projectDir: string, pkg: string): KitPackage | null {
  const home = packageDirFrom(projectDir, pkg);
  if (home !== null) return { base: projectDir, home };
  for (const base of workerBases(projectDir)) {
    const at = join(base, "node_modules", pkg);
    if (existsSync(join(at, "package.json"))) return { base, home: at };
  }
  return null;
}

/**
 * Whether a **package** is installed where `projectDir` would find it. Never throws — the question is
 * the answer.
 *
 * Used by the classifier to tell *absent* from *unreachable*, and by nothing that needs a path.
 *
 * **A directory check rather than a resolution, and that is not a shortcut.** Every `@pithy-sh/*` package
 * declares exactly one export — `"./src/*"` — and nothing else, so `require.resolve("@pithy-sh/payments")`
 * throws `ERR_PACKAGE_PATH_NOT_EXPORTED` on an install that is perfectly healthy. A probe built on it
 * answers "absent" for all 22 packages and the classifier goes on printing `pithy add` at a project that
 * has the package. `projectResolution.test.ts` caught exactly that on this function's first draft.
 *
 * So this asks the question it means: is there a `node_modules/<pkg>/package.json` anywhere
 * {@link kitResolve} would look? It has to be the *same* question, or the classifier and the loader
 * disagree — a package under `apps/api` that the loader now reaches would be reported "not installed" by a
 * check that still walked the root alone, which is #533's own sentence surviving its own fix.
 */
export function packageInstalledFrom(projectDir: string, pkg: string): boolean {
  return kitPackage(projectDir, pkg) !== null;
}

/** A path's real location, or the path itself when nothing is there to resolve. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether `path` is inside `home` — compared through `realpathSync`, because a workspace link and a
 * content-addressed store both put the package's real files somewhere other than where the chain names
 * them, and `require.resolve` reports the real one.
 */
function under(home: string, path: string): boolean {
  const step = relative(real(home), real(path));
  return step !== "" && !step.startsWith("..") && !step.startsWith(`${sep}`);
}

/** Node's own sentence for a package that is not on the chain, so nothing downstream has to know. */
function absent(pkg: string, projectDir: string): Error {
  return Object.assign(new Error(`Cannot find package '${pkg}' imported from ${join(projectDir, "package.json")}`), {
    code: "MODULE_NOT_FOUND",
  });
}

/** Node's own sentence for a specifier that would not resolve inside a package that is there. */
function escaped(specifier: string, resolved: string, home: string): Error {
  return Object.assign(new Error(`Cannot find module '${specifier}'`), {
    code: "MODULE_NOT_FOUND",
    detail: `resolved to ${resolved}, which is outside ${home}`,
  });
}

/**
 * Where `specifier` resolves to **for the project at `projectDir`**, as an absolute path — its root
 * chain, else the Workers under `apps/`, in that order and for the reason stated above.
 *
 * The base handed to the resolver is the one that found the package, so a Worker's install is resolved
 * from that Worker: `createRequire(<projectDir>/package.json)` would walk straight past it and hand back
 * the refusal the walk had just ruled out.
 *
 * @throws an unresolved-import error — `MODULE_NOT_FOUND` and the message Node states — when the package
 * is in none of those places, or when the runtime's resolver answered with a file outside the copy the
 * walk named. Both are the same fact to a caller: *the project does not have this*. See the anchoring
 * paragraph above for why the second is not a theoretical case.
 * @throws whatever node's resolver throws for everything else — `ERR_PACKAGE_PATH_NOT_EXPORTED` and the
 * rest, unwrapped. Deliberately not classified here: each capability loader already catches and hands the
 * cause to {@link import("../capabilities/loadFailure").classifyCapabilityLoadFailure}, which is the one
 * place that decides what may be said about a failure. A second classifier is a second thing to drift.
 */
export function kitResolve(projectDir: string, specifier: string): string {
  const pkg = packageOf(specifier);
  const found = kitPackage(projectDir, pkg);
  if (found === null) throw absent(pkg, projectDir);
  const resolved = createRequire(join(found.base, "package.json")).resolve(specifier);
  if (!under(found.home, resolved)) throw escaped(specifier, resolved, found.home);
  return resolved;
}

/**
 * Import a kit module from the project's own install.
 *
 * The type parameter is the module's shape — every call site in this package already declares one as
 * `typeof import("@pithy-sh/…")`, so the annotation that used to be inferred is now written down beside
 * the specifier rather than lost.
 *
 * `pathToFileURL` rather than the raw path: an absolute Windows path is not a valid ESM specifier, and a
 * path holding a `#` or a `?` would be read as a fragment or a query.
 */
export async function kitImport<T>(projectDir: string, specifier: string): Promise<T> {
  return (await import(pathToFileURL(kitResolve(projectDir, specifier)).href)) as T;
}
