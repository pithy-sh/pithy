// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import {
  assertValidProjectName,
  isReservedProjectName,
  kebab,
  RESERVED_TEST_PREFIX,
} from "@pithy-sh/core/src/naming/resource";

export interface ScaffoldOptions {
  /** Directory to scaffold into. Created if missing; must be empty if present. */
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
 * Throw if `targetDir` exists and isn't empty. This is the precondition
 * `pithy init` checks *before* prompting, so a doomed run fails fast instead of
 * after the user answers. A missing directory passes — `scaffoldProject`
 * creates it. `scaffoldProject` re-checks, so the guard holds even called direct.
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
 * The template ships `gitignore` unprefixed (npm strips dotfiles from published packages); it lands as
 * `.gitignore`.
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

  await mkdir(options.targetDir, { recursive: true });
  await ensureEmptyTarget(options.targetDir);

  await cp(templateDir(), options.targetDir, { recursive: true });
  await rename(join(options.targetDir, "gitignore"), join(options.targetDir, ".gitignore"));

  // The template ships its first worker as `apps/<DEFAULT_WORKER>`; rename it when the caller chose
  // another name, so the directory, the deploy name, and the capability namespace all agree.
  const worker = options.worker ?? DEFAULT_WORKER;
  if (!WORKER_NAME.test(worker)) {
    throw new ValidationError({
      message: `Worker name must be kebab-case (got "${worker}").`,
      action: "Use lowercase words joined by hyphens, e.g. api or admin-api.",
    });
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
}
