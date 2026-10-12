// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { errnoOf } from "../project/atomic";
import { withLinkStandIns } from "../project/linkView";
import { unifiedDiff } from "./lineDiff";
import type { PlanFile } from "./plan";

/**
 * **A dry run that makes the real write, in a copy of the project (#697).**
 *
 * `pithy add` and `pithy ui add` write through a dozen functions — config, bindings, the entry, the seam
 * modules, the package manifests, the solution file — and each has its own idempotency rules. A plan
 * written beside them would be a second implementation of every one, right until the first change to the
 * real path that nobody mirrored. So the dry run does not describe the write. It makes it, here, in a
 * private copy, and the plan is the difference between the copy and the project.
 *
 * **What is copied is what a wiring step reads.** Not `.git`, not `.wrangler`'s local state, not build
 * output, and never a `.dev.vars` file or a `.env` file git does not track: a secret has no business in a
 * temporary directory, and a step that needs one is not a step a dry run runs. A `.env` file the repository
 * tracks is source by the repository's own choice — a front end's build reads `.env.production` — so it is
 * copied, and a dry run builds the bundle the deploy ships. With no repository to ask, none is. `.wrangler/pithy/` is the exception inside `.wrangler`:
 * it holds the config `pithy provision --feature` generates, so a re-run regenerating it plans an edit
 * against the file that is there rather than a creation against nothing. `node_modules` is linked rather
 * than copied, so an installed package reads exactly as it does in the project — and nothing a dry run runs
 * installs.
 *
 * **Build output is a name and the repository's word.** `dist`, `build`, `.next` and the rest are skipped
 * where git ignores them, or where there is no repository to ask. A tracked `src/build/` is source, and is
 * copied.
 *
 * **A path the copy cannot read is never fatal.** A directory the user cannot list, a file they cannot read,
 * a link that leads nowhere: the real run fails on one only if it touches it, and a plan that failed on every
 * one of them would refuse runs that succeed.
 *
 * **A link inside the project stays a link. One that leads out of it to a file is a copy of that file.** The
 * real run writes through such a link — `writeFileAtomic` follows the adopter's link — so the command has to
 * read and edit the file's bytes here too. A snapshot gives it them, in the copy, and a write lands in the
 * snapshot rather than in somebody's real file. The edit is planned at the path the command wrote, with a
 * note that it lands outside the project.
 *
 * **One that leads out of it to a directory is a snapshot of that directory.** The real run reads through
 * such a link and writes through it — a Worker whose `src` lives in a shared checkout bundles from there — so
 * the copy has to hold the bytes too. A link in the copy would carry a write out of it, and that is the one
 * thing this cannot allow; a link that led nowhere failed the dry run where the real run succeeded. So the
 * copy holds a real directory with a copy of the tree, under the same skips as the rest of it, and a link
 * inside that leads further out is a snapshot in turn — or, where it leads somewhere already copied, a link
 * to the copy, which is also what ends a cycle. A write there is planned at the project's path, with a note
 * that it lands outside the project.
 *
 * **A snapshot is a directory, and the guards ask whether a path is a link.** The scaffold gate refuses a
 * link on the way to anything it writes, and the atomic writer refuses a link somebody else owns. Each asks
 * through `project/linkView.ts`, and inside the work every snapshot answers with the `lstat` of the link it
 * stands for — so the dry run refuses exactly where the real run does, and a real run asks plain `lstat`.
 *
 * **One that leads out of it to nothing is a link in the copy too, and it leads nowhere.** It points under a
 * regular file beside the copy, where no write can create a directory, root's included.
 *
 * **A file that cannot be read is in the copy, and cannot be read there either.** It is an empty placeholder
 * with the file's own mode, so a command that reads it fails with the real run's error rather than a missing
 * file's. A directory that cannot be listed is still left out.
 *
 * **A failure inside the copy is reported in the project's terms.** A raw `node:fs` error becomes a
 * `PithyError`, and every mention of the copy in what is thrown is put back to the project's path — the copy
 * is a directory the adopter has never seen and cannot act on.
 */

/** Directory names never copied. `node_modules` is linked instead. */
const SKIPPED_DIRS = new Set([".git", ".wrangler", ".worktrees"]);
/** Directory names that are build output wherever git ignores them, or where there is no git to ask. */
const BUILD_OUTPUT = new Set(["dist", "build", ".next", "coverage", ".turbo", ".cache"]);
/** `.wrangler`, whose one copied child is {@link GENERATED}. */
const WRANGLER = ".wrangler";
/** The generated configs under `.wrangler`: what a feature's provisioning writes, and nothing local. */
const GENERATED = "pithy";
/** A file a secret lives in. */
const SECRET_FILE = /^\.(dev\.vars|env)(\..*)?$/;
/** The `.env` files among them: copied where git tracks one, since a committed file is no secret by the repository's choice. */
const ENV_FILE = /^\.env(\..*)?$/;
const NODE_MODULES = "node_modules";
/** What a read that could not be made says. The path is left out of the copy, and the plan goes on. */
const UNREADABLE = new Set(["EACCES", "EPERM", "ENOENT", "ELOOP", "ENOTDIR"]);

/** The copy, as the work sees it. */
export interface Shadow {
  /** The copy's root. */
  readonly root: string;
  /** Where a path in the project lives in the copy. A path outside the project has no place in it. */
  at(path: string): string;
  /** `text` with every mention of the copy's root put back to the project's, for a sentence or a path. */
  toProject(text: string): string;
  /** Project-relative paths of the links out of the project, to a directory, that the copy holds as snapshots. */
  readonly outside: ReadonlySet<string>;
}

/** What the work returned, and every file it changed. */
export interface ShadowRun<T> {
  result: T;
  /** One entry per file created, edited, or deleted, sorted by path. */
  files: PlanFile[];
  /** What the plan has to say about those files that their entries cannot: an edit that lands outside the project. */
  notes: string[];
}

/** What a copy holds besides its files: the links out of the project it copied, and the files it could not read. */
interface CopiedTree {
  files: Map<string, CopiedFile>;
  /** Project-relative paths of links out of the project, to a file, now a copy of it. */
  linkedOut: Set<string>;
  /** Project-relative paths of links out of the project, to a directory, now a snapshot of it — each with the link's own `lstat`. */
  outside: Map<string, Stats>;
  /** Project-relative paths of files that could not be read, now placeholders, with the stamp each was left with. */
  unreadable: Map<string, string>;
}

const toPosix = (path: string) => path.split(sep).join("/");

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Whether `target` is `root` or inside it. */
function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Run `ask`, and answer `undefined` when the path could not be read rather than throwing. */
async function readable<T>(ask: Promise<T>): Promise<T | undefined> {
  try {
    return await ask;
  } catch (error) {
    if (UNREADABLE.has(errnoOf(error) ?? "")) return undefined;
    throw error;
  }
}

/** Whether git ignores `path`, or `undefined` when there is no repository, or no git, to ask. */
function ignoredByGit(projectDir: string, path: string): Promise<boolean | undefined> {
  return new Promise((done) => {
    execFile("git", ["check-ignore", "-q", "--", path], { cwd: projectDir }, (error) => {
      if (error === null) return done(true);
      done(Reflect.get(error, "code") === 1 ? false : undefined);
    });
  });
}

/**
 * Every `.env*` file git tracks under `projectDir`, as project-relative POSIX paths — empty when there is no
 * repository, or no git, to ask, so with nobody to say a file is committed every one stays a secret.
 */
function trackedEnvFiles(projectDir: string): Promise<Set<string>> {
  return new Promise((done) => {
    execFile(
      "git",
      ["ls-files", "-z", "--", ":(glob)**/.env", ":(glob)**/.env.*"],
      { cwd: projectDir },
      (error, out) => {
        done(error === null ? new Set(String(out).split("\0").filter(Boolean)) : new Set());
      },
    );
  });
}

/** A copied file as it was left: its hash, and the stat that says whether anything has written it since. */
interface CopiedFile {
  sha: string;
  stamp: string;
}

/** What changes when anything writes a file: size, both times, and the inode a rename swaps. */
function stampOf(stats: BigIntStats): string {
  return `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.ino}`;
}

/** The read that could not be made because of who is asking, rather than because nothing is there. */
const DENIED = new Set(["EACCES", "EPERM"]);

/**
 * Copy the project into `shadow`, recording each copied file by its project-relative path. Every file is read
 * once: its bytes are written to the copy and hashed from the same buffer.
 */
async function copyTree(projectDir: string, shadow: string, blocked: string): Promise<CopiedTree> {
  const copied = new Map<string, CopiedFile>();
  const linkedOut = new Set<string>();
  const outside = new Map<string, Stats>();
  const unreadable = new Map<string, string>();
  const projectReal = await realpath(projectDir);
  const trackedEnv = await trackedEnvFiles(projectDir);
  /** Whether a file is copied: anything but a secret, and of the secrets only a `.env*` the repository tracks. */
  const copies = (name: string, at: string) =>
    !SECRET_FILE.test(name) || (ENV_FILE.test(name) && trackedEnv.has(toPosix(at)));
  /** Every directory outside the project copied so far, by its real path, to where its snapshot is in the copy. */
  const snapshots = new Map<string, string>();
  /** List `from` into the copy at `at`, and say whether it could be listed. */
  const walk = async (from: string, at: string): Promise<boolean> => {
    const entries = await readable(readdir(from, { withFileTypes: true }));
    if (entries === undefined) return false;
    await mkdir(join(shadow, at), { recursive: true });
    // In name order, so which of two links to one directory outside becomes its snapshot is the same every run.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const source = join(from, entry.name);
      const path = join(at, entry.name);
      if (entry.name === NODE_MODULES && (entry.isDirectory() || entry.isSymbolicLink())) {
        const real = await readable(realpath(source));
        if (real !== undefined) await symlink(real, join(shadow, path), "junction");
      } else if (entry.isSymbolicLink()) {
        // A secrets file is left out whatever it is: the shared `.dev.vars` a worktree links to included.
        if (!SECRET_FILE.test(entry.name)) await copyLink(source, path);
      } else if (entry.isDirectory()) {
        if (entry.name === WRANGLER) await walkGenerated(source, path);
        else if (!(await skipsDirectory(entry.name, source))) await walk(source, path);
      } else if (entry.isFile() && copies(entry.name, path)) {
        await copyFile(source, path);
      }
    }
    return true;
  };
  /** The snapshot a real path outside the project is already copied into, the deepest one, as a path in the copy. */
  const copiedAt = (real: string): string | undefined => {
    let best: [string, string] | undefined;
    for (const [dir, at] of snapshots) {
      if (within(dir, real) && (best === undefined || dir.length > best[0].length)) best = [dir, at];
    }
    return best === undefined ? undefined : join(best[1], relative(best[0], real));
  };
  /**
   * A link to somewhere the copy holds, as a relative link to it there; one that leads out to a file, as a copy of
   * that file; one that leads out to a directory, as a snapshot of it; any other, as a link under {@link blocked}.
   */
  const copyLink = async (source: string, at: string): Promise<void> => {
    const link = await readable(readlink(source));
    if (link === undefined) return;
    const target = join(shadow, at);
    const pointAt = (inCopy: string) => symlink(relative(dirname(target), join(shadow, inCopy)) || ".", target);
    const lexical = resolve(dirname(source), link);
    if (within(projectDir, lexical)) return pointAt(relative(projectDir, lexical));
    const real = await readable(realpath(source));
    if (real !== undefined) {
      if (within(projectReal, real)) return pointAt(relative(projectReal, real));
      const already = copiedAt(real);
      if (already !== undefined) return pointAt(already);
      const stats = await readable(stat(source));
      if (stats?.isFile() && (await copyFile(source, at))) {
        linkedOut.add(toPosix(at));
        return;
      }
      if (stats?.isDirectory()) {
        snapshots.set(real, at);
        if (await walk(real, at)) {
          outside.set(toPosix(at), await lstat(source));
          return;
        }
        snapshots.delete(real);
      }
    }
    await symlink(join(blocked, at), target);
  };
  /**
   * Copy a file, or the file a link leads to, and say whether it is in the copy. One that is there and refuses the
   * read is copied as an empty placeholder with its own mode, so the read fails in the copy as it fails here.
   */
  const copyFile = async (source: string, at: string): Promise<boolean> => {
    const stats = await readable(stat(source));
    if (stats === undefined) return false;
    const target = join(shadow, at);
    let bytes: Buffer;
    try {
      bytes = await readFile(source);
    } catch (error) {
      const code = errnoOf(error) ?? "";
      if (!UNREADABLE.has(code)) throw error;
      if (!DENIED.has(code)) return false;
      await writeFile(target, "");
      await chmod(target, stats.mode & 0o777);
      unreadable.set(toPosix(at), stampOf(await lstat(target, { bigint: true })));
      return true;
    }
    await writeFile(target, bytes, { mode: stats.mode & 0o777 });
    copied.set(toPosix(at), { sha: sha(bytes), stamp: stampOf(await lstat(target, { bigint: true })) });
    return true;
  };
  const skipsDirectory = async (name: string, path: string): Promise<boolean> => {
    if (SKIPPED_DIRS.has(name)) return true;
    if (!BUILD_OUTPUT.has(name)) return false;
    return (await ignoredByGit(projectDir, path)) ?? true;
  };
  // Only the generated child of a `.wrangler`, and only when it is a real directory.
  const walkGenerated = async (wrangler: string, at: string): Promise<void> => {
    const generated = (await readable(readdir(wrangler, { withFileTypes: true })))?.find(
      (entry) => entry.name === GENERATED && entry.isDirectory(),
    );
    if (generated) await walk(join(wrangler, GENERATED), join(at, GENERATED));
  };
  await walk(projectDir, "");
  return { files: copied, linkedOut, outside, unreadable };
}

/** Every regular file in the copy, by project-relative path, not following links. */
async function filesIn(shadow: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(toPosix(relative(shadow, path)));
    }
  };
  await walk(shadow);
  return found;
}

/** Whether bytes are text a diff can be read in. */
function isText(bytes: Buffer): boolean {
  return !bytes.includes(0);
}

/**
 * The planned entry for one changed file, or `undefined` for an edit that is no change once it is put in the
 * project's terms (#697). Bytes in the copy can differ from the project's only by the copy's own root — a
 * generated config holding an absolute path, regenerated — and that file is the one that is there. Deciding
 * on the raw bytes listed it as an edit, with an empty diff, on every re-run.
 */
function planned(
  path: string,
  action: "create" | "edit",
  before: Buffer | null,
  after: Buffer,
  shadow: Shadow,
): PlanFile | undefined {
  if (!isText(after) || (before !== null && !isText(before))) return { path, action, changes: ["Binary file."] };
  const diff = unifiedDiff(before?.toString("utf8") ?? "", shadow.toProject(after.toString("utf8")));
  if (action === "edit" && diff === "") return undefined;
  return { path, action, changes: [], diff };
}

/** What a raw `node:fs` error was doing, for a sentence: its syscall, or a plain verb. */
function syscallOf(error: unknown): string {
  const syscall: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "syscall") : undefined;
  return typeof syscall === "string" ? syscall : "reach";
}

/** Every string in `value`, through objects and arrays, with `map` applied. */
function mapStrings<T>(value: T, map: (text: string) => string): T {
  if (typeof value === "string") return map(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)])) as T;
  }
  return value;
}

/**
 * `error`, in the project's terms: a `PithyError` keeps its class — and whatever rides beside it, a `fix`
 * included — with every mention of the copy put back; a raw filesystem error becomes a `PithyError` naming the
 * project's path; anything else keeps its class with its message and stack put back.
 */
function inProjectTerms(
  error: unknown,
  toProject: (text: string) => string,
  relativeTo: (path: string) => string,
): unknown {
  if (error instanceof PithyError) {
    Object.assign(error, { payload: mapStrings(error.payload, toProject) });
    error.message = toProject(error.message);
    if (error.stack !== undefined) error.stack = toProject(error.stack);
    return error;
  }
  const code = errnoOf(error);
  const path: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "path") : undefined;
  if (code !== undefined && typeof path === "string" && error instanceof Error) {
    return new InternalError({
      message: `The dry run could not ${syscallOf(error)} ${relativeTo(path)} (${code}).`,
      detail: toProject(error.message),
    });
  }
  if (error instanceof Error) {
    error.message = toProject(error.message);
    if (error.stack !== undefined) error.stack = toProject(error.stack);
  }
  return error;
}

/** What a placeholder rewritten by the work says in place of a diff: there were no bytes to diff against. */
const REWRITTEN_UNREAD = "Rewritten. The file could not be read, so the plan shows no diff.";

/** What lands where, by what the plan does to a file under a link out of the project. */
const LANDS: Record<"create" | "edit" | "delete", string> = {
  create: "The file lands there.",
  edit: "The edit lands there.",
  delete: "The delete lands there.",
};

/** The deepest of `links` that `path` is under, or `undefined`. */
function linkAbove(path: string, links: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const link of links) {
    if (path.startsWith(`${link}/`) && (found === undefined || link.length > found.length)) found = link;
  }
  return found;
}

/** The note for `path`, under `link`, a link to a directory outside the project: where what the plan does to it lands. */
function underLinkNote(path: string, link: string, what: keyof typeof LANDS): string {
  return `${path} is under ${link}, a link to a directory outside the project. ${LANDS[what]}`;
}

/**
 * Run `work` against a private copy of `projectDir`, and plan every file it changed there. The copy is
 * removed afterwards, whether the work finished or threw.
 *
 * `plan: false` is for work whose writes are output rather than the change being planned — a deploy's build —
 * so the copy is not read back, and `files` is empty.
 */
export async function inShadow<T>(
  projectDir: string,
  work: (shadow: Shadow) => Promise<T>,
  options: { plan?: boolean } = {},
): Promise<ShadowRun<T>> {
  // The copy and, beside it, the regular file every link out of the project is pointed under.
  const base = await realpath(await mkdtemp(join(tmpdir(), "pithy-plan-")));
  const root = join(base, "project");
  const blocked = join(base, "outside-the-project");
  const outsideRoots = new Set<string>();
  const shadow: Shadow = {
    root,
    outside: outsideRoots,
    at(path) {
      if (!within(projectDir, path)) {
        throw new InternalError({
          message: "A dry run reached for a file outside the project.",
          detail: `${path} is outside ${projectDir}.`,
        });
      }
      return join(root, relative(projectDir, path));
    },
    toProject: (text) => text.split(root).join(projectDir),
  };
  // In what is thrown, the links that lead nowhere name the project's path too: each mirrors it under `blocked`.
  const thrownToProject = (text: string) => shadow.toProject(text.split(blocked).join(projectDir));
  const relativeTo = (path: string) => {
    for (const copy of [root, blocked]) if (within(copy, path)) return toPosix(relative(copy, path)) || ".";
    return thrownToProject(path);
  };
  try {
    return await runInCopy();
  } catch (error) {
    throw inProjectTerms(error, thrownToProject, relativeTo);
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  /** Copy the project, run the work in the copy, and plan what it changed there. */
  async function runInCopy(): Promise<ShadowRun<T>> {
    await writeFile(blocked, "");
    const { files: original, linkedOut, outside, unreadable } = await copyTree(projectDir, root, blocked);
    for (const path of outside.keys()) outsideRoots.add(path);
    const standIns = new Map([...outside].map(([path, link]) => [join(root, path), link]));
    const result = await withLinkStandIns(standIns, () => work(shadow));
    if (options.plan === false) return { result, files: [], notes: [] };
    const roots = [...outsideRoots].sort();
    let files: PlanFile[] = [];
    const present = new Set<string>();
    for (const path of await filesIn(root)) {
      present.add(path);
      const stamp = stampOf(await lstat(join(root, path), { bigint: true }));
      const locked = unreadable.get(path);
      if (locked !== undefined) {
        // A placeholder has no bytes to diff against. Untouched, it is nothing; rewritten, it is an edit.
        if (stamp !== locked) files.push({ path, action: "edit", changes: [REWRITTEN_UNREAD] });
        continue;
      }
      const before = original.get(path);
      // Read only what something wrote since the copy: an untouched file's stat is the one it was left with.
      if (before !== undefined && stamp === before.stamp) continue;
      const after = await readFile(join(root, path));
      const entry =
        before === undefined
          ? planned(path, "create", null, after, shadow)
          : before.sha === sha(after)
            ? undefined
            : planned(path, "edit", await readFile(join(projectDir, path)), after, shadow);
      if (entry !== undefined) files.push(entry);
    }
    for (const path of [...original.keys(), ...unreadable.keys()]) {
      if (!present.has(path)) files.push({ path, action: "delete", changes: [] });
    }
    // A snapshot that is gone was a link the work removed, and removing a link removes the link and nothing under it.
    const removed = new Set<string>();
    for (const path of roots) {
      if ([...removed].some((gone) => path.startsWith(`${gone}/`))) continue;
      if ((await readable(lstat(join(root, path))))?.isDirectory()) continue;
      removed.add(path);
      files = files.filter((file) => !(file.action === "delete" && file.path.startsWith(`${path}/`)));
      if (!files.some((file) => file.path === path)) files.push({ path, action: "delete", changes: [] });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const kept = roots.filter((path) => ![...removed].some((gone) => path === gone || path.startsWith(`${gone}/`)));
    const notes: string[] = [];
    for (const file of files) {
      const link = linkAbove(file.path, kept);
      if (file.action === "delete" && removed.has(file.path)) {
        notes.push(
          `${file.path} is a link to a directory outside the project. Deleting it deletes the link, never the directory.`,
        );
      } else if (file.action === "edit" && linkedOut.has(file.path)) {
        notes.push(`${file.path} is a link to a file outside the project. The edit lands in that file.`);
      } else if (link !== undefined && file.action !== "move") {
        notes.push(underLinkNote(file.path, link, file.action));
      }
      // Deleting a link to a file deletes the link, never the file it leads to, so it is worth no sentence.
    }
    return { result, files, notes };
  }
}
