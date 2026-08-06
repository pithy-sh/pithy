// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import {
  assertValidProjectName,
  isReservedProjectName,
  kebab,
  RESERVED_TEST_PREFIX,
} from "@pithy-sh/core/src/naming/resource";

export interface ScaffoldOptions {
  /** Directory to scaffold into. Created if missing; must hold none of the paths the template writes. */
  targetDir: string;
  /** Application name, written into package.json and wrangler.jsonc. */
  appName: string;
  /** The first worker's name — it lives at `apps/<worker>/`. Defaults to {@link DEFAULT_WORKER}. */
  worker?: string;
}

/**
 * The starter template directory. Resolved relative to this module — Phase 0
 * runs the CLI from the workspace, where `templates/starter` sits at the repo
 * root; publishing bundles the template into the package (a release concern).
 */
function templateDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..", "templates", "starter");
}

/**
 * Throw if `targetDir` exists and isn't empty.
 *
 * This is the guard for a directory **Pithy owns outright** — `apps/<worker>`, which `scaffoldWorker`
 * creates and fills. Nothing else may already live there, so emptiness is the right question. The
 * project root is the adopter's directory and asks a narrower one: see {@link ensureScaffoldable}.
 */
export async function ensureEmptyTarget(targetDir: string): Promise<void> {
  let existing: string[];
  try {
    existing = await readdir(targetDir);
  } catch {
    return; // missing directory — nothing to clash with
  }
  if (existing.length > 0) {
    throw new ConflictError({
      message: `${targetDir} isn't empty.`,
      action: "Pick an empty directory. Run pithy init again.",
    });
  }
}

/**
 * True if anything is at `path` — including a symlink whose target is gone.
 *
 * `lstat`, not `access`, for the reason {@link blocksDirectory} gives: the link itself is the thing in
 * the way. `access` follows it, so a **dangling** symlink at a template file path answered "does not
 * exist", cleared the gate, and was never named in the refusal — and then `cp` and `stampPackageName`
 * both wrote *through* the link, landing the scaffolded file outside `targetDir` while the run reported
 * success. Node and Bun do not even agree on that copy, which makes it worse rather than narrower: the
 * unit tests and the shipped CLI would answer differently on one input.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True if `path` is anything other than a real directory — a file, or a symlink, even one pointing at a
 * directory. Missing is fine: the scaffold creates it.
 *
 * `lstat`, not `stat`, because the symlink itself is the problem. `cp` refuses to copy a directory onto
 * a symlinked one (`ERR_FS_CP_DIR_TO_NON_DIR`) and `rename` onto one is `ENOTDIR`, so following the link
 * would answer a question nobody asked.
 */
async function blocksDirectory(path: string): Promise<boolean> {
  try {
    return !(await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True unless `path` is missing or an empty directory — the question to ask of a path Pithy takes over
 * outright, the way {@link ensureEmptyTarget} asks it of `apps/<worker>` under `pithy worker add`.
 *
 * Two `try`s, because the two calls fail for opposite reasons. A missing directory is nothing to take
 * over; a directory that cannot be *read* is certainly occupied. The read used to sit outside any `try`
 * at all, so an unreadable `apps/<worker>` threw a raw `node:fs` error straight through the `PithyError`
 * contract this module and `withErrorReporting` both promise — `pithy init --json` printed a stack trace
 * where a CI wrapper parses `{"error":{…}}`.
 */
async function occupied(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isDirectory()) return true;
  } catch {
    return false; // missing — nothing to take over
  }
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return true; // unreadable — not empty as far as anyone can tell, and not ours to take
  }
}

/**
 * Template files that land under a different name, source → target.
 *
 * Two files cannot ship under the name they land as. `gitignore` because npm strips dotfiles from a
 * published package. `biome.template.jsonc` because Biome discovers `biome.jsonc` by name and refuses a
 * nested one inside a repository that already has a root config — shipping it as-is broke *this* repo's
 * own `biome check .`, which is a fair warning about what it would do inside any monorepo that vendored
 * the template.
 */
const RENAMED_ON_LANDING: Record<string, string> = {
  gitignore: ".gitignore",
  "biome.template.jsonc": "biome.jsonc",
};

/**
 * Every path {@link scaffoldProject} writes, relative to the target — walked from the template rather
 * than listed here, so a file added to the starter is covered without anyone remembering to.
 *
 * Files and directories are separated because the two ask different questions. A file that already
 * exists is a clobber. A directory that already exists is fine — `cp` merges into it — but a *file* or a
 * symlink where one belongs kills `mkdir` and `cp` outright, and the gate has to see that before the
 * copy starts rather than halfway through it.
 *
 * Two adjustments, both because the copy is not a straight copy. Each file in {@link RENAMED_ON_LANDING}
 * is checked under **both** names: the copy writes over the shipped name and the rename then moves it
 * away, which destroyed an adopter's own undotted `gitignore` without ever naming it. And the first
 * worker is copied to `apps/api` and *then* renamed, so a run naming another worker also collides on
 * `apps/<worker>`.
 */
async function templatePaths(worker: string): Promise<{ files: string[]; directories: string[] }> {
  const root = templateDir();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const named = entries.map((entry) => ({
    path: relative(root, join(entry.parentPath, entry.name)),
    directory: entry.isDirectory(),
  }));

  const files = named
    .filter((entry) => !entry.directory)
    .flatMap(({ path }) => {
      const landed = RENAMED_ON_LANDING[path];
      return landed ? [path, landed] : [path];
    });
  const directories = named.filter((entry) => entry.directory).map(({ path }) => path);
  if (worker === DEFAULT_WORKER) return { files, directories };

  const from = `apps${sep}${DEFAULT_WORKER}${sep}`;
  const rename = (paths: string[]): string[] =>
    paths.filter((path) => path.startsWith(from)).map((path) => `apps${sep}${worker}${sep}${path.slice(from.length)}`);
  return {
    files: [...files, ...rename(files)],
    directories: [...directories, `apps${sep}${worker}`, ...rename(directories)],
  };
}

/**
 * Throw if the target already holds anything `pithy init` would write, naming what.
 *
 * **Collision, not emptiness.** A directory holding only `.git`, a README, a licence, a CLAUDE.md, or an
 * editor config is not a project — and refusing it meant `pithy init` could not scaffold into a repo the
 * adopter had just cloned, which is how projects normally start. What actually protects them is the
 * narrower question: is anything I am about to write already there. That still refuses to clobber a real
 * project, and stops caring about the rest.
 *
 * **Except where the scaffold moves rather than copies.** Naming a worker other than the default makes
 * `scaffoldProject` rename `apps/api` onto `apps/<worker>`, and a rename is not a merge: it fails on an
 * occupied destination and carries an occupied source wholesale into the new name. So those two paths
 * are held to emptiness, not to collision. Get that wrong and the run dies on a raw `ENOTEMPTY` from
 * `node:fs` — after the copy, with the root half-written, and outside the `PithyError` contract every
 * other refusal here honours.
 *
 * The precondition `pithy init` checks *before* prompting, so a doomed run fails fast instead of after
 * the user answers. A missing directory passes — `scaffoldProject` creates it, and re-checks, so the
 * guard holds even called direct. The worker name is validated first, because every path below is built
 * out of it and an illegal one would send the probe walking outside the project.
 */
export async function ensureScaffoldable(targetDir: string, worker?: string): Promise<void> {
  const name = worker ?? DEFAULT_WORKER;
  assertWorkerName(name);
  const { files, directories } = await templatePaths(name);

  const collisions = new Set<string>();
  for (const path of files) {
    if (await exists(join(targetDir, path))) collisions.add(path);
  }
  for (const path of directories) {
    if (await blocksDirectory(join(targetDir, path))) collisions.add(path);
  }
  if (name !== DEFAULT_WORKER) {
    for (const path of [join("apps", DEFAULT_WORKER), join("apps", name)]) {
      if (await occupied(join(targetDir, path))) collisions.add(path);
    }
  }

  if (collisions.size === 0) return;
  throw new ConflictError({
    message: `${targetDir} already has ${[...collisions].sort().join(", ")}.`,
    action: "Move those aside, or pick a directory without them. Run pithy init again.",
  });
}

/**
 * Refuse a project name inside the reserved test namespace, before anything is written.
 *
 * This is the one place the reservation is enforced. Every provisioned name leads with the project
 * (`<project>-<env>-<thing>`, project verbatim), so a project outside the namespace cannot generate a
 * name inside it — and the debris reaper, which deletes on that prefix alone, can never reach a real
 * project's resources. Every future capability inherits the guarantee for free.
 *
 * **Creation only, never resolution.** The suites are *meant* to run as `pithy-int-test`, so every
 * resolver — `requireProjectName` included — must keep accepting the name. It is only minting a new
 * project under it that is refused.
 *
 * The predicate is {@link isReservedProjectName}, in `@pithy-sh/core` beside the composer, because the
 * comparison it makes is a fact about how names are composed rather than about scaffolding.
 */
function assertNotReserved(appName: string): void {
  if (!isReservedProjectName(appName)) return;
  throw new ValidationError({
    message: `"${RESERVED_TEST_PREFIX}" is reserved — Pithy's integration tests own that name, and their cleanup deletes everything under it.`,
    action: "Pick a project name that doesn't start with pithy-int-. Run pithy init again.",
  });
}

/** The Worker `pithy init` scaffolds first. Every Worker lives in `apps/<name>/`; this is just the default one. */
export const DEFAULT_WORKER = "api";

/**
 * A worker name is a kebab-case directory under `apps/` — the same shape a package name takes.
 *
 * **Deliberately looser than `NAME_SEGMENT`** (`@pithy-sh/core/src/naming/segment`), which every
 * *Cloudflare* name segment answers to: this one allows a leading digit, because `apps/2fa` is a
 * legitimate directory and a legitimate package name. It never leads a composed name — a worker's
 * script name is `<app>-<worker>` and its feature name is `<project>-f<issue>-<slug>-<worker>`, both
 * of which lead with a letter-leading project — so the strict rule would refuse a name that is legal
 * everywhere it is actually used. Divergence on purpose, not a stale copy.
 */
export const WORKER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Refuse a worker name that could not be a directory under `apps/`.
 *
 * Called by {@link ensureScaffoldable} as well as by {@link scaffoldProject}, because the gate builds
 * `apps/<worker>/…` out of the name before anything else has looked at it: `--worker ../../etc` had it
 * probing paths outside the project and reporting the hits back.
 */
function assertWorkerName(worker: string): void {
  if (WORKER_NAME.test(worker)) return;
  throw new ValidationError({
    message: `Worker name must be kebab-case (got "${worker}").`,
    action: "Use lowercase words joined by hyphens, e.g. api or admin-api.",
  });
}

/** Stamp `appName` into a JSON file's `name` field, preserving the rest. */
async function stampPackageName(path: string, name: string): Promise<void> {
  const pkg = JSON.parse(await readFile(path, "utf8")) as { name: string };
  pkg.name = name;
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Copy the starter template into `targetDir` and stamp the app name — the pure logic behind `pithy init`.
 *
 * The scaffold is the `apps/` layout: the root carries project identity and policy (`pithy.config.ts`,
 * `package.json` with the `apps/*` workspace), and the first Worker lives in `apps/api/` with its own
 * `pithy.config.ts`, `wrangler.jsonc`, and `pithy.worker.jsonc`. There is no root Worker — `pithy worker add`
 * is then purely additive, and each Worker's capabilities, bindings, and DO class migrations attach to it.
 *
 * It also carries the project's gates — a root `tsconfig.json` solution file, a split Vitest config, a
 * Biome config, and the `typecheck`/`test`/`lint` scripts that run them. A scaffold that can be deployed
 * but not checked is a scaffold whose adopter builds the checking themselves, every time.
 *
 * Two files land under a different name than they ship as — see {@link RENAMED_ON_LANDING}.
 */
export async function scaffoldProject(options: ScaffoldOptions): Promise<void> {
  // Both name guards run before the directory is created, let alone copied into: a refusal must leave
  // nothing behind. Legality first — an illegal name is not a name, reserved or not.
  //
  // `assertValidProjectName` is here rather than only downstream because the namespaces disagree and the
  // permissive ones come first. A digit-leading project scaffolds, adds capabilities, and provisions real
  // D1, KV, and R2; it is the first host-worker deploy that refuses it, and by then renaming the project —
  // the only fix — orphans everything already created. The one moment it costs nothing is this one.
  assertValidProjectName(options.appName);
  assertNotReserved(options.appName);

  /**
   * The one form of the name that gets written anywhere.
   *
   * `assertValidProjectName` accepts what `kebab` *would* normalize to a legal segment, so `Acme` clears
   * it — and every command that later composes a resource name reads the project back through
   * `requireProjectName`, which kebabs. Stamping the raw string would therefore write a project name no
   * resource carries, and one Cloudflare refuses outright: wrangler rejects `"name": "Acme-api"` at
   * config-parse time ("alphanumeric and lowercase with dashes only"), so an uppercase `--name` scaffolded
   * a project that could not deploy or even run `wrangler dev`.
   *
   * Normalizing here rather than at each stamp is what keeps the config honest: what the adopter reads in
   * `pithy.config.ts` is the exact first segment of every Cloudflare resource this project provisions.
   */
  const project = kebab(options.appName);

  // The template ships its first worker as `apps/<DEFAULT_WORKER>`; rename it when the caller chose
  // another name, so the directory, the deploy name, and the capability namespace all agree. Resolved
  // *before* the collision check, because the check has to know which `apps/<name>` the copy ends at.
  const worker = options.worker ?? DEFAULT_WORKER;
  assertWorkerName(worker);

  await mkdir(options.targetDir, { recursive: true });
  await ensureScaffoldable(options.targetDir, worker);

  await cp(templateDir(), options.targetDir, { recursive: true });
  for (const [shipped, landed] of Object.entries(RENAMED_ON_LANDING)) {
    await rename(join(options.targetDir, shipped), join(options.targetDir, landed));
  }

  const workerDir = join(options.targetDir, "apps", worker);
  if (worker !== DEFAULT_WORKER) {
    await rename(join(options.targetDir, "apps", DEFAULT_WORKER), workerDir);
  }

  await stampPackageName(join(options.targetDir, "package.json"), project);
  await stampPackageName(join(workerDir, "package.json"), `${project}-${worker}`);

  // The project's identity — the prefix every feature resource name derives from.
  const configPath = join(options.targetDir, "pithy.config.ts");
  const config = await readFile(configPath, "utf8");
  // A replacement *function*, not a replacement string, so `$&` and `$1` could never be read as patterns.
  // `project` is kebabed and cannot contain either today; the function stays because it costs nothing and
  // the guard, not the call site, is what makes that true.
  await writeFile(
    configPath,
    config.replace('name: "pithy-app"', () => `name: "${project}"`),
  );

  // Three stamps into the worker's wrangler.jsonc. `name` is the deploy name (project + worker);
  // `PROJECT` is the project alone; `WORKER` is this Worker's own directory name. `PROJECT` and the
  // deploy name are the kebabed form — the string `requireProjectName` hands every command that composes
  // a `<project>-<env>-<thing>` name. A `PROJECT` that differed would attribute the Worker's
  // Images/Stream assets to a project no sweep filters on, and a `name` that differed would not deploy.
  //
  // `WORKER` is keyed off `DEFAULT_WORKER` rather than a literal, because the template ships that name
  // and the directory has just been renamed to `worker` above — a literal here would be two places to
  // change and one of them would be forgotten.
  //
  // `replaceAll`, because `env.<name>.vars` replaces rather than merges, so each placeholder appears once
  // per environment stanza and a first-occurrence replace would leave staging and prod owned by `pithy-app`.
  const wranglerPath = join(workerDir, "wrangler.jsonc");
  const wrangler = await readFile(wranglerPath, "utf8");
  await writeFile(
    wranglerPath,
    wrangler
      .replace('"name": "pithy-app"', () => `"name": "${project}-${worker}"`)
      .replaceAll('"PROJECT": "pithy-app"', () => `"PROJECT": "${project}"`)
      .replaceAll(`"WORKER": "${DEFAULT_WORKER}"`, () => `"WORKER": "${worker}"`),
  );

  await stampWorkerPrograms(options.targetDir, workerDir, worker);
}

/**
 * Point the solution file at the Worker's real directory, and give its build state a name no sibling
 * Worker will take.
 *
 * Both strings name `apps/<DEFAULT_WORKER>` in the template and both would otherwise survive a rename:
 * the root `tsconfig.json` would reference a path that no longer exists — `tsc -b` fails outright on that,
 * so the whole `typecheck` gate would be broken by the one flag that renames the Worker — and every
 * Worker's `tsBuildInfoFile` would resolve to the same file under the project's `dist/`, where two
 * composite programs overwriting each other's state makes incremental builds silently wrong.
 *
 * Keyed off {@link DEFAULT_WORKER} rather than a literal, for the reason the wrangler stamps above are:
 * the template ships that name, and a literal here is a second place to change.
 */
async function stampWorkerPrograms(targetDir: string, workerDir: string, worker: string): Promise<void> {
  const solutionPath = join(targetDir, "tsconfig.json");
  const solution = await readFile(solutionPath, "utf8");
  await writeFile(
    solutionPath,
    solution.replaceAll(`./apps/${DEFAULT_WORKER}/`, () => `./apps/${worker}/`),
  );

  const programPath = join(workerDir, "tsconfig.json");
  const program = await readFile(programPath, "utf8");
  await writeFile(
    programPath,
    program.replaceAll(`/${DEFAULT_WORKER}.server.tsbuildinfo`, () => `/${worker}.server.tsbuildinfo`),
  );
}
