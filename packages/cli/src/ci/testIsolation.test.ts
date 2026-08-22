// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLOUDFLARE_ENV_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import { beforeAll, describe, expect, test } from "vitest";
import { blankComments, readSource, sourcePaths } from "./sourceFiles";

/**
 * The gates. **No test in this repository resolves the operator's real machine or their real account.**
 *
 * Two defects in two weeks, and one shape between them. #200: `bun run test` minted 36 real AES master
 * keys into a maintainer's `~/.config/pithy` and wrote `SECRETS_STORE_ID` into their real
 * `cloudflare.json`, because `addBootstrap.test.ts` passed no `paths` seam and nothing made the config
 * directory fake. #198: unit suites authenticated against a live Cloudflare account, because
 * `cloudflareEnv` overlays `process.env` per key — correct, and CI depends on it — and every developer
 * who has run `pithy deploy` has a token exported. Both are **a test resolving a real thing because no
 * config said otherwise**, and both were fixed once, in one package, leaving the other twenty exposed.
 *
 * So the rule is stated about every config rather than about the two that were caught.
 *
 * **It loads the configs; it does not read them.** A source scan would have passed the exact bug #198
 * records: the guard was added as a *second* `env:` key on one object literal, which JavaScript discards
 * without a word, so the text said covered and the run was not. This imports each config and inspects
 * the object vitest will actually be handed, which is the only artifact that cannot lie about what took
 * effect. A guard that is present but inert fails here exactly like a missing one — and that is worth
 * more than the missing case, because an inert guard reads as covered to everyone who checks.
 *
 * **Where a guard has to be stated is not a matter of taste.** Measured on vitest 4.1.9, in this repo:
 * a root `test.env` *does* reach an inline project, and a root `test.setupFiles` *does not*. So `env` is
 * accepted from either level and `setupFiles` is required on the project itself. Getting that backwards
 * is how a config acquires a guard that never runs.
 *
 * **Workers projects are exempt from the two guards above, and from nothing else. State that precisely,
 * because for a while it was stated loosely and the looseness was the hole (#437).**
 *
 * *Exempt:* the blank-credential `env` pin and the config-directory setup. workerd inherits nothing from
 * the host, so there is no ambient credential to blank and no real home directory to resolve. Either
 * guard there would be inert by construction, which is the thing this file exists to refuse. A test
 * under `@cloudflare/vitest-plugin` sees Vite's `import.meta.env` shims and vitest's two pool ids, plus
 * whatever `bindings` its own config declares. No `CLOUDFLARE_API_TOKEN`, no `HOME`.
 *
 * *Not exempt:* everything a workers config **declares**. Inheritance and declaration are different
 * questions and the exemption only ever answered the first. A `bindings` entry writes into workerd's
 * `process.env` by design, so `CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN` was #198 walking
 * back in through the exempt door with nothing to stop it. Two gates below close that, and they are
 * halves rather than duplicates: every workers project loads `vitest.workers.setup.ts`, which refuses a
 * credential *visible inside workerd*, and neither a workers config nor any repository module it imports
 * may read `process.env` at all, which refuses the *declaration* on a machine where it happens to
 * evaluate to nothing.
 *
 * **That is asserted, not probed.** It used to be a sentence here reporting a count taken once on
 * workerd `1.20260730.1`; #433 moved the harness to `1.20260820.1` and the sentence would have gone
 * stale without a word — in the file that justifies dropping a guard, which is the worst place for a
 * fact nothing checks. {@link WORKERD_ENV_EVIDENCE} pins the exact key set from inside workerd, and
 * the citation is resolved below rather than left as prose that rots the same way. What it pins is now
 * core's own exact set; the portable half of its claim runs in all seventeen projects instead.
 *
 * **`templates/` is exempt from the guards it cannot state, and from nothing else — there is an
 * eighteenth workers config in it.** Those files are copied verbatim into an adopter's repository by
 * `pithy init`, where they become the adopter's code and this repository's root does not exist. So
 * `templates/starter/vitest.workers.config.ts` can state neither setup file: both are absolute paths
 * only this checkout has. It is dropped from the walk that loads configs for that reason, and a reader
 * counting eighteen files against seventeen projects has found this paragraph rather than a gap. They
 * are also not a workspace member, so `bun run test` never runs them.
 *
 * **The source scan covers it, because that exemption does not reach.** A requirement-gate names a path;
 * a prohibition-gate names a text, and `process.env` means the same thing in every checkout. Splitting
 * the two costs nothing today — the template reads no environment — and buys the one workers config in
 * this tree that becomes a stranger's code: a scaffolded `bindings: { CLOUDFLARE_API_TOKEN: … }` would
 * ship from here and reach *their* account. Applying one exclusion to both walks was reasoning from the
 * gate that had a reason to the gate that did not.
 *
 * The walk is `ci/sourceFiles.ts` — the one every other tripwire in this tree reads it through (#185).
 */

/** The repository root. This file lives at `packages/cli/src/ci/`; the anchor test below proves it. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The one setup file every project loads: a throwaway `PITHY_CONFIG_DIR` per test file. */
const CONFIG_DIR_SETUP = join(REPO_ROOT, "vitest.setup.ts");

/**
 * The setup file every *workers* project loads instead: the credential guard that runs inside workerd.
 *
 * Computed from {@link REPO_ROOT} rather than imported from `vitest.shared.ts`, for the wall
 * {@link EXPECTED_BUDGETS} records below — this package's `rootDir` is its own `src`, and a relative
 * import of a repository-root file fails `bun run typecheck` on TS6059 for every file reached through
 * it. A path is not a policy, so the copy costs nothing here: get it wrong and the assertion goes red.
 */
const WORKERS_ENV_SETUP = join(REPO_ROOT, "vitest.workers.setup.ts");

/** What a workers config is called. The scan below reads all eighteen; seventeen are projects here. */
const WORKERS_CONFIG = "vitest.workers.config.ts";

/**
 * The eighteenth, and the only one that leaves this repository. `pithy init` copies it verbatim into an
 * adopter's tree, so it is scanned rather than exempt — see the templates paragraph at the top. Named
 * here so re-excluding it, or moving it, is a red test rather than a silently narrower scan.
 */
const TEMPLATE_WORKERS_CONFIG = "templates/starter/vitest.workers.config.ts";

/**
 * The workers population as it stands. Both gates below are over a filtered list, and a filter that
 * matched nothing would satisfy either in silence — so each states the real number rather than a floor
 * it is comfortable with. An anti-vacuity guard set below the population is shape 8 of #326's taxonomy:
 * it passes for exactly the broken walk it was written to catch.
 *
 * A floor rather than an equality, because a capability landing with a workers suite raises it and that
 * is not a defect. What is asserted exactly is that the two walks agree with *each other* — this is the
 * count of *projects*, so the scan is held to it plus the template rather than to it.
 */
const WORKERS_PROJECTS = 17;

/**
 * The opt-in that lets a suite resolve the operator's real config directory (`stateDir`, #200). It
 * exists for a suite that means it. A unit config that set it would hand the exemption to everything.
 */
const ALLOW_REAL = "PITHY_ALLOW_REAL_CONFIG_DIR";

/** The plugin that marks a project as running inside workerd rather than on the host. */
const WORKERS_PLUGIN = "@cloudflare/vitest-plugin";

/**
 * The compatibility flag every workers config states, and the reason it is a gate rather than a habit.
 *
 * **It is what makes a declared binding visible in `process.env`, and nothing else was checking it.**
 * Measured on `@pithy-sh/core`: delete this one line, declare
 * `bindings: { CLOUDFLARE_API_TOKEN: "leaked-nocompat" }`, and the whole set goes green — the root
 * guard's `process.env` scan returns `[]`, `envIsolation.workers.test.ts` passes all three of its
 * assertions including the exact key set, and the credential is fully readable from any test through
 * `env` from `cloudflare:test`. Restore the flag against the same binding and the pool refuses to start.
 * One deleted line, one blinded guard, and nothing to see.
 *
 * The root guard now reads the bindings as well, so the leak above is caught either way. This stays
 * because the flag is a fact about the runtime the capabilities are tested on, not only about the
 * guard: without it a suite exercises a workerd the deployed Worker is not, and a new capability's
 * config is written by copying a sibling's — which is exactly how eight of them came to share one wrong
 * compatibility date (#388).
 *
 * `compatibilityDates.test.ts` reads the sibling half of this line for the same population, and for the
 * same reason it reads text: the miniflare options are closed over inside the plugin, so the loaded
 * config object cannot answer.
 */
const NODEJS_COMPAT = "nodejs_compat";

/**
 * The measurement the workers exemption rests on, written down once and resolved below.
 *
 * #433 asserted the key set and then cited the assertion in a comment — which is the same defect one
 * level out. `grep` found this path in prose and nowhere else: no `existsSync`, no import, nothing that
 * runs. Rename or delete the file and the exemption over every workers project in the tree is justified
 * by a citation to nothing, green.
 */
const WORKERD_ENV_EVIDENCE = "packages/core/src/worker/envIsolation.workers.test.ts";

/** The prose that cites it. A move has to move these too, or the reader is sent nowhere. */
const EVIDENCE_CITATIONS = ["CONTRIBUTING.md"];

/** The configs vitest is actually invoked with. A `vitest.workers.config.ts` is reached as a project. */
function isEntryConfig(name: string): boolean {
  return name === "vitest.config.ts" || name === "vitest.integration.config.ts";
}

/** Only what a vitest config states that this file has an opinion about. */
interface TestBlock {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly setupFiles?: unknown;
  readonly projects?: readonly unknown[];
  readonly name?: unknown;
  readonly testTimeout?: unknown;
  readonly hookTimeout?: unknown;
}

/** A loaded config module's default export, narrowed to what is read here. */
interface ConfigShape {
  readonly test?: TestBlock;
  readonly plugins?: unknown;
}

/** One vitest project: the unit vitest runs, and the unit a guard has to be stated on. */
interface Project {
  /** `packages/audit/vitest.config.ts › node`, for a failure message that names the file to edit. */
  readonly label: string;
  /** The directory a relative `setupFiles` entry resolves against. */
  readonly dir: string;
  /** The environment this project's tests see, root and project levels merged as vitest merges them. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Its setup files, absolute. */
  readonly setupFiles: readonly string[];
  /** Whether it runs in workerd, where there is no host environment to reach. */
  readonly workers: boolean;
  /** Whether it is an integration suite, which needs the real account and says so in its file name. */
  readonly integration: boolean;
  /** What it states as its per-case budget, or `undefined` where it states none and takes vitest's. */
  readonly testTimeout: unknown;
  /** What it states as its hook budget. A per-case budget does not cover a hook — that is the trap. */
  readonly hookTimeout: unknown;
}

/** `path` under the repository root, in posix separators — how a failure names a file. */
function named(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

/** An object, or nothing. Every narrowing here goes through this rather than a cast. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A config's `test` block, or an empty one. */
function testBlock(config: ConfigShape | null): TestBlock {
  const block = asRecord(config?.test);
  return block === null ? {} : (block as TestBlock);
}

/** Whether a loaded module declares the workers plugin. Nested arrays are how vite states plugins. */
function usesWorkersPlugin(config: ConfigShape | null): boolean {
  const plugins = config?.plugins;
  if (!Array.isArray(plugins)) return false;
  return plugins.flat(Number.POSITIVE_INFINITY).some((plugin) => asRecord(plugin)?.name === WORKERS_PLUGIN);
}

/** `setupFiles` in either spelling vitest accepts, made absolute against the project's directory. */
function setupFilesOf(block: TestBlock, dir: string): string[] {
  const stated = block.setupFiles;
  const list = typeof stated === "string" ? [stated] : Array.isArray(stated) ? stated : [];
  return list.filter((entry): entry is string => typeof entry === "string").map((entry) => resolveSetup(entry, dir));
}

/** A setup entry as vitest resolves it: absolute already, or relative to the project's root. */
function resolveSetup(entry: string, dir: string): string {
  return isAbsolute(entry) ? entry : resolve(dir, entry);
}

/**
 * A relative `import … from "./x"` or `export … from "./x"`. The only way a config reaches a file in
 * this repository: a bare specifier is a package, and vite externalizes it.
 */
const RELATIVE_IMPORT = /\bfrom\s*["'](\.[^"']*)["']/g;

/** One file the prohibition scan reads, and the config that reached it. `null` for a config itself. */
interface ScanTarget {
  readonly path: string;
  readonly via: string | null;
}

/**
 * A relative specifier as a file on disk, or `null` where nothing resolves — reported, never skipped.
 *
 * Three spellings, which is every one this tree uses: extensionless, explicit `.ts`, and the ESM `.js`
 * that means `.ts` on disk. A fourth would be reported as unresolved rather than skipped, which is a red
 * test asking for this function to learn it — the opposite failure to a scan that quietly walks past.
 */
function resolveImport(specifier: string, from: string): string | null {
  const base = resolve(dirname(from), specifier);
  const candidates = base.endsWith(".ts")
    ? [base]
    : base.endsWith(".js")
      ? [base.replace(/\.js$/, ".ts")]
      : [`${base}.ts`, join(base, "index.ts")];
  return candidates.find((candidate) => readSource(candidate) !== null) ?? null;
}

/**
 * Every repository file a config pulls in, transitively — **derived rather than listed**, which is the
 * whole of #437's third finding.
 *
 * The ban below used to read the eighteen config files and nothing else, while its own docblock rejected
 * a narrower rule "walked around by a helper that reads the environment one call away". A helper one
 * call away is exactly what `../../vitest.shared` is: all seventeen import it, and an
 * `export const HOST_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? ""` added there would be invisible to a
 * file-name-scoped scan and would flow straight into a `bindings` entry.
 *
 * Naming the two modules a config imports today would close it and go stale on the third. So the graph
 * is walked instead: relative specifiers only, transitively, which today reaches `vitest.shared.ts`,
 * `compatibility.ts` and `@pithy-sh/cloudflare`'s `env/devVars` — that last one is bundled into workerd
 * and had a hand-written paragraph asking a reader not to make it read the environment. It has a gate
 * now.
 *
 * **The setup file is deliberately not in this graph, and must not be.** `vitest.shared.ts` reaches
 * `vitest.workers.setup.ts` through `new URL(…)`, which is a path rather than an import — and reading
 * `process.env` is that file's entire job, from inside workerd where it is the thing being checked.
 */
function reachedModules(configs: readonly string[], unresolved: string[]): ScanTarget[] {
  const found: ScanTarget[] = [];
  const seen = new Set(configs);
  const queue = configs.map((config) => ({ file: config, via: named(config) }));
  while (queue.length > 0) {
    const { file, via } = queue.shift() as { file: string; via: string };
    const text = readSource(file);
    if (text === null) continue;
    for (const match of blankComments(text).matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1] as string;
      const target = resolveImport(specifier, file);
      if (target === null) {
        unresolved.push(`${named(file)} imports ${specifier}, which this walk cannot resolve`);
        continue;
      }
      if (seen.has(target)) continue;
      seen.add(target);
      found.push({ path: target, via });
      queue.push({ file: target, via });
    }
  }
  return found;
}

/** Load a config module and hand back its default export. */
async function load(path: string): Promise<ConfigShape | null> {
  const module: unknown = await import(pathToFileURL(path).href);
  const record = asRecord(module);
  return asRecord(record?.default) as ConfigShape | null;
}

/**
 * Every project a config declares.
 *
 * No `projects` means the `test` block *is* the project. A string entry names another config file, which
 * is loaded so its plugins are visible — that is the only way to know a project runs in workerd. An
 * inline entry inherits the root `env` and nothing else, which is what vitest does.
 */
async function projectsOf(path: string): Promise<Project[]> {
  const config = await load(path);
  const root = testBlock(config);
  const dir = dirname(path);
  const integration = path.endsWith("vitest.integration.config.ts");
  const rootEnv = root.env ?? {};

  if (!Array.isArray(root.projects)) {
    return [
      {
        label: named(path),
        dir,
        env: rootEnv,
        setupFiles: setupFilesOf(root, dir),
        workers: usesWorkersPlugin(config),
        integration,
        testTimeout: root.testTimeout,
        hookTimeout: root.hookTimeout,
      },
    ];
  }

  const projects: Project[] = [];
  for (const entry of root.projects) {
    if (typeof entry === "string") {
      const file = resolve(dir, entry);
      const referenced = await load(file);
      const block = testBlock(referenced);
      projects.push({
        label: `${named(path)} › ${named(file)}`,
        dir: dirname(file),
        env: { ...rootEnv, ...(block.env ?? {}) },
        setupFiles: setupFilesOf(block, dirname(file)),
        workers: usesWorkersPlugin(referenced),
        integration,
        testTimeout: block.testTimeout,
        hookTimeout: block.hookTimeout,
      });
      continue;
    }
    const inline = asRecord(entry);
    if (inline === null) continue;
    const block = testBlock(inline as ConfigShape);
    projects.push({
      label: `${named(path)} › ${typeof block.name === "string" ? block.name : "unnamed"}`,
      dir,
      env: { ...rootEnv, ...(block.env ?? {}) },
      setupFiles: setupFilesOf(block, dir),
      workers: usesWorkersPlugin(inline as ConfigShape),
      integration,
      testTimeout: block.testTimeout,
      hookTimeout: block.hookTimeout,
    });
  }
  return projects;
}

let configs: string[] = [];
let projects: Project[] = [];
let workersConfigs: string[] = [];
let ownWorkersConfigs: string[] = [];
let reached: ScanTarget[] = [];
let unresolvedImports: string[] = [];

/**
 * The `templates/` exclusion, and it earns its place on one walk rather than on both. See the templates
 * paragraph at the top for which, and why the other one covers the template instead.
 */
function outsideTemplates(path: string): boolean {
  return relative(REPO_ROOT, path).split(sep)[0] !== "templates";
}

beforeAll(async () => {
  configs = sourcePaths(REPO_ROOT, { keep: isEntryConfig }).filter(outsideTemplates);
  projects = (await Promise.all(configs.map(projectsOf))).flat();
  // Every workers config in the tree; then the ones that are this repository's own projects. The source
  // scan reads the first, the setup-file gate answers for the second, and the two counts differ by the
  // template — asserted below, so a re-exclusion cannot quietly make them the same list again.
  workersConfigs = sourcePaths(REPO_ROOT, { keep: (name) => name === WORKERS_CONFIG });
  ownWorkersConfigs = workersConfigs.filter(outsideTemplates);
  // And every repository module those configs import, transitively — the ban is about what a config
  // can read, and a config reads whatever it imports. See `reachedModules`.
  unresolvedImports = [];
  reached = reachedModules(workersConfigs, unresolvedImports);
}, 60_000);

describe("the walk itself", () => {
  test("this file is where it thinks it is", () => {
    // Every path below is relative to this. A move that broke it would silently gate nothing.
    expect(readSource(join(REPO_ROOT, "package.json"))).toContain('"@pithy-sh/monorepo"');
  });

  test("it finds the configs — a tripwire that matches nothing is not a tripwire", () => {
    // Twenty-one packages plus a tooling package, and six integration configs. A walk that quietly
    // returned nothing would make every assertion below vacuously true, which is the failure mode
    // these gates exist to prevent rather than reproduce.
    expect(configs.length).toBeGreaterThan(20);
    expect(projects.filter((project) => !project.workers).length).toBeGreaterThan(20);
  });

  test("every package that runs tests has a config, so a new one cannot slip past the gates", () => {
    const missing: string[] = [];
    for (const workspace of ["packages", "tooling"]) {
      for (const manifest of sourcePaths(join(REPO_ROOT, workspace), { keep: (name) => name === "package.json" })) {
        // Only a package's own manifest, never one nested inside it.
        if (relative(REPO_ROOT, manifest).split(sep).length !== 3) continue;
        const text = readSource(manifest);
        if (text === null || !/"test"\s*:/.test(text)) continue;
        if (readSource(join(dirname(manifest), "vitest.config.ts")) === null) missing.push(named(manifest));
      }
    }
    expect(missing).toEqual([]);
  });
});

/**
 * **The workers exemption cites evidence, and the citation is resolved.**
 *
 * The exemption above drops two guards over every `*.workers.test.ts` project, and its whole argument
 * is one file measuring workerd's environment from inside. That file was named in a comment here and
 * linked as markdown from `CONTRIBUTING.md`, and neither is a thing that runs. This repository has a
 * gate for exactly that shape — `packages/ui-react/src/seededGates.test.ts` resolves every gate its
 * ledger cites — so the argument gets the same treatment as the count it replaced.
 */
describe("the workers exemption cites evidence that exists", () => {
  test("the measurement it rests on is where it says", () => {
    expect(
      readSource(join(REPO_ROOT, WORKERD_ENV_EVIDENCE)),
      `the workers exemption is justified by ${WORKERD_ENV_EVIDENCE}, which is not there`,
    ).not.toBeNull();
  });

  test("every citation of it names that path", () => {
    for (const citation of EVIDENCE_CITATIONS) {
      const text = readSource(join(REPO_ROOT, citation));
      expect(text, `${citation} cites the workerd measurement and is not there`).not.toBeNull();
      expect(text ?? "", `${citation} sends its reader to a path that is not ${WORKERD_ENV_EVIDENCE}`).toContain(
        WORKERD_ENV_EVIDENCE,
      );
    }
  });
});

/**
 * #437. **Every workers project certifies its own environment, and the set is what is certified.**
 *
 * The exemption above is right about inheritance and says nothing about declaration. A `bindings` entry
 * in a workers config puts a host-computed value into workerd's `process.env` by design — five configs
 * declare `SECRETS_ENCRYPTION_KEYS: devEncryptionKeys()`, which is a key minted for the test and is
 * fine — and the shape one line over is `CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN`, which
 * is #198 walking back in through the exempt door.
 *
 * So the portable half of {@link WORKERD_ENV_EVIDENCE} — no Cloudflare credential is visible from inside
 * workerd, whatever put it there — is a repository-root setup file that all seventeen load, and this is
 * the gate that every one of them does. Read off the loaded config object, like everything else here:
 * a `setupFiles` key shadowed by a second one on the same literal fails exactly like a missing one, and
 * that is the bug #198 was.
 *
 * **The guard throws rather than asserts.** It sits above every `node_modules/` holding vitest, so it
 * can import no bare specifier and has no `expect` — the same wall `vitest.setup.ts` documents. What it
 * gives up is bought back in `@pithy-sh/cloudflare`'s `env/devVars.test.ts`, where the decision it makes
 * is a pure function with four cases.
 *
 * **A third gate, because the first two were both true of an empty file.** A `setupFiles` entry proves the
 * citation, and `readSource` proves the file. Neither proves the file does anything: replacing its body
 * with `export {};` left this suite at 18 passed and `@pithy-sh/core`'s workers project at 169, which is
 * the whole mechanism retired in silence. So the guard now records its scan on `globalThis` and
 * {@link WORKERD_ENV_EVIDENCE} reads the record back **from inside workerd**, which is the strongest
 * place the call can be proven and is not this file.
 *
 * What is left here is the throw, and it is text. The alternative is putting a live credential into a
 * real workers pool to watch a suite die, which is the thing the guard exists to refuse — so the one
 * clause that cannot be exercised is the one asserted by reading. Narrow, and paired: the runtime record
 * says the predicate ran on the real environment, this says a non-empty answer still stops the run.
 *
 * **And a fourth, because the guard's evidence had a compatibility flag under it.** The scan that
 * satisfies all of the above can be blinded by deleting one line from a config: `process.env` carries a
 * declared binding only while `compatibilityFlags: ["nodejs_compat"]` is stated, and without it the
 * whole set goes green over a credential any test can still read through `env` from `cloudflare:test`.
 * The guard reads that `env` too now, so the leak is caught either way — and the flag is gated here as
 * well, because {@link NODEJS_COMPAT} records why it is a fact worth stating in its own right.
 */
describe("every workers project certifies its own environment", () => {
  test("every workers project loads the shared workerd credential guard", () => {
    const without = projects
      .filter((project) => project.workers)
      .filter((project) => !project.setupFiles.includes(WORKERS_ENV_SETUP))
      .map((project) => project.label);
    expect(without).toEqual([]);
  });

  test("the guard they load is where it says", () => {
    // The treatment `WORKERD_ENV_EVIDENCE` gets above, for the same reason: a `setupFiles` entry naming
    // a file that is not there is a path vitest resolves, so a rename would leave seventeen configs
    // citing nothing.
    expect(
      readSource(WORKERS_ENV_SETUP),
      `seventeen workers configs load ${named(WORKERS_ENV_SETUP)}, which is not there`,
    ).not.toBeNull();
  });

  test("and it still refuses what it finds", () => {
    // The clause no runtime can reach without a real credential in a real pool. `WORKERD_ENV_EVIDENCE`
    // proves both scans happened; nothing but the text proves a non-empty answer still ends the run.
    // Read through `code`, so a docblock quoting either line is not mistaken for the line.
    const source = blankComments(readSource(WORKERS_ENV_SETUP) ?? "");
    expect(source, `${named(WORKERS_ENV_SETUP)} no longer scans workerd's environment`).toContain(
      "visibleCredentialKeys(process.env)",
    );
    expect(source, `${named(WORKERS_ENV_SETUP)} no longer scans the bindings themselves`).toContain(
      'from "cloudflare:test"',
    );
    expect(source, `${named(WORKERS_ENV_SETUP)} scans and does not refuse — a report is not a guard`).toMatch(
      /if\s*\(\s*visible\.length\s*>\s*0\s*\)\s*\{\s*throw\b/,
    );
  });

  test("every workers config states nodejs_compat, or the guard reads a shim", () => {
    // `NODEJS_COMPAT` carries the measurement: without the flag a declared credential never reaches
    // `process.env`, and the guard's process scan returns `[]` over a binding any test can read.
    // Watched failing — remove the line from one config and this names it.
    //
    // Over every workers config in the tree, the template included. A flag name is a text rather than
    // a path, so the exemption the template earns from the setup-file gates does not reach it — the
    // same split the source scan below makes, for the same reason. Its own population is pinned there.
    expect(workersConfigs.length).toBeGreaterThan(WORKERS_PROJECTS);
    const without = workersConfigs
      .filter((path) => !blankComments(readSource(path) ?? "").includes(`"${NODEJS_COMPAT}"`))
      .map((path) => `${named(path)} states no ${NODEJS_COMPAT}`);
    expect(without).toEqual([]);
  });

  test("and there are seventeen of them, so a walk that found none cannot pass", () => {
    // Watched failing: point `WORKERS_PLUGIN` at a name no config declares and this goes red at 0
    // while the set assertion above passes over an empty list without a word. That control is the
    // whole reason this test is here.
    expect(projects.filter((project) => project.workers).length).toBeGreaterThanOrEqual(WORKERS_PROJECTS);
  });
});

/**
 * #437, the other half. **No workers config reads the operator's environment.**
 *
 * The guard above cannot close this on its own, and the reason is measured rather than argued. A
 * declaration reading the operator's shell carries nothing on a machine with no token exported — every
 * CI runner — so the guard inside workerd sees an empty environment and a real leak passes on exactly
 * the machine the gate has to be trusted on.
 *
 * **Watched, on one planted config in `@pithy-sh/leaderboard`, and the plant had to be the honest one.**
 * The issue's literal example, `bindings: { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN }`,
 * never reaches workerd at all: miniflare's option schema refuses `undefined` and the pool fails to
 * start. That is loud, and it is a type error rather than a finding — it says "expected string,
 * received undefined" and names no credential. The shape an author writes to get past it is
 * `process.env.CLOUDFLARE_API_TOKEN ?? ""`, and with no token exported that ran **166 tests green**
 * while this scan reported `packages/leaderboard/vitest.workers.config.ts:20 reads process.env`. Blank
 * is unset, so the runtime guard is right to pass it. The declaration is still the defect, and only the
 * text shows it. Two halves of one property, not a belt and braces.
 *
 * **This one reads the text, which is the thing this file is otherwise most suspicious of** (see the
 * docblock at the top). It is defensible because of the direction it runs in: it refuses a forbidden
 * shape rather than certifying a guard is present, so its failure mode is a false green on a clever
 * spelling rather than a false green on an inert guard. The loaded object is not an option here —
 * `@cloudflare/vitest-plugin` exposes `name`, `api`, `configureVitest`, `config`, `resolveId` and
 * `load`, its `api` is `{ setMain }`, and invoking its `config` hook adds `test.server.deps`, `resolve`
 * and `ssr` and no bindings. The miniflare options are closed over inside the plugin. Probed on
 * `@cloudflare/vitest-plugin@1.0.0`; written down so the next reader does not repeat it.
 *
 * **A flat ban, not a `bindings`-shaped one, and the file name is not the boundary either.** No workers
 * config in this tree reads `process.env` at all, so the ban costs nothing today, and a config has no
 * legitimate reason to — everything one needs comes from `../../vitest.shared` and `../../compatibility`.
 * A narrower rule would be walked around by a helper that reads the environment one call away, and for
 * one review this rule had that hole itself: scoped to a file name, it read the eighteen configs and
 * nothing they import, while all seventeen import `vitest.shared.ts`. An
 * `export const HOST_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? ""` there is one call away and lands in
 * a `bindings` entry. So the population is the configs **plus every repository module they reach**,
 * derived by walking the imports rather than listing today's two — see `reachedModules`.
 */
describe("no workers config reads the operator's environment", () => {
  test("not one of them, nor anything they import, and the failure names the line", () => {
    const failures: string[] = [];
    for (const target of [...workersConfigs.map((path) => ({ path, via: null })), ...reached]) {
      const text = readSource(target.path);
      if (text === null) continue;
      const reachedFrom = target.via === null ? "" : `, reached from ${target.via}`;
      blankComments(text)
        .split("\n")
        .forEach((line, index) => {
          if (line.includes("process.env")) {
            failures.push(`${named(target.path)}:${index + 1} reads process.env${reachedFrom}`);
          }
        });
    }
    expect(failures).toEqual([]);
  });

  test("and the import walk resolved everything it found, so nothing escaped it silently", () => {
    // A specifier this resolver cannot follow is a module the scan skipped, and skipping is the failure
    // mode the whole population exists to close. Reported rather than dropped.
    expect(unresolvedImports).toEqual([]);
    // The three it reaches today. A floor plus these names: a walk that quietly stopped following
    // imports would satisfy an empty-list assertion and gate exactly the files it was written for.
    const names = reached.map((target) => named(target.path));
    expect(names).toContain("vitest.shared.ts");
    expect(names).toContain("compatibility.ts");
    expect(names).toContain("packages/cloudflare/src/env/devVars.ts");
  });

  test("the adopter's copy is scanned too — it is the one that stops being ours", () => {
    // `templates/starter/vitest.workers.config.ts` states neither setup gate, because both name a path
    // only this checkout has. This gate names no path: it forbids a text, and a text is checkout-
    // independent. So the exemption that is real for the one is unearned for the other, and the file it
    // would exempt is the single workers config that becomes somebody else's code — where a scaffolded
    // `bindings: { CLOUDFLARE_API_TOKEN: process.env.… }` reaches their account rather than ours.
    expect(workersConfigs.map(named)).toContain(TEMPLATE_WORKERS_CONFIG);
  });

  test("and it read every workers config, so a scan that found none cannot pass", () => {
    // Two independent walks over the same population: this one keys on the file name, the one above
    // keys on the plugin the loaded config declares. Equality is the interesting assertion — a config
    // file no `vitest.config.ts` names is a suite nothing runs and nothing else here would notice.
    // Against `ownWorkersConfigs`, because the plugin walk cannot see the template: it is nobody's
    // project here. The scan's own population is one larger, which the test above pins by name.
    expect(ownWorkersConfigs.length).toBe(projects.filter((project) => project.workers).length);
    expect(ownWorkersConfigs.length).toBeGreaterThanOrEqual(WORKERS_PROJECTS);
    expect(workersConfigs.length).toBe(ownWorkersConfigs.length + 1);
  });
});

/**
 * #200. **No suite resolves the operator's real Pithy config directory.**
 *
 * Stated about every project, unit and integration alike. A live suite needs the real account; it has
 * never needed the directory holding the operator's minted dev master keys.
 *
 * This is the floor, not the fix. `stateDir` refuses to resolve the real directory under vitest at all
 * (`notifier/state.ts`), which is what catches a test that forgets its seam *at the moment of the
 * mistake*. A safe default still lets a test opt back into the real directory by accident; a resolver
 * that refuses cannot. Both, because #200 asked for both and gave the reason.
 */
describe("no suite resolves the operator's real Pithy config directory", () => {
  test("every project loads the shared config-directory setup", () => {
    const without = projects
      .filter((project) => !project.workers)
      .filter((project) => !project.setupFiles.includes(CONFIG_DIR_SETUP))
      .map((project) => project.label);
    expect(without).toEqual([]);
  });

  test("no config hands out the real-directory opt-in", () => {
    // `PITHY_ALLOW_REAL_CONFIG_DIR` is for a suite that means it, stated where a reader of that suite
    // can see it. A config setting it would grant the exemption to every test in the package at once.
    const granted = projects.filter((project) => (project.env[ALLOW_REAL] ?? "").trim().length > 0);
    expect(granted.map((project) => project.label)).toEqual([]);
  });
});

/**
 * #198. **No unit suite can resolve a Cloudflare credential from the ambient environment.**
 *
 * `CLOUDFLARE_ENV_KEYS` is the list, imported rather than restated, so a fifth key is covered by the
 * commit that adds it — and so this gate and the configs it checks cannot drift apart into two lists
 * that agree until they do not.
 *
 * Integration configs are exempt by name: reaching a real account is the whole of what they are for.
 */
describe("no unit suite can resolve a Cloudflare credential", () => {
  test("every unit project blanks every credential key", () => {
    const failures: string[] = [];
    for (const project of projects) {
      if (project.workers || project.integration) continue;
      const unblanked = CLOUDFLARE_ENV_KEYS.filter((key) => project.env[key] !== "");
      if (unblanked.length > 0) failures.push(`${project.label}: ${unblanked.join(", ")}`);
    }
    expect(failures).toEqual([]);
  });

  test("an integration project is left its credentials", () => {
    // The inverse, asserted, because a guard applied everywhere would silently take the live suites
    // offline — and a live suite that resolves nothing skips rather than fails.
    const blanked = projects
      .filter((project) => project.integration)
      .filter((project) => CLOUDFLARE_ENV_KEYS.some((key) => project.env[key] === ""))
      .map((project) => project.label);
    expect(blanked).toEqual([]);
  });
});

/**
 * **Every unit and workers project states both budgets, and none of them takes vitest's (#361).**
 *
 * The defect this refuses is the one that produced #361: twenty-two of twenty-three packages had never
 * written a `testTimeout` or a `hookTimeout`, so they ran on vitest's 5,000ms and 10,000ms — numbers
 * nobody chose, applied to workers suites that spawn workerd and talk to real D1, on a machine whose
 * own `bun run test` starts twenty-three packages at `--concurrency=50%`. Three packages went red on
 * three consecutive full runs, each passing alone straight afterwards.
 *
 * It is gated here rather than left to review for the reason the rest of this file exists: a config is
 * a place to forget, and the packages that forgot were not the ones anybody was looking at. A new
 * capability is scaffolded by copying a sibling's config, so the *next* package to be added inherits
 * whichever one it was copied from — which is exactly how one package came to have a budget and the
 * other twenty-two did not.
 *
 * **Equality, not a floor.** A config free to state any number it liked would drift back to whatever
 * made a red run go away, one package at a time, and that is the re-run habit written into a config.
 * A project that genuinely needs longer states it on the case, where its reader can see it and ask why.
 */
/**
 * The two numbers `UNIT_BUDGETS` states, **spelled here rather than imported, and that is deliberate.**
 *
 * It is not a choice about elegance. `packages/cli/tsconfig.json` sets `rootDir` to this package's
 * `src`, so a relative import of the repository-root `vitest.shared.ts` pulls a file outside that root
 * into the program and `bun run typecheck` fails on TS6059 — for this file and, transitively, for every
 * file reached through it. The same wall is why `vitest.shared.ts` spells `PITHY_OFFLINE_ENV` instead
 * of importing it from the CLI.
 *
 * The copy earns its keep here. A gate that imported the constant would follow it anywhere it went,
 * including down: an edit dropping `testTimeout` back to 5,000 would move both sides at once and stay
 * green, which is the shape of gate #326 was written about. Written out, changing the policy takes two
 * edits, and the second one is a test going red in front of whoever made the first.
 */
const EXPECTED_BUDGETS = { testTimeout: 60_000, hookTimeout: 120_000 } as const;

describe("every unit project states its budgets rather than inheriting vitest's", () => {
  test("both numbers, on every project that is not an integration suite", () => {
    const wrong: string[] = [];
    for (const project of projects) {
      if (project.integration) continue;
      if (project.testTimeout !== EXPECTED_BUDGETS.testTimeout) {
        wrong.push(`${project.label}: testTimeout is ${String(project.testTimeout)}`);
      }
      if (project.hookTimeout !== EXPECTED_BUDGETS.hookTimeout) {
        wrong.push(`${project.label}: hookTimeout is ${String(project.hookTimeout)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("and there are projects to have checked, so a walk that found none cannot pass", () => {
    // The vacuity guard #326 exists for. Every assertion above is over a filtered list, and a filter
    // that matched nothing would satisfy all of them in silence.
    expect(projects.filter((project) => !project.integration).length).toBeGreaterThan(20);
  });

  test("an integration project is left to its own, which answer to the network", () => {
    // The inverse, for the same reason the credential gate asserts it: a rule applied everywhere would
    // quietly cap suites that wait on live Cloudflare, and those budgets are not about this machine.
    const capped = projects
      .filter((project) => project.integration)
      .filter((project) => project.testTimeout === EXPECTED_BUDGETS.testTimeout)
      .map((project) => project.label);
    expect(capped).toEqual([]);
  });
});
