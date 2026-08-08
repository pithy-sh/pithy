// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { StatePathOptions } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";
import { ensureScaffoldPath } from "../project/scaffold";
import { discoverWorkers } from "../project/workers";
import { readBootstrapVars } from "./bootstrapVars";
import { encodeDevVarsValue, readDevVarsSource } from "./devVars";
import { tightenMode } from "./mode";

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
 * <config>/<project>/dev.json  vars   machine-local bootstrap values  (./bootstrapVars)
 * <root>/.dev.vars.local              every Worker's override
 * <root>/apps/<w>/.dev.vars.local     that Worker's override — wins
 *         ↓
 * <root>/apps/<w>/.dev.vars           generated, never edited
 * ```
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
  /** The bootstrap set. Defaults to this project's, read from `dev.json`. */
  values?: Record<string, string>;
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
  const bootstrap = options.values ?? (await readBootstrapVars(options.projectDir, options.paths ?? {}));
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
