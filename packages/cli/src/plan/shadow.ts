// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
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
 * **What is copied is what a wiring step reads.** Not `.git`, not build output, not `.wrangler`'s local
 * state, and never a `.dev.vars` or `.env` file: a secret has no business in a temporary directory, and a
 * step that needs one is not a step a dry run runs. `node_modules` is linked rather than copied, so an
 * installed package reads exactly as it does in the project — and nothing a dry run runs installs.
 *
 * **A link inside the project stays a link; one that leads out of it is not copied.** A write through it
 * would land outside the copy, in somebody's real files, and that is the one thing this cannot allow.
 */

/** Directory names never copied. `node_modules` is linked instead. */
const SKIPPED_DIRS = new Set([".git", ".wrangler", ".turbo", "dist", ".worktrees"]);
/** A file a secret lives in. */
const SECRET_FILE = /^\.(dev\.vars|env)(\..*)?$/;
const NODE_MODULES = "node_modules";

/** The copy, as the work sees it. */
export interface Shadow {
  /** The copy's root. */
  readonly root: string;
  /** Where a path in the project lives in the copy. A path outside the project has no place in it. */
  at(path: string): string;
  /** `text` with every mention of the copy's root put back to the project's, for a sentence or a path. */
  toProject(text: string): string;
}

/** What the work returned, and every file it changed. */
export interface ShadowRun<T> {
  result: T;
  /** One entry per file created, edited, or deleted, sorted by path. */
  files: PlanFile[];
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

/** Copy the project into `shadow`, recording each copied file's hash by its project-relative path. */
async function copyTree(projectDir: string, shadow: string): Promise<Map<string, string>> {
  const copied = new Map<string, string>();
  const walk = async (from: string): Promise<void> => {
    const to = join(shadow, relative(projectDir, from));
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.name === NODE_MODULES && (entry.isDirectory() || entry.isSymbolicLink())) {
        await symlink(await realpath(source), target, "junction");
      } else if (entry.isSymbolicLink()) {
        const link = await readlink(source);
        const resolved = resolve(dirname(source), link);
        if (!isAbsolute(link) && within(projectDir, resolved)) await symlink(link, target);
      } else if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(source);
      } else if (entry.isFile() && !SECRET_FILE.test(entry.name)) {
        await copyFile(source, target);
        copied.set(toPosix(relative(projectDir, source)), sha(await readFile(source)));
      }
    }
  };
  await walk(projectDir);
  return copied;
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

/**
 * Run `work` against a private copy of `projectDir`, and plan every file it changed there. The copy is
 * removed afterwards, whether the work finished or threw.
 */
export async function inShadow<T>(projectDir: string, work: (shadow: Shadow) => Promise<T>): Promise<ShadowRun<T>> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pithy-plan-")));
  const shadow: Shadow = {
    root,
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
  try {
    const original = await copyTree(projectDir, root);
    const result = await work(shadow);
    const files: PlanFile[] = [];
    const present = new Set<string>();
    for (const path of await filesIn(root)) {
      present.add(path);
      const after = await readFile(join(root, path));
      const before = original.get(path);
      const entry =
        before === undefined
          ? planned(path, "create", null, after, shadow)
          : before === sha(after)
            ? undefined
            : planned(path, "edit", await readFile(join(projectDir, path)), after, shadow);
      if (entry !== undefined) files.push(entry);
    }
    for (const path of original.keys()) {
      if (!present.has(path)) files.push({ path, action: "delete", changes: [] });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { result, files };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
