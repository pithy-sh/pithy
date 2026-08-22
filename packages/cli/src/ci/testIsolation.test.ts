// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLOUDFLARE_ENV_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import { beforeAll, describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "./sourceFiles";

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
 * **Workers projects are exempt, and the exemption is structural rather than a judgment.** workerd does
 * not inherit the host environment, so there is no ambient credential to blank and no real home
 * directory to resolve. A guard there would be inert by construction, which is the thing this file
 * exists to refuse. A test under `@cloudflare/vitest-plugin` sees Vite's `import.meta.env` shims and
 * vitest's two pool ids, plus whatever `bindings` its own config declares. No `CLOUDFLARE_API_TOKEN`,
 * no `HOME`.
 *
 * **That is asserted, not probed.** It used to be a sentence here reporting a count taken once on
 * workerd `1.20260730.1`; #433 moved the harness to `1.20260820.1` and the sentence would have gone
 * stale without a word — in the file that justifies dropping a guard, which is the worst place for a
 * fact nothing checks. {@link WORKERD_ENV_EVIDENCE} pins the exact key set from inside workerd, and
 * the citation is resolved below rather than left as prose that rots the same way.
 *
 * **`templates/` is exempt too.** Those files are copied verbatim into an adopter's repository by
 * `pithy init`, where they become the adopter's code and this repository's root does not exist. They are
 * also not a workspace member, so `bun run test` never runs them.
 *
 * The walk is `ci/sourceFiles.ts` — the one every other tripwire in this tree reads it through (#185).
 */

/** The repository root. This file lives at `packages/cli/src/ci/`; the anchor test below proves it. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The one setup file every project loads: a throwaway `PITHY_CONFIG_DIR` per test file. */
const CONFIG_DIR_SETUP = join(REPO_ROOT, "vitest.setup.ts");

/**
 * The opt-in that lets a suite resolve the operator's real config directory (`stateDir`, #200). It
 * exists for a suite that means it. A unit config that set it would hand the exemption to everything.
 */
const ALLOW_REAL = "PITHY_ALLOW_REAL_CONFIG_DIR";

/** The plugin that marks a project as running inside workerd rather than on the host. */
const WORKERS_PLUGIN = "@cloudflare/vitest-plugin";

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

beforeAll(async () => {
  configs = sourcePaths(REPO_ROOT, { keep: isEntryConfig }).filter(
    (path) => relative(REPO_ROOT, path).split(sep)[0] !== "templates",
  );
  projects = (await Promise.all(configs.map(projectsOf))).flat();
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
