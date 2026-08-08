// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { devVarsForRegistry } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { StatePathOptions } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";
import { ensureScaffoldPath } from "../project/scaffold";
import { discoverWorkers } from "../project/workers";
import { readBootstrapVars } from "./bootstrapVars";
import { encodeDevVarsValue, readDevVarsSource } from "./devVars";
import { readDevSecrets } from "./file";
import { resolveDevSecretsFile } from "./location";
import { tightenMode } from "./mode";
import { ownProperties } from "./records";
import { type DevSecretsTarget, devSecretsTargets } from "./targets";

/**
 * `apps/<worker>/.dev.vars` is **generated, one per Worker** — never shared by symlink (#154).
 *
 * wrangler loads a `.dev.vars` from the directory it runs in and merges nothing, so every Worker needs
 * its own. That was solved with one file at the project root and a symlink into each `apps/<worker>/`,
 * and the symlink produced five defects: #137 (`pithy init` never wired it, so every minted secret was
 * unreadable), #139 (a fresh clone has no link and nothing re-makes it), #142 (wiring the link deleted a
 * real file, losing gitignored secrets with no copy anywhere), #146 (an atomic write detached the link
 * into a stale private copy), and a standing policy question about a link an adopter pointed somewhere
 * deliberately. None of the five can happen to a file that is generated: there is no link to wire,
 * dangle, delete, or detach.
 *
 * It is cheap now and would not have been before #153. `.dev.vars` used to carry a dozen entries of three
 * provenances; dev resolves `d1` secrets from the seeded store now, so what is generated is the bootstrap
 * set — the master key, `cf-secrets-store` values, public vars. Two or three lines.
 *
 * ## The sources, in precedence order
 *
 * ```
 * <config>/<project>/dev.json  vars   machine-local values no registry declares  (./bootstrapVars)
 * <config>/<project>/secrets.jsonc    every cf-secrets-store secret the registry declares — wins
 * <root>/.dev.vars.local              every Worker's override
 * <root>/apps/<w>/.dev.vars.local     that Worker's override — wins
 *         ↓
 * <root>/apps/<w>/.dev.vars           generated, never edited
 * ```
 *
 * **The dev secrets file is a source, and that is #179.** It used to reach here one `pithy seed` later,
 * through a copy: the seeder routed a `cf-secrets-store` value into `dev.json` under `vars`, and this
 * read *that*. So the file named "the dev secrets file" and the file a Worker's bindings were built from
 * were two files holding one secret — rotating in `secrets.jsonc` did not reach the Worker until
 * something re-seeded, a removed secret's value stayed in `dev.json` forever (that module said so: "A
 * value is never removed here"), and the header below named a source it did not read.
 *
 * **`dev.json` keeps only what no registry declares.** A Turnstile sitekey is a real machine-local value
 * with no registry entry and belongs there. A name the registry *does* declare is dropped from that half
 * outright, whatever it says — that is what makes deleting a secret from `secrets.jsonc` delete it from
 * every generated file, rather than falling back to a stale copy. `pithy doctor` names each one.
 *
 * **`.dev.vars.local` is for overrides, not for variables.** `wrangler.jsonc`'s `vars` block is where a
 * value that should exist in production belongs — it is committed, reviewed, and deployed with the
 * Worker. A variable placed only in a `.local` file works in dev and is simply absent in production, and
 * that failure lands at deploy, far from the cause. `pithy doctor` names any `.local` key that is neither
 * a registry secret nor declared in `wrangler.jsonc` `vars`: visible, not forbidden, because shadowing a
 * real value for an afternoon is legitimate and common.
 *
 * **Both scopes, and the per-Worker one is not optional.** Generated files legitimately differ per Worker,
 * because a Worker's bindings come from the capabilities *it* composes. An override that can only speak
 * to every Worker at once cannot express "point this one somewhere else".
 *
 * **Nothing here writes `wrangler.jsonc` `vars`, and that is deliberate.** `env.<name>.vars` *replaces*
 * the top-level block rather than merging it, so every environment has to repeat every variable — and a
 * generator that wrote one block would silently drop `ENVIRONMENT` from staging. The one place that reads
 * `vars` — doctor's `.local` check — therefore reads the top level **and** every environment's.
 *
 * ## Two rules that are the whole safety of this file
 *
 * **Never overwrite a file a human wrote.** The generated file opens with {@link GENERATED_MARKER}. A
 * `.dev.vars` without it is the adopter's: the run refuses, names the path, and points at
 * `.dev.vars.local`. It does not overwrite and it does not merge. This is #142's lesson, and that defect
 * has appeared twice in `.dev.vars` handling already — building the check in is cheaper than finding it a
 * third time in a file every adopter has.
 *
 * **Skip the write by comparing content, never mtime.** The header check already has the file in memory,
 * so comparing costs a string equality. mtime is the wrong signal in at least five ways, and one of them
 * is not a file at all: upgrading `@pithy-sh/auth` can add a secret to the registry with nothing in the
 * project changing, so mtime reports fresh while the binding is absent. `git checkout` rewrites mtimes,
 * `cp` and `cp -a` disagree about preserving them, one-second granularity is common on network mounts,
 * and clocks skew on shared filesystems. The saving is a few lines of I/O; there is no mtime comparison
 * anywhere in this module. What the comparison buys is not CPU but watcher churn: wrangler watches
 * `.dev.vars`, and rewriting it identically on every run risks a reload for a file that never changed.
 */

/** The name of the hand-authored override file, at both scopes. Never generated, never written. */
export const DEV_VARS_LOCAL = ".dev.vars.local";

/**
 * The first line of every generated `.dev.vars`, and the only thing that makes overwriting one safe.
 *
 * Written by the generator itself on every write rather than assumed — a marker nothing emits is a
 * marker that eventually goes missing, and the file it protects is the one holding the master key.
 */
export const GENERATED_MARKER = "# Generated by pithy. Do not edit.";

/**
 * The whole header, and **the same bytes for every caller.**
 *
 * It carried the resolved secrets-file path, which one caller passed and another did not — so the two
 * generation passes in a single `pithy dev` produced two different files and rewrote each other, every
 * run, defeating the content comparison this module exists for. A header that varies by caller is a
 * header that churns; a header that varies by machine churns across a shared checkout. Neither path is
 * in it: `pithy doctor` prints both, every run, and that is its job.
 */
export const GENERATED_HEADER = [
  GENERATED_MARKER,
  "# Sources: the dev secrets file and this machine's dev.json. Run pithy doctor for both paths.",
  `# To override a value locally, put it in ${DEV_VARS_LOCAL} — here, or at the project root.`,
];

/** Whether a `.dev.vars` body is one pithy generated — the header, on the first line, exactly. */
export function isGeneratedDevVars(content: string): boolean {
  return content.startsWith(GENERATED_MARKER);
}

/**
 * The bytes of one Worker's `.dev.vars`.
 *
 * Keys are sorted, so two runs of the same state produce the same file and the content comparison below
 * is about the values rather than about iteration order. Every value goes through
 * {@link encodeDevVarsValue}, which verifies its quoting against wrangler's own dotenv parser and ours
 * before accepting it — a value no form survives is refused by name rather than written and misread.
 */
export function renderDevVars(values: Record<string, string>): string {
  const lines = [...GENERATED_HEADER, ""];
  const refused: string[] = [];
  for (const name of Object.keys(values).sort()) {
    const value = values[name];
    if (value === undefined) continue;
    const encoded = encodeDevVarsValue(name, value);
    if (encoded.encoded === null) {
      if (encoded.refused !== null) refused.push(encoded.refused);
      continue;
    }
    lines.push(`${name}=${encoded.encoded}`);
  }
  for (const reason of refused) lines.push(`# ${reason}`);
  return `${lines.join("\n")}\n`;
}

/** What {@link generateDevVars} needs. Every seam defaults to the real project. */
export interface GenerateDevVarsOptions {
  /** The project root — owner of `apps/`, of the root `.dev.vars.local`, and of the project's name. */
  projectDir: string;
  /** The Worker directories to generate into. Defaults to every discovered Worker with a `wrangler.jsonc`. */
  workerDirs?: string[];
  /** Where the Pithy config directory is. Defaults to the real one; a seam so a test reads its own. */
  paths?: StatePathOptions;
  /**
   * The whole value set, bypassing both sources. A seam for a test that has no project on disk — the
   * real callers pass nothing, because a caller that assembled these itself would be the second answer
   * to which files a Worker's bindings come from.
   */
  values?: Record<string, string>;
  /**
   * The Workers whose registries decide which secrets are materialised. Defaults to every one composing
   * `secrets`. A seam, and the one `pithy add` uses to hand over a freshly-reloaded composition.
   */
  targets?: DevSecretsTarget[];
}

/** What one generation run did. Every list is sorted, so two runs of the same state read the same. */
export interface GenerateDevVarsResult {
  /** Worker directories whose `.dev.vars` this run wrote. */
  generated: string[];
  /** Worker directories whose `.dev.vars` already held exactly these bytes. Not rewritten, not touched. */
  unchanged: string[];
  /**
   * One sentence per Worker directory nothing was written into, and why — a `.dev.vars` pithy did not
   * generate, or a directory this project may not write into (#167). Actionable, never a value. A caller
   * for which generating *was* the point of the run exits non-zero on a non-empty list.
   */
  refused: string[];
  /**
   * Worker directories whose `.dev.vars` was a symlink from the old shared-file design, replaced with a
   * generated file. A link holds no content, so nothing was lost — but which secrets a Worker runs with
   * did change, so it is never silent.
   */
  relinked: string[];
  /** The variable names the generated files carry, sorted. Names only — never a value, anywhere. */
  names: string[];
}

/**
 * Generate every Worker's `.dev.vars`. The engine behind `pithy dev` and `pithy seed`.
 *
 * Idempotent by comparison rather than by convergence: a run that changes nothing writes no bytes, so the
 * file's mtime is unchanged and wrangler's watcher has nothing to react to. That is the same rule #149's
 * seeder follows — compare the stored value rather than re-encrypt — and it belongs here for the same
 * reason.
 */
export async function generateDevVars(options: GenerateDevVarsOptions): Promise<GenerateDevVarsResult> {
  const bootstrap = options.values ?? (await devVarsSources(options));
  const rootLocal = await readLocalOverrides(options.projectDir);
  const dirs = options.workerDirs ?? (await workerDirs(options.projectDir));

  const generated: string[] = [];
  const unchanged: string[] = [];
  const refused: string[] = [];
  const relinked: string[] = [];
  const names = new Set<string>();

  for (const dir of dirs) {
    // The directory, gated before anything is written into it (#167). `discoverWorkers` builds
    // `apps/<name>` out of a `readdir` that follows whatever `apps` is, so a symlink at either put a file
    // holding the project's master key somewhere outside the project. Reported rather than thrown: this
    // runs inside `pithy dev`, and one planted link in a directory no Worker of theirs owns must not stop
    // every other Worker from getting its bindings.
    const gate = await ensureScaffoldPath(options.projectDir, dir).then(() => null, refusalOf);
    if (gate !== null) {
      refused.push(`${dir}: no .dev.vars was generated. ${gate}`);
      continue;
    }

    // Worker-scoped overrides win over the root's, which win over the bootstrap set. One merge, so the
    // precedence is stated once and the file's line order (sorted) carries no meaning of its own.
    const values = { ...bootstrap, ...rootLocal, ...(await readLocalOverrides(dir)) };
    for (const name of Object.keys(values)) names.add(name);
    const content = renderDevVars(values);
    const path = join(dir, ".dev.vars");

    // A symlink is the old design's own artefact — nothing but pithy ever made one here — and it holds no
    // content, so removing it loses nothing. The file it pointed at is untouched and still on disk.
    const entry = await lstat(path).catch(() => null);
    if (entry?.isSymbolicLink()) {
      await unlink(path);
      relinked.push(dir);
    } else {
      const existing = await readDevVarsSource(path);
      if (existing !== null && !isGeneratedDevVars(existing)) {
        refused.push(
          `${path} was not generated by pithy, so nothing was written to it. Keep local values in ${join(dir, DEV_VARS_LOCAL)} — pithy merges that file in and never rewrites it.`,
        );
        continue;
      }
      // Content, never mtime. The header check above already read the file, so this is a string equality.
      if (existing === content) {
        unchanged.push(dir);
        await tightenMode(path);
        continue;
      }
    }

    // Reported, never thrown. A directory that vanished between discovery and here, a read-only mount, a
    // full disk — each is one Worker without its bindings, and `pithy dev` has to start the others and
    // say which one it could not write. A throw would leave every note unprinted and the session dead
    // over a directory no Worker of theirs may even own.
    const failure = await writeFileAtomic(path, content, { mode: 0o600 }).then(() => null, refusalOf);
    if (failure !== null) {
      refused.push(`${path} could not be written, so that Worker has no bindings. ${failure}`);
      continue;
    }
    // Unconditionally and after the write, the same rule the secrets file follows: a file another tool
    // created at the umask holds the master key at 0644 until something narrows it. Narrowing only.
    await tightenMode(path);
    generated.push(dir);
  }

  return {
    generated: generated.sort(),
    unchanged: unchanged.sort(),
    refused: refused.sort(),
    relinked: relinked.sort(),
    names: [...names].sort(),
  };
}

/**
 * The two machine-local sources, merged: `dev.json`'s `vars` for what no registry declares, and every
 * `cf-secrets-store` secret `secrets.jsonc` states.
 *
 * **The registry decides membership of both halves, and that is the whole point.** A name it declares is
 * materialised from `secrets.jsonc` or not at all; a name it does not declare can only come from
 * `dev.json`. So there is exactly one file per value and no precedence question to get wrong — and
 * deleting a secret from `secrets.jsonc` deletes it from every generated file rather than falling back
 * to the copy the old seeder left behind.
 *
 * **Never throws.** This runs inside `pithy dev`. A project with no name to key a config directory on, a
 * `secrets.jsonc` that will not parse, a Worker whose config will not import — each costs the bindings it
 * would have contributed and is reported by `pithy seed` and `pithy doctor`, which are the commands whose
 * job it is to say so. Stopping every Worker in the project over one of them is the worse answer.
 */
async function devVarsSources(options: GenerateDevVarsOptions): Promise<Record<string, string>> {
  const paths = options.paths ?? {};
  const targets = options.targets ?? (await devSecretsTargets(options.projectDir).catch(() => []));
  const registry: SecretRegistry = ownProperties(
    Object.assign({}, ...targets.map((target) => target.registry)) as SecretRegistry,
  );
  const secrets = await materialisedSecrets(options.projectDir, registry, paths);

  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(await readBootstrapVars(options.projectDir, paths))) {
    // A registry name is the secrets file's to answer, whatever `dev.json` still holds. This is the line
    // that makes a removal take effect.
    if (Object.hasOwn(registry, name)) continue;
    values[name] = value;
  }
  return { ...values, ...secrets };
}

/** Every `cf-secrets-store` secret this project states, as `.dev.vars` values. Empty on any failure. */
async function materialisedSecrets(
  projectDir: string,
  registry: SecretRegistry,
  paths: StatePathOptions,
): Promise<Record<string, string>> {
  if (Object.keys(registry).length === 0) return {};
  try {
    const path = await resolveDevSecretsFile(projectDir, paths);
    return devVarsForRegistry(await readDevSecrets(path), registry, path);
  } catch {
    return {};
  }
}

/**
 * One directory's `.dev.vars.local`, parsed. Empty when there is none, which is the ordinary state.
 *
 * Read with `parseDevVars` — pithy's own reader — because these values are merged and re-encoded before
 * they reach wrangler. The encoding a Worker actually receives is decided by {@link renderDevVars}.
 */
export async function readLocalOverrides(dir: string): Promise<Record<string, string>> {
  const source = await readDevVarsSource(join(dir, DEV_VARS_LOCAL));
  return source === null ? {} : parseDevVars(source);
}

/**
 * A gate refusal as one sentence. `PithyError`'s `action` is where the whole answer lives — "Remove it, or
 * pick another name" — and `Error.message` alone names the problem and not the fix. `detail` is never
 * included: it is throw-site context, and these lines reach a terminal.
 */
function refusalOf(error: unknown): string {
  if (error instanceof PithyError) return `${error.payload.message} ${error.payload.action ?? ""}`.trim();
  return error instanceof Error ? error.message : String(error);
}

/** Every Worker directory wrangler will run in — the ones with a `wrangler.jsonc` to load `.dev.vars` beside. */
async function workerDirs(projectDir: string): Promise<string[]> {
  const workers = await discoverWorkers(projectDir).catch(() => []);
  return workers.filter((worker) => worker.hasWrangler !== false).map((worker) => worker.dir);
}
