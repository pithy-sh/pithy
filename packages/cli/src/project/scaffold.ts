// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstatSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictError, InternalError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import {
  assertValidProjectName,
  isReservedProjectName,
  kebab,
  RESERVED_TEST_PREFIX,
} from "@pithy-sh/core/src/naming/resource";
import { PACKAGE_NAME, PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { wireFeatureDevVars } from "../feature/devVars";
import { errnoOf } from "./atomic";
import { committedFiles } from "./templateFiles";

export interface ScaffoldOptions {
  /** Directory to scaffold into. Created if missing; must hold none of the paths the template writes. */
  targetDir: string;
  /** Application name, written into package.json and wrangler.jsonc. */
  appName: string;
  /** The first worker's name — it lives at `apps/<worker>/`. Defaults to {@link DEFAULT_WORKER}. */
  worker?: string;
}

/**
 * Where the starter template sits, relative to this module, in the order the two layouts are tried.
 *
 * **The checkout first**, and only when this module really is inside `packages/cli` of a repo root —
 * see {@link workspaceTemplate}. There the repo root's `templates/starter` is the single source of
 * truth, and preferring it means a `packages/cli/templates/starter` left behind by a pack that failed
 * after `prepack` cannot shadow it. That copy is gitignored, so `git status` says nothing while every
 * later run in the checkout scaffolds from a stale template.
 *
 * The package second: `prepack` vendors the starter in, so an installed `@pithy-sh/cli` carries its own
 * copy at `<package>/templates/starter`. That is the layout an adopter has, and the only one they have.
 */
const PACKAGED_LAYOUT = ["..", "..", "templates", "starter"] as const;

/**
 * The repo root's template, or nothing — and *nothing* unless `moduleDir` sits under that root's
 * `packages/cli`.
 *
 * Four levels up from `src/project` is the repo root in a checkout. In an installed package it is
 * `<node_modules>/templates/starter` — a path owned by any dependency called `templates`, an adopter's
 * own or a squatter's, and `pithy init` would have scaffolded the customer's project out of it. The
 * layout check is what makes that unreachable: `node_modules/@pithy-sh/cli/src/project` is not inside
 * `node_modules/packages/cli`, whatever anybody installs.
 */
function workspaceTemplate(moduleDir: string): string | null {
  const root = resolve(moduleDir, "..", "..", "..", "..");
  const within = relative(join(root, "packages", "cli"), moduleDir);
  if (within.length === 0 || within.startsWith("..") || isAbsolute(within)) return null;
  return join(root, "templates", "starter");
}

/**
 * Where the starter came from, and — the part that matters — **which of the two layouts it is**.
 *
 * The layout is the only honest way to tell "git could not answer" from "there is nothing to ask": a
 * checkout's `templates/starter` is tracked and always has an index, and the copy `prepack` vendored into
 * the package never does. {@link templateContents} turns that into two different decisions about the same
 * `null`, and getting it from the resolver means nothing has to guess later.
 */
export interface TemplateSource {
  /** The starter template directory. */
  dir: string;
  /** True for the copy `prepack` vendored into the package — the layout with no `.git` beside it. */
  vendored: boolean;
}

/**
 * The starter template, resolved from `moduleDir`, with the layout it was found in.
 *
 * Exported because the only honest way to test this is against an **extracted tarball**, not against
 * the checkout the test runs in. This resolved the repo-root path and nothing else, which exists only
 * in a workspace: a published CLI shipped no template at all and `pithy init` — the first command an
 * adopter runs — could not work. Every scaffold test stayed green, because each one ran from the
 * checkout where the missing path happened to be there.
 */
export function resolveTemplateSource(moduleDir: string): TemplateSource {
  const here = resolve(moduleDir);
  const workspace = workspaceTemplate(here);
  const candidates: TemplateSource[] = [
    ...(workspace === null ? [] : [{ dir: workspace, vendored: false }]),
    { dir: resolve(here, ...PACKAGED_LAYOUT), vendored: true },
  ];
  // `lstatSync`, not `existsSync`, and the reason is the module's own rule rather than a threat model:
  // this file writes, and a writing module answers "is something at this path" one way — about the path
  // itself. An exception here would be an exception somebody has to remember, and the escape this module
  // exists to stop has five producers because nobody did. `throwIfNoEntry` off, so missing is a value.
  for (const candidate of candidates) {
    if (lstatSync(join(candidate.dir, "package.json"), { throwIfNoEntry: false })) return candidate;
  }
  throw new InternalError({
    message: "This pithy install is missing its starter template.",
    action: "Reinstall @pithy-sh/cli. Report it if a fresh install does the same.",
    detail: `no starter template under ${here} at ${candidates.map((candidate) => candidate.dir).join(" or ")}`,
  });
}

/** {@link resolveTemplateSource}, for the callers that only want the path. */
export function resolveTemplateDir(moduleDir: string): string {
  return resolveTemplateSource(moduleDir).dir;
}

function templateSource(): TemplateSource {
  return resolveTemplateSource(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Every path from `root` (exclusive) down to `target` (inclusive), outermost first.
 *
 * The walk stops at `root` on purpose. `root` is the directory the adopter handed us — a project they may
 * legitimately keep behind a symlink, and not ours to judge. What has to be real is every path *we* invent
 * out of a name below it, because those are the ones an attacker or an accident can aim somewhere else.
 *
 * A `target` outside `root` is a bug at the call site, and it is precisely the bug that would make this
 * walk useless: the loop would climb to the filesystem root having checked nothing anyone meant. So it
 * throws rather than quietly returning a chain nobody asked for.
 */
function descent(root: string, target: string): string[] {
  const within = relative(resolve(root), resolve(target));
  if (within.length === 0) return [];
  if (within.startsWith("..") || isAbsolute(within)) {
    throw new InternalError({
      message: "Pithy tried to scaffold outside the project.",
      action: "Report this — the command should not have built that path.",
      detail: `${target} is not under ${root}`,
    });
  }
  const steps: string[] = [];
  let step = resolve(root);
  for (const segment of within.split(sep)) {
    step = join(step, segment);
    steps.push(step);
  }
  return steps;
}

/**
 * Throw unless every path between `root` and `target` — `target` itself included — is a real directory or
 * missing. **The one answer to "is this path safe to scaffold into", and every gate routes through it.**
 *
 * This escape has had four producers. `ensureScaffoldable`'s `exists` (#111), `ensureEmptyTarget`'s
 * `readdir` (#147), `scaffoldFiles`' `exists` and `renameWorker`'s `exists` (#152) — four hand-rolled
 * predicates over `access` or a following `readdir`, each asking about *the destination of a link* while
 * the caller then wrote to *the link's path*. Each fix landed in one of them and review found the rest. So
 * the rule lives in one function, and `scaffold.test.ts` fails the build if a writing module rolls another.
 *
 * **`lstat`, and the whole chain of it.** `access` and `existsSync` follow links, so a dangling one reads
 * as missing and clears any gate that asks them; `lstat` answers about the path itself. And asking only
 * about `target` is the half-fix #147 shipped — a link at `apps` carries the scaffold out of the project
 * exactly as completely as a link at `apps/<name>`, and `pithy worker add` walked through it.
 *
 * **Missing stops the walk**, because everything below a missing directory is missing too, and creating it
 * is what the scaffold is for.
 *
 * A non-directory in the way is refused here too, rather than left to blow up later: `mkdir`, `cp` and
 * `rename` all die on it with a raw `node:fs` ENOTDIR — outside the `PithyError` contract `withErrorReporting`
 * prints from and `--json` callers parse — and by then the run is usually half-written.
 */
export async function ensureScaffoldPath(root: string, target: string, intent: PathIntent = "write"): Promise<void> {
  for (const step of descent(root, target)) {
    const entry = await lstat(step).catch(() => null);
    if (entry === null) return; // missing, and so is everything below it
    if (entry.isDirectory()) continue;

    const named = relative(root, step);
    throw new ConflictError(
      entry.isSymbolicLink()
        ? {
            message: `${named} is a symlink.`,
            action: THROUGH_A_LINK[intent],
            detail: `refusing to reach ${target} through the symlink at ${step}`,
          }
        : {
            message: `${named} isn't a directory.`,
            action: "Move it aside, or pick another name, and run the command again.",
            detail: `refusing to reach ${target} through the non-directory at ${step}`,
          },
    );
  }
}

/**
 * What the caller is about to do to the path — the only thing the refusals differ by.
 *
 * A delete borrowing the write refusal told the adopter "the files would land outside the project" about a
 * command that was writing nothing, which is the one sentence they would act on and the one that was
 * false. The *rule* is identical for all three, so it stays in one walk; only the sentence moves.
 */
type PathIntent = "write" | "delete" | "move";

/**
 * The sentence each intent gives an adopter who has a link in the way. One line each, and every one of
 * them has to be true of the command that is asking — see {@link PathIntent}.
 */
const THROUGH_A_LINK: Record<PathIntent, string> = {
  write:
    "Pithy won't scaffold through a link — the files would land outside the project. Remove it, or pick another name, and run the command again.",
  delete:
    "Pithy won't delete through a link — the tree removed would be outside the project. Remove the link, or check the name, and run the command again.",
  move: "Pithy won't move through a link — the directory would leave the project, and the files rewritten after the move would land outside it. Remove the link, or check the name, and run the command again.",
};

/**
 * Delete `target` and everything under it — **the one answer to "may this path be removed", and the `rm`
 * is inside it so no caller can route around it.**
 *
 * This escape had two producers and both were deletes: `pithy worker remove` on `apps/<name>` and
 * `pithy remove <capability>` on an ejected `apps/<worker>/capabilities/<cap>`. Reproduced with the real
 * CLI — a symlink at `apps` pointing at a canary directory, and `pithy worker remove board` removed the
 * canary's whole `board/` tree and printed "Done."
 *
 * **The gate is stricter than {@link ensureScaffoldPath}, and it has to be.** Every other producer in this
 * series writes a file somewhere it should not, and recovery is deleting the file; these remove a tree and
 * there is nothing to recover. So two questions are asked rather than one:
 *
 * - Every component between the root and the target is a real directory or missing — the write gate,
 *   unchanged, so a link at `apps` or at `apps/<name>` is refused and named.
 * - **And the path actually lands inside the project.** `ensureScaffoldPath` judges components one at a
 *   time and stops at the first missing one; this asks the kernel where the whole thing resolves to. A
 *   bind mount, a hard-linked directory, and a link swapped in between the walk and the `rm` all end here
 *   instead of in a recursive delete. The root itself is resolved the same way, because a project kept
 *   behind a symlink is the adopter's arrangement and none of our business.
 *
 * **The root is never the target.** A gate that permits deleting the directory it is containing to permits
 * everything, and no command here has any business removing the project.
 *
 * A target that is not there is not a delete: `rm` is `force`, so a caller rolling back a step that never
 * ran gets a clean no-op rather than a refusal it would have to special-case.
 *
 * **And a delete that fails part-way says which part.** See {@link removeFailure}: the `rm` threw a raw
 * `node:fs` errno through the contract, after it had already emptied some of the tree.
 */
export async function removeScaffoldPath(root: string, target: string): Promise<void> {
  await ensureScaffoldPath(root, target, "delete");

  const doomed = await realpath(target).catch(() => null);
  if (doomed === null) return; // nothing there, or it went away under us — either way nothing to remove
  const anchor = await realpath(root).catch(() => null);
  const within = anchor === null ? "" : relative(anchor, doomed);
  if (anchor === null || within.length === 0 || within.startsWith("..") || isAbsolute(within)) {
    throw new ConflictError({
      message: `Refusing to delete ${relative(root, target) || target}: it isn't inside the project.`,
      action: "Check what apps/ points at. If you didn't put it there, treat it as hostile.",
      detail: `${target} resolves to ${doomed}, which is not under ${anchor ?? root}`,
    });
  }

  try {
    await rm(target, { recursive: true, force: true });
  } catch (err) {
    throw await removeFailure(root, target, err);
  }
}

/** How many surviving paths a failed delete names. Enough to see the shape of what is left, not a listing. */
const SURVIVOR_SAMPLE = 5;

/**
 * The error a `rm` that could not finish should have thrown all along.
 *
 * A recursive delete fails part-way for ordinary reasons — a directory the adopter chmod'd, a file another
 * process holds open, a mount that went read-only — and it fails **after** removing whatever it got to
 * first. What escaped here was the raw `node:fs` errno and its stack: outside the `PithyError` contract
 * `withErrorReporting` prints from and `--json` callers parse, so a CI wrapper got unparseable output, and
 * silent about the half-deleted tree, which is the part the adopter has to act on. A worker directory
 * missing its `src/` and still holding its `wrangler.jsonc` is a worse state than the failure, and nothing
 * said it had happened.
 *
 * So the survivors are read back and named. Best effort — this is already the failure path, and a scan that
 * cannot run must not replace the error with its own.
 */
async function removeFailure(root: string, target: string, err: unknown): Promise<PithyError> {
  if (err instanceof PithyError) return err;
  const named = relative(root, target) || target;
  const left = await survivorsOf(target);
  return new InternalError(
    {
      message: `Could not finish deleting ${named}. ${whatSurvived(left)}`,
      action: "Something blocked it — a permission, or a file in use. Clear that and run the command again.",
      // Two errnos when the scan failed too, because they are two different failures and the adopter's
      // copy above deliberately carries neither: the one that stopped the delete, and the one that
      // stopped us finding out what it left.
      detail:
        `${errnoOf(err) ?? "unknown error"} while removing ${target}` +
        (left.state === "unknown" ? `; ${left.reason} while reading it back` : ""),
    },
    { cause: err },
  );
}

/**
 * What a failed delete left behind — **three states, never two.**
 *
 * The bug this shape exists to make unrepresentable: one `null` carried both "the target is gone" and
 * "the scan threw", and {@link whatSurvived} rendered the pair as *"Nothing of it is left"*. An unreadable
 * directory fails the `rm` and fails the scan for the same reason, so the one case where the adopter is
 * told least was the case where the whole tree survived — and they were told the opposite of the truth.
 * An error path that lies is worse than the raw errno it replaced: the adopter reads it, moves on, and
 * the half-deleted worker stays on their disk.
 *
 * `unknown` carries the errno so the failure can say *why* it cannot answer, in `detail` where every
 * other throw-site fact in this module lives.
 */
export type Survivors =
  | { readonly state: "gone" }
  | { readonly state: "left"; readonly paths: readonly string[] }
  | { readonly state: "unknown"; readonly reason: string };

/**
 * Read back what is still under `target`, relative to it.
 *
 * `lstat` first, and it is the whole distinction: only `ENOENT` means gone. Anything else the probe
 * cannot answer — `EACCES`, `ELOOP`, a mount that went away — is `unknown`, and so is a listing that
 * throws. Best effort about *what* is left, never about *whether* something is.
 *
 * A target that is there but not a directory is left with no paths under it: it is still there, which is
 * the fact the adopter acts on.
 *
 * Exported for the test. `gone` needs the target to vanish between the `rm` and this call — a race no
 * suite can stage against a real `rm`, and the only state the old sentence was ever true for.
 */
export async function survivorsOf(target: string): Promise<Survivors> {
  const entry = await lstat(target).catch((err: unknown) => errnoOf(err) ?? "unknown error");
  if (typeof entry === "string") return entry === "ENOENT" ? { state: "gone" } : { state: "unknown", reason: entry };
  if (!entry.isDirectory()) return { state: "left", paths: [] };
  try {
    return { state: "left", paths: (await readdir(target, { recursive: true })).sort() };
  } catch (err) {
    return { state: "unknown", reason: errnoOf(err) ?? "unknown error" };
  }
}

/** The sentence that tells the adopter which half of the tree they are holding. Exported with {@link survivorsOf}. */
export function whatSurvived(left: Survivors): string {
  if (left.state === "gone") return "Nothing of it is left, but the delete did not report finishing.";
  if (left.state === "unknown") return "Pithy could not read it back, so what is left of it is unknown. Check it.";
  if (left.paths.length === 0) return "It is empty, and still there.";
  const rest = left.paths.length - SURVIVOR_SAMPLE;
  const shown = left.paths.slice(0, SURVIVOR_SAMPLE).join(", ");
  const counted = left.paths.length === 1 ? "1 path is" : `${left.paths.length} paths are`;
  return `${counted} still there: ${shown}${rest > 0 ? `, and ${rest} more` : ""}.`;
}

/**
 * Throw unless `targetDir` is missing or a real, empty directory, reached through real directories.
 *
 * This is the guard for a directory **Pithy owns outright** — `apps/<worker>`, which `scaffoldWorker`
 * creates and fills. Nothing else may already live there, so emptiness is the right question. The
 * project root is the adopter's directory and asks a narrower one: see {@link ensureScaffoldable}.
 *
 * Safety is {@link ensureScaffoldPath}'s answer, not this function's, which is the fix #152 asked for:
 * #147 left this gate lstat-ing `apps/<worker>` and nothing above it, so a symlink at `apps` still carried
 * the whole worker outside the project. Emptiness is all that is left here, and {@link occupied} asks it.
 *
 * The gate also has to run *before* anything is created. `addWorker` rolls `apps/<worker>` back on failure,
 * and `rm` unlinks a symlink rather than its destination — so escaped files would have stayed outside the
 * project while the command reported a clean rollback. Refusing first puts that path out of reach, which is
 * why `scaffoldWorker` calls this before its `mkdir` and not after.
 */
export async function ensureEmptyTarget(root: string, targetDir: string): Promise<void> {
  await ensureScaffoldPath(root, targetDir);
  if (!(await occupied(targetDir))) return;
  throw new ConflictError({
    message: `${targetDir} isn't an empty directory.`,
    action: "Move what's there aside, or pick another name, and run the command again.",
  });
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
 *
 * Exported for the same reason {@link ensureScaffoldPath} is: `scaffoldFiles` and `renameWorker` each had
 * their own copy of this over `access`, and each got it wrong. One predicate, one place to get it wrong.
 */
export async function pathExists(path: string): Promise<boolean> {
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
 * True unless `path` is missing or a real, empty directory — the question to ask of a path Pithy takes
 * over outright. {@link ensureEmptyTarget} is that question asked of `apps/<worker>` under
 * `pithy worker add`; `ensureScaffoldable` asks it of the rename source and destination.
 *
 * `lstat` first, and that is the security half: a symlink is not a directory here however empty its
 * destination reads, because the scaffold would write through it and land outside the project.
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
export const RENAMED_ON_LANDING: Record<string, string> = {
  gitignore: ".gitignore",
  "biome.template.jsonc": "biome.jsonc",
};

/**
 * What the starter is allowed to hand an adopter: **its committed files, and the directories holding
 * them** — relative to the template, sorted.
 *
 * The index is the allowlist, for the reason {@link committedFiles} gives. `pithy init` copied the
 * template directory wholesale, so from a checkout it also copied whatever the maintainer's working tree
 * happened to hold — and it held `.dev.vars`, the file `pithy add` and `pithy token mint` write
 * `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS` into. Reproduced: a maintainer's live token in a
 * stranger's brand-new project, mode 0664 because `cp` copies the source's, and `seedDevVars` then found
 * a `.dev.vars` already there and left it alone. `git status` said nothing, because the file is ignored.
 *
 * #145 read the index for the *published tarball* and stopped at the packer. This is the same rule for
 * the other reader of the same directory.
 *
 * **No index is two different facts, and only one of them is safe.** `committedFiles` answers `null` for
 * "this is not a checkout" *and* for "git is not installed", "the repository is broken", "nothing here is
 * tracked yet". #145's fix read them all as the first, so on a real checkout where git failed for any
 * reason at all, `pithy init` went straight back to copying whatever the maintainer's working tree held —
 * `.dev.vars` included — silently, and only on the machines where that is hardest to notice.
 *
 * {@link TemplateSource.vendored} is what tells them apart, and it comes from the layout rather than from
 * a probe: the copy an installed `@pithy-sh/cli` carries was built by `prepack` from this same allowlist
 * and has no `.git` beside it to ask, so it is taken as it stands. A checkout's template is tracked and
 * always has an index — so `null` there means the question failed, and the run refuses rather than
 * guessing. Refusing the vendored case too would break `pithy init` for every adopter to protect a
 * checkout none of them have; excusing the checkout case is how the leak came back.
 *
 * Exported for the test: the branch that matters is the one that only happens on a machine where git is
 * broken, and a suite that runs in a healthy checkout can never reach it any other way.
 */
export async function templateContents(source: TemplateSource): Promise<{ files: string[]; directories: string[] }> {
  const committed = committedFiles(source.dir);
  if (committed !== null) {
    const directories = new Set<string>();
    for (const path of committed) {
      for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) directories.add(parent);
    }
    return { files: committed, directories: [...directories].sort() };
  }

  if (!source.vendored) {
    throw new InternalError({
      message: "Pithy couldn't ask git what the starter template ships.",
      action:
        "Install git and run this from a complete checkout — or install @pithy-sh/cli, which carries its own template. Pithy won't copy the template directory unread.",
      detail: `git listed nothing committed under ${source.dir}, and that path is a checkout's template, not a vendored one`,
    });
  }

  const entries = await readdir(source.dir, { recursive: true, withFileTypes: true });
  const named = entries.map((entry) => ({
    path: relative(source.dir, join(entry.parentPath, entry.name)),
    directory: entry.isDirectory(),
  }));
  return {
    files: named.filter((entry) => !entry.directory).map(({ path }) => path),
    directories: named.filter((entry) => entry.directory).map(({ path }) => path),
  };
}

/**
 * Every path {@link scaffoldProject} writes, relative to the target — read from the template rather
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
 *
 * And one path is added that the template cannot carry. The scaffold links `apps/<worker>/.dev.vars` at
 * the project's shared file, but the template ships only `.dev.vars.example` — so the one path `init`
 * writes that holds secrets was the one path this walk could not see. A pre-existing worker `.dev.vars`
 * was replaced with a link, and since the file is git-ignored there was no copy of it anywhere.
 */
async function templatePaths(worker: string): Promise<{ files: string[]; directories: string[] }> {
  const contents = await templateContents(templateSource());

  const files = contents.files.flatMap((path) => {
    const landed = RENAMED_ON_LANDING[path];
    return landed ? [path, landed] : [path];
  });
  const directories = [...contents.directories];
  files.push(join("apps", worker, ".dev.vars"));
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
 * Copy the starter into `targetDir` — every path {@link templateContents} allows, and no other.
 *
 * The filter is the whole point: `cp` with `recursive` and nothing else copied the directory as it sits
 * on the maintainer's disk. It runs on directories too, and a `false` there skips the subtree, so every
 * ancestor of an allowed file has to be allowed with it — which is what {@link templateContents} returns
 * the second list for.
 *
 * Held to the same allowlist {@link templatePaths} builds the collision gate from, and that is not a
 * coincidence worth leaving to chance: a gate that refuses over a file the copy would never write is a
 * `pithy init` that cannot run in a directory it has no quarrel with.
 */
async function copyTemplate(targetDir: string): Promise<void> {
  const source = templateSource();
  const contents = await templateContents(source);
  const allowed = new Set([...contents.files, ...contents.directories]);
  await cp(source.dir, targetDir, {
    recursive: true,
    filter: (candidate) => {
      const path = relative(source.dir, candidate);
      return path.length === 0 || allowed.has(path);
    },
  });
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
    if (await pathExists(join(targetDir, path))) collisions.add(path);
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

/** The version every package in this workspace carries until Changesets cuts a release. */
const UNPUBLISHED = "0.0.0";

/**
 * The range a scaffolded Worker should declare for the kit at `version` — or **null**, meaning declare
 * nothing at all.
 *
 * This is the {@link https://github.com/pithy-sh/pithy/issues/112 #112} rule, applied to the template.
 * Nothing under `@pithy-sh/*` is published, so a range is a promise the registry cannot keep: the
 * template's `"^0.0.0"` 404s the very first `bun install` a new project runs, before any of the tooling
 * that would have helped gets to run at all. A project consuming the kit from a checkout resolves it
 * from `node_modules` either way — the same reason `pithy ui add` omits `@pithy-sh/vite` — so the
 * absent line costs that project nothing and the failed install costs it everything.
 *
 * **The day the packages publish this inverts, and the same line handles it.** `version` is core's own,
 * stamped by `scripts/stampVersions.ts` from the package.json Changesets rewrites — so the first release
 * makes it real, the range gets written, and a scaffolded project installs the kit from npm with no code
 * change here. `0.0.0` is not a version anyone releases; it is precisely the marker for "not released",
 * which is why the whole rule fits in one comparison.
 */
export function kitRange(version: string): string | null {
  return version === UNPUBLISHED ? null : `^${version}`;
}

/**
 * What to tell an adopter whose freshly written manifest declares no `@pithy-sh/*` dependency — or
 * **null**, meaning there is nothing to say because the range was written.
 *
 * Three commands scaffold a manifest {@link kitRange} can drop a line from, and all three must say the
 * same thing: `pithy init` (the worker's `@pithy-sh/core`), `pithy worker add` (the same), and
 * `pithy ui add` (`@pithy-sh/vite`). Only `init` did. The other two dropped the line and then said
 * "Done." — `worker add` scaffolding a `src/index.ts` that imports a package its `package.json` does not
 * declare, `ui add` following up with "Install the packages: npm install. Then pithy dev.", which
 * installs cleanly and then fails the build on a Vite plugin nothing asked for. A silent gap is worse
 * than a loud one: the adopter meets it as an unresolved import on an unrelated command.
 *
 * One function rather than three literals, because the wording is the contract. Lines rather than a
 * string, so each caller dims and places them itself.
 */
export function unpublishedKitNotice(): string[] | null {
  if (kitRange(PACKAGE_VERSION) !== null) return null;
  return [
    "@pithy-sh/* isn't published yet, so this worker declares no kit dependency.",
    "Link the kit from a checkout, then install.",
  ];
}

/**
 * Stamp the scaffolded Worker's manifest: the package name, and the kit dependency at a range that can
 * actually resolve ({@link kitRange}).
 *
 * One read-modify-write for both, because they are one file — a second pass over it is a second chance to
 * leave it half-stamped.
 *
 * Only core is touched, keyed on the name core reports for itself rather than a literal. Changesets
 * versions these packages independently (`.changeset/config.json` links and fixes nothing), so core's
 * version is a fact about core alone and there is no honest range to invent for a sibling from it.
 * `scaffold.test.ts` holds the template to exactly that: declare a second `@pithy-sh/*` dependency and it
 * fails until this function is taught that package's version.
 */
async function stampWorkerManifest(path: string, name: string): Promise<void> {
  const pkg = JSON.parse(await readFile(path, "utf8")) as { name: string; dependencies?: Record<string, string> };
  pkg.name = name;
  const range = kitRange(PACKAGE_VERSION);
  if (pkg.dependencies && PACKAGE_NAME in pkg.dependencies) {
    if (range === null) delete pkg.dependencies[PACKAGE_NAME];
    else pkg.dependencies[PACKAGE_NAME] = range;
  }
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Give the project the one `.dev.vars` every worker in it shares, seeded from the example the template
 * ships. Kept if one is already there.
 *
 * The seed is what makes the link below possible: `wireFeatureDevVars` points at a file, and at scaffold
 * time there is none — the example says "copy this to `.dev.vars`" and nobody has yet. So the copy is that
 * instruction, carried out. The example is comments only, so a project starts with the same empty set of
 * variables it started with before, reachable from where the runtime looks.
 *
 * A `.dev.vars` already in the target is the adopter's, holds their credentials, and is never a template
 * path — so nothing else in this module would have refused the run over it. It is left exactly as it is.
 * `doctor` reads credentials from that file before a project exists, so arriving with one is a normal way
 * to start; the worker's copy is the opposite case and {@link ensureScaffoldable} refuses the run over it,
 * because there the scaffold writes a link and would otherwise have written it *through* their secrets.
 *
 * **Owner-only from the moment it exists.** `cp` copies the source file's mode, so the project's one
 * credential file landed 0664 whatever the umask said — world-readable, before `pithy add` and
 * `pithy token mint` write `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS` into it. The mode is set
 * on the copy this makes and never on a file that was already there: that one is the adopter's, and its
 * permissions are their decision.
 */
async function seedDevVars(targetDir: string): Promise<void> {
  const path = join(targetDir, ".dev.vars");
  if (await pathExists(path)) return;
  await cp(join(targetDir, ".dev.vars.example"), path);
  await chmod(path, 0o600);
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

  await copyTemplate(options.targetDir);
  for (const [shipped, landed] of Object.entries(RENAMED_ON_LANDING)) {
    await rename(join(options.targetDir, shipped), join(options.targetDir, landed));
  }

  const workerDir = join(options.targetDir, "apps", worker);
  if (worker !== DEFAULT_WORKER) {
    await rename(join(options.targetDir, "apps", DEFAULT_WORKER), workerDir);
  }

  await stampPackageName(join(options.targetDir, "package.json"), project);
  await stampWorkerManifest(join(workerDir, "package.json"), `${project}-${worker}`);

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

  // Point the worker at the project's shared `.dev.vars`, exactly as `pithy worker add` points every
  // worker it creates — one implementation of the convention, called from both places that make a worker.
  // `pithy init` was the one that did not, so a plainly scaffolded project had a root `.dev.vars` the
  // runtime never opened, and every secret `pithy add` mints into it was invisible to the Worker that
  // needs it. Wired here rather than left to the first `pithy add`, because it is a property of the
  // project's layout, not of any capability — and a link that already exists is one nothing has to
  // remember later.
  await seedDevVars(options.targetDir);
  await wireFeatureDevVars({
    mainRoot: options.targetDir,
    worktreePath: options.targetDir,
    workers: [{ name: worker, dir: workerDir }],
  });
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
