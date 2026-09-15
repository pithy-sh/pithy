// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "./sourceFiles";

/**
 * **A composition for an environment is composed for that environment, and by one primitive (#595).**
 *
 * A Worker's `pithy.config.ts` is code that may ask which environment it is composed for. Three producers
 * had asked it on the adopter's behalf by stamping `ENVIRONMENT` themselves (`ui/routeAllowlist.ts`,
 * `capabilities/secretApplicability.ts`), and every other command that composed for an environment asked
 * nothing — so `pithy migrate --env staging` applied the migrations of a composition for none. The rule
 * now lives in `project/composeFor.ts`, and this file holds the tree to it in four halves, each stated as
 * what must be true:
 *
 * 1. **`ENVIRONMENT` is written into this process by the primitive alone.** A module that writes
 *    `process.env` and names the variable is the primitive, or it is a second statement of the rule.
 * 2. **Every module that composes Workers through a loader `project/config.ts` or `project/workerScope.ts`
 *    exports, without the primitive, is named here, with why its composition is not for one environment**
 *    ({@link RAW_COMPOSERS}). A module naming a raw loader lands in the table
 *    or fails; a table entry whose module stopped naming one fails too, so the table cannot drift into a
 *    list of reasons nobody re-reads (#211).
 * 3. **Every module that assembles a backend does it inside the primitive.** `createBackend` is where a
 *    capability reads the environment at registration — the dev-login route is mounted there or not — so
 *    assembling one with no environment stamped is the #255 defect.
 * 4. **Every module that imports a computed specifier is named here** ({@link COMPUTED_IMPORTS}). A config
 *    is evaluated by importing it, and an adopter's path is never a string literal in this tree, so a
 *    module that reaches a config without any loader at all still has to import something computed.
 *
 * ## What this does not see, said plainly
 *
 * The first four were planted and left this file green; the fifth is a boundary rather than a spelling. A
 * gate believed to cover more than it does is worse than a narrow one somebody plans around.
 *
 * - **Module granularity, not call-site granularity.** A module in {@link RAW_COMPOSERS} may add a second
 *   raw composition, for an environment, beside the one its reason describes, and pass — planted as a
 *   `loadWorkerConfig(dir)` appended to `project/workflows.ts`. Half 3 likewise
 *   passes a module that assembles one backend inside the primitive and a second outside it. Reading call
 *   sites wants a binding analysis rather than a wider regex.
 * - **A composition carried out of a third module.** The loaders are derived from the two modules that
 *   define them ({@link rawLoaders}); a function another module exports that composes raw inside it is not
 *   followed, so its callers are not held. `commands/add.ts`'s `targetWorker`, reached from
 *   `commands/remove.ts`, is one today. Planted: an `export async function everyWorker(dir) { return
 *   resolveWorkerSet({ projectDir: dir }); }` in `project/domains.ts`, already listed, and a call to it
 *   from `commands/migrate.ts` — green. Following it module by module names nearly fifty modules through
 *   wrappers that compose for no environment on purpose, which is a binding analysis this file does not do.
 * - **Which environment.** `composeFor("dev", …)` in a command about staging reaches the primitive and
 *   passes. The environments this CLI composes for are held by behavior —
 *   `migrations/environmentComposition.test.ts` — not by source text.
 * - **A variable name assembled at runtime.** `process.env[["ENVIRON", "MENT"].join("")] = env` names
 *   nothing half 1 reads, and a helper in another module handed a bare `process.env` object to write into
 *   is a write this file sees only where that module also names the variable.
 * - **A config reached by `require`, or by a loader library.** The CLI is ESM and loads configs through
 *   `import()`; a `createRequire` or a `jiti` would compose a config invisibly to half 4.
 * - **Only `packages/cli/src`.** The root `pithy.config.ts` (`loadProject`) composes no Worker and is out
 *   of scope; so is every other package.
 *
 * It reads comment-blanked source, because every docblock on this subject quotes what it is about.
 */

const CLI_SRC = join(import.meta.dirname, "..");

/** The primitive. It defines the stamp, and it is the one module allowed to write it. */
const PRIMITIVE = "project/composeFor.ts";

/** The primitive's exports, any of which is a composition through it. */
const PRIMITIVE_EXPORTS =
  /\b(?:composeFor|composeForSync|resolveWorkersFor|resolveSingleWorkerFor|resolveWorkerSetFor|projectCapabilitySetFor)\b/;

/** The modules that define the Worker loaders: a config's evaluation, and the resolvers over it. */
const LOADER_MODULES: readonly string[] = ["project/config.ts", "project/workerScope.ts"];

/** The loader every other one reaches: the evaluation of one Worker's `pithy.config.ts`. */
const EVALUATES_A_WORKER_CONFIG = "loadWorkerConfig";

/**
 * Every top-level function a module declares — `function`, or a `const` bound to one — with its text.
 *
 * Read by layout rather than by parse: biome opens a top-level declaration at column 0 and closes it
 * there, so a declaration runs to the next line that starts with anything but whitespace or a closer.
 * Comments are already blanked, so a docblock never starts one.
 */
function topLevelFunctions(code: string): { name: string; exported: boolean; text: string }[] {
  const found: { name: string; exported: boolean; text: string }[] = [];
  let current: { name: string; exported: boolean; lines: string[] } | null = null;
  for (const line of code.split("\n")) {
    if (/^[^\s})\]]/.test(line)) {
      if (current !== null)
        found.push({ name: current.name, exported: current.exported, text: current.lines.join("\n") });
      const head = /^(export\s+)?(?:async\s+function\s*\*?|function\s*\*?|const)\s+([\w$]+)/.exec(line);
      current = head === null ? null : { name: head[2] as string, exported: head[1] !== undefined, lines: [] };
    }
    current?.lines.push(line);
  }
  if (current !== null) found.push({ name: current.name, exported: current.exported, text: current.lines.join("\n") });
  return found;
}

/**
 * **Every loader that composes Workers with no environment stamped, derived from the modules that define
 * them** — never a list typed here.
 *
 * The list typed here was four names long and the defining module exported six loaders:
 * `resolveWorkerSet` and `projectCapabilitySet` compose every Worker exactly as `resolveWorkers` does, and
 * `commands/feature.ts`, `commands/token.ts` and `audit/cliAudit.ts` spent them unlisted while this gate was
 * green. So the set is the evaluation itself plus every top-level function in {@link LOADER_MODULES} that
 * reaches one already in it, to a fixed point, and a loader added beside them next year is in it by being
 * written. Only the exported ones are importable, so only they are matched elsewhere.
 */
function rawLoaders(): string[] {
  const declared = LOADER_MODULES.flatMap((key) =>
    topLevelFunctions(MODULES.find((module) => module.key === key)?.code ?? ""),
  );
  const raw = new Set([EVALUATES_A_WORKER_CONFIG]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, text } of declared) {
      if (raw.has(name)) continue;
      const body = text.slice(text.indexOf(name) + name.length);
      if ([...raw].some((loader) => new RegExp(`(?<![.\\w$])${loader}\\b`).test(body))) {
        raw.add(name);
        grew = true;
      }
    }
  }
  const exported = new Set(declared.filter((fn) => fn.exported).map((fn) => fn.name));
  return [...raw].filter((name) => exported.has(name)).sort();
}

/**
 * A module that names a Worker loader which composes for no environment on its own.
 *
 * **By name, not by call shape**, so `import { resolveWorkers as every }` is caught at the import that has
 * to exist for any spelling of the call. Two positions are not a use and are skipped: a property key
 * (`resolveWorkers?: (…) => …`, a seam's type) and a member read (`options.resolveWorkers`, a seam's
 * value) — both name somebody else's resolver, and the default they fall back to is what gets read.
 *
 * **Skipping those two opened a hole, and {@link LOADER_MODULE_WHOLE} closes it.** Planted:
 * `const { resolveWorkers: all } = await import("./workerScope")` is a key by shape, and
 * `import * as scope from "./workerScope"` then `scope.resolveWorkers(…)` is a member read by shape — both
 * real compositions, both green. What neither can avoid is taking the whole defining module, by namespace or
 * by `import()`, so that is what is matched. Nothing in the tree does either today.
 */
function rawLoaderPattern(): RegExp {
  return new RegExp(`(?<![.\\w$])(?:${rawLoaders().join("|")})\\b(?!\\s*\\??\\s*:)`);
}

/** A namespace import or an `import()` of a module that defines a raw loader. */
const LOADER_MODULE_WHOLE =
  /import\s*\*\s*as\s+[\w$]+\s+from\s*["'][^"']*(?:project\/|\.\/)(?:workerScope|config)["']|\bimport\s*\(\s*["'][^"']*(?:project\/|\.\/)(?:workerScope|config)["']\s*\)/;

/** Whether a module composes Workers through a raw loader, by any of the spellings above. */
function composesRaw(code: string): boolean {
  return rawLoaderPattern().test(code) || LOADER_MODULE_WHOLE.test(code);
}

/** A module that assembles a backend: a call to `createBackend`, or an import of it under any alias. */
const ASSEMBLES_BACKEND = /\bcreateBackend\s*\(|import\s*(?:type\s+)?\{[^}]*\bcreateBackend\b[^}]*\}\s*from/;

/** An `import()` whose specifier is not a plain string literal — a path, a URL, a template. */
const COMPUTED_IMPORT = /\bimport\s*\(\s*(?:[^"'`\s)]|`[^`]*\$\{)/;

/**
 * A module that can write this process's environment: an assignment or `delete` on `process.env`, an
 * `Object.assign`/`Reflect` onto it, or `process.env` bound to a name or handed to a function — after
 * which any write is through a name this file cannot follow, so the binding itself counts.
 */
const WRITES_PROCESS_ENV =
  /process\.env\s*(?:\[[^\]]*\]|\.\w+)\s*=(?!=)|\bdelete\s+process\.env\b|\b(?:Object\.assign|Reflect\.set|Reflect\.deleteProperty|Object\.defineProperty)\s*\(\s*process\.env\b|=\s*process\.env\s*[;,)]|\(\s*process\.env\s*[,)]|=\s*(?:globalThis\.)?process\s*;/;

/** The composition environment variable, by its constant or by its own name. */
const NAMES_ENVIRONMENT = /\bENVIRONMENT(?:_VAR)?\b/;

/**
 * Every module that composes Workers with no environment stamped, and **why that composition is not for
 * one environment**. A reason that is no longer true is a hole; each is one sentence a reviewer can check.
 */
const RAW_COMPOSERS: Readonly<Record<string, string>> = {
  "project/config.ts": "Defines loadWorkerConfig, which the primitive's loader spends.",
  "project/workerScope.ts": "Defines the Worker resolvers, which the primitive hands its loader to.",
  "audit/cliAudit.ts":
    "Decides whether a command that names no one environment audits from the composition for none; a command that names its environment in actedOn composes for it through projectCapabilitySetFor.",
  "capabilities/secretApplicability.ts":
    "Resolves once, unstamped, only to learn which Worker directories exist; every environment's answer is composed through composeFor.",
  "commands/add.ts":
    "Chooses the Worker pithy add and pithy remove write wiring into, for every environment at once; pithy remove --drop reverses the migrations of that composition, which is a limit of this entry.",
  "commands/doctor.ts":
    "Resolves once for a report over every environment; its per-environment migration answers compose inside composeFor, and its secret answers come from secretApplicability.",
  "commands/email.ts":
    "Reads the capability's config and the domains declaration once, for provisioning that spans every declared environment.",
  "commands/media.ts":
    "Reads the capability's config as one project-wide declaration; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "commands/payments.ts":
    "Reads the capability's config as one project-wide declaration; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "commands/secrets.ts":
    "Merges the secret registry, which is per project with one value per name; which names each environment reaches is secretApplicability's.",
  "commands/storage.ts":
    "Reads the capability's config as one project-wide declaration; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "commands/support.ts":
    "Reads the capability's config as one project-wide declaration; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "commands/testers.ts":
    "Reads the capability's config as one project-wide declaration, for its roster subcommands too; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "commands/turnstile.ts":
    "Reads the widget set as one project-wide declaration, and the production address from the domains declaration.",
  "commands/vector.ts":
    "Reads the capability's config as one project-wide declaration, for its per-environment subcommands too; a config that differs by environment is answered from the composition for none, which is a limit of this entry.",
  "devSecrets/targets.ts":
    "Reads the dev secrets registry, which is per project with one value per name, re-importing a config pithy add has just written.",
  "doctor/settingsSources.ts": "Reads the domains declaration, which names every environment's address in one value.",
  "project/deploy.ts": "Reads the domains declaration, which names every environment's address in one value.",
  "project/deployKit.ts": "Reads the domains declaration, which names every environment's address in one value.",
  "project/domains.ts": "Reads the domains declaration, which names every environment's address in one value.",
  "project/envInventory.ts": "Reads the domains declaration, which names every environment's address in one value.",
  "project/workflows.ts": "Compares the app's workflow declaration with every environment's stanza at once.",
};

/** Every module that imports a computed specifier, and what it imports. */
const COMPUTED_IMPORTS: Readonly<Record<string, string>> = {
  "project/config.ts": "Imports a Worker's pithy.config.ts, from the cache or as a fresh copy.",
  "project/kitResolve.ts": "Imports a kit package resolved from the adopter's project, never a config.",
  "devSecrets/targets.ts": "Re-imports a config past the module cache; listed in RAW_COMPOSERS with why.",
  "ci/distTypes.ts": "Imports this repository's own built modules to read their exports, never a config.",
};

/** One module's path as the tables spell it — relative to `packages/cli/src`, forward slashes. */
function named(path: string): string {
  return relative(CLI_SRC, path).split("\\").join("/");
}

/** Every shipped CLI module, with its comments blanked out. */
const MODULES: { key: string; code: string }[] = sourceFiles(CLI_SRC).map((file) => ({
  key: named(file.path),
  code: blankComments(file.text),
}));

/** The keys of the modules a pattern matches, sorted. */
function matching(pattern: RegExp): string[] {
  return MODULES.filter((module) => pattern.test(module.code))
    .map((module) => module.key)
    .sort();
}

describe("a composition for an environment is composed for it, by one primitive", () => {
  test("the walk finds the CLI's sources, so a miss is a failure and not a silent pass", () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(235);
    const keys = new Set(MODULES.map((module) => module.key));
    for (const key of [PRIMITIVE, ...Object.keys(RAW_COMPOSERS), ...Object.keys(COMPUTED_IMPORTS)]) {
      expect(keys.has(key), `${key} is not in the tree`).toBe(true);
    }
  });

  test("ENVIRONMENT is written into this process by the primitive alone", () => {
    const stampers = MODULES.filter(
      (module) => WRITES_PROCESS_ENV.test(module.code) && NAMES_ENVIRONMENT.test(module.code),
    ).map((module) => module.key);
    expect(
      stampers,
      "This module sets ENVIRONMENT for a composition itself. Compose through composeFor (or composeForSync) in project/composeFor.ts instead: it stamps, restores, queues, and loads each config as evaluated for that environment.",
    ).toEqual([PRIMITIVE]);
  });

  test("the raw loaders are derived from the modules that define them, and include every one planted against", () => {
    expect(
      rawLoaders(),
      "The loaders derived from project/config.ts and project/workerScope.ts changed. A new one is held by this gate already; confirm it composes Workers, and that a removed one no longer does.",
    ).toEqual([
      "loadWorkerConfig",
      "projectCapabilitySet",
      "resolveSingleWorker",
      "resolveWorkerSet",
      "resolveWorkers",
      "resolveWorkersReporting",
    ]);
  });

  test("every module composing Workers without the primitive is named, with why", () => {
    const composers = MODULES.filter((module) => module.key !== PRIMITIVE && composesRaw(module.code))
      .map((module) => module.key)
      .sort();
    expect(
      composers,
      "This module composes Workers with no environment stamped. If the command is about one environment, compose through project/composeFor.ts (resolveWorkersFor, resolveSingleWorkerFor, composeFor). If it is not, name it in RAW_COMPOSERS with the sentence that says why.",
    ).toEqual(Object.keys(RAW_COMPOSERS).sort());
    for (const [key, reason] of Object.entries(RAW_COMPOSERS)) expect(reason, key).toMatch(/^[A-Z].*\.$/);
  });

  test("every module assembling a backend does it inside the primitive", () => {
    const assemblers = matching(ASSEMBLES_BACKEND);
    expect(assemblers.length, "no module assembles a backend, so this half checks nothing").toBeGreaterThan(0);
    for (const key of assemblers) {
      const code = MODULES.find((module) => module.key === key)?.code ?? "";
      expect(
        PRIMITIVE_EXPORTS.test(code),
        `${key} assembles a backend without composeForSync or composeFor, so a capability's registration-time environment gate reads whatever this process happens to have`,
      ).toBe(true);
    }
  });

  test("every module importing a computed specifier is named, with what it imports", () => {
    expect(
      matching(COMPUTED_IMPORT),
      "This module imports a computed specifier. If it can reach a pithy.config.ts, load it through project/composeFor.ts; either way, name it in COMPUTED_IMPORTS with what it imports.",
    ).toEqual(Object.keys(COMPUTED_IMPORTS).sort());
  });

  test("the extractors see the spellings they claim, and miss the ones the docblock names", () => {
    // Loaders: the call, the import, an alias, and the shorthand — and not a seam's key or member.
    expect(rawLoaderPattern().test("const workers = await resolveWorkers({ projectDir });")).toBe(true);
    expect(rawLoaderPattern().test('import { resolveWorkers as every } from "../project/workerScope";')).toBe(true);
    expect(rawLoaderPattern().test("const seams = { loadWorkerConfig };")).toBe(true);
    expect(rawLoaderPattern().test("const found = await resolveSingleWorker(options);")).toBe(true);
    expect(rawLoaderPattern().test("resolveWorkers?: (options: { projectDir: string }) => Promise<W[]>;")).toBe(false);
    expect(rawLoaderPattern().test("const resolve = options.resolveWorkers ?? fallback;")).toBe(false);
    expect(rawLoaderPattern().test("const workers = await resolveWorkersFor(env, { projectDir });")).toBe(false);
    // The two loaders the typed list missed, and their twins through the primitive.
    expect(rawLoaderPattern().test("const workerSet = await resolveWorkerSet({ projectDir });")).toBe(true);
    expect(rawLoaderPattern().test('import { projectCapabilitySet as union } from "../project/workerScope";')).toBe(
      true,
    );
    expect(rawLoaderPattern().test("await projectCapabilitySetFor(env, projectDir)")).toBe(false);
    // A pure fold over Workers already composed is not a loader.
    expect(rawLoaderPattern().test("const union = projectCapabilities(workers);")).toBe(false);
    // The derivation reads both declaration shapes, exported or not, and follows a private helper.
    const shapes = topLevelFunctions(
      [
        "const helper = (dir) => loadWorkerConfig(dir);",
        "export async function viaHelper(dir) {",
        "  return helper(dir);",
        "}",
        "export const arrow = async (dir) => {",
        "  return 1;",
        "};",
      ].join("\n"),
    );
    expect(shapes.map(({ name, exported }) => `${exported ? "export " : ""}${name}`)).toEqual([
      "helper",
      "export viaHelper",
      "export arrow",
    ]);
    // The two shapes the skips let through, and what catches them instead.
    expect(rawLoaderPattern().test('const { resolveWorkers: all } = await import("./workerScope");')).toBe(false);
    expect(composesRaw('const { resolveWorkers: all } = await import("./workerScope");')).toBe(true);
    expect(composesRaw('import * as scope from "../project/workerScope";')).toBe(true);
    expect(composesRaw('import * as config from "./config";')).toBe(true);
    expect(composesRaw('const { loadProject } = await import("../project/workerIdentity");')).toBe(false);
    // Backends.
    expect(ASSEMBLES_BACKEND.test("const app = createBackend({ capabilities });")).toBe(true);
    expect(
      ASSEMBLES_BACKEND.test('import { createBackend as assemble } from "@pithy-sh/core/src/createBackend";'),
    ).toBe(true);
    expect(ASSEMBLES_BACKEND.test("detail: `createBackend refuses to assemble without them.`")).toBe(false);
    // Computed imports.
    expect(COMPUTED_IMPORT.test("await import(pathToFileURL(path).href)")).toBe(true);
    // Assembled, so the placeholder is the text under test rather than a template the linter reads as a slip.
    expect(COMPUTED_IMPORT.test(["await import(`$", "{path}?pithy-reload=$", "{count}`)"].join(""))).toBe(true);
    expect(COMPUTED_IMPORT.test("await import(url)")).toBe(true);
    expect(COMPUTED_IMPORT.test('await import("miniflare")')).toBe(false);
    // Environment writes, in every spelling planted against it.
    expect(WRITES_PROCESS_ENV.test("process.env[ENVIRONMENT_VAR] = environment;")).toBe(true);
    expect(WRITES_PROCESS_ENV.test('process.env.ENVIRONMENT = "prod";')).toBe(true);
    expect(WRITES_PROCESS_ENV.test("delete process.env[ENVIRONMENT_VAR];")).toBe(true);
    expect(WRITES_PROCESS_ENV.test("Object.assign(process.env, { ENVIRONMENT: env });")).toBe(true);
    expect(WRITES_PROCESS_ENV.test('Reflect.set(process.env, "ENVIRONMENT", env);')).toBe(true);
    expect(WRITES_PROCESS_ENV.test("const ambient = process.env;")).toBe(true);
    expect(WRITES_PROCESS_ENV.test("stamp(process.env, name, env);")).toBe(true);
    expect(WRITES_PROCESS_ENV.test("const value = process.env[ENVIRONMENT_VAR];")).toBe(false);
    expect(WRITES_PROCESS_ENV.test("if (process.env.ENVIRONMENT === env) return;")).toBe(false);
    expect(NAMES_ENVIRONMENT.test('ambient["ENVIRONMENT"] = env;')).toBe(true);
    expect(NAMES_ENVIRONMENT.test("import { ENVIRONMENT_VAR as NAME } from 'x';")).toBe(true);
    // The spelling the docblock says it misses, planted rather than asserted about in prose.
    expect(NAMES_ENVIRONMENT.test('process.env[["ENVIRON", "MENT"].join("")] = env;')).toBe(false);
  });
});
