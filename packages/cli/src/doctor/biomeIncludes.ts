// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { parse } from "comment-json";
import { BIOME_CONFIG_FILES } from "../privacy/consoleGate";
import { readFileOutcome } from "../project/readOptionalFile";
import { workspaceMembers } from "../project/workspaceMembers";

/**
 * **Does the project's Biome config exclude a directory with a pattern Biome also matches above the project?**
 *
 * Biome matches a `files.includes` pattern that starts with `*` against the directories above the project as well
 * as inside it, so such an exclusion excludes every file of a checkout that sits under a directory of that name.
 * `pithy feature create` puts every worktree at `<root>/.worktrees/<issue>-<slug>`, so inside one `"!**\/.worktrees"`
 * excludes every file; `"!**\/dist"` and `"!**\/.wrangler"` do the same to a checkout kept, or checked out by CI,
 * under a `dist` or `.wrangler`. `biome check .` there checks no file and exits 1 with `No files were processed in the
 * specified paths`, which names no pattern and reads as a broken config. The anchored lines the starter
 * writes skip those directories inside the project and nothing above it. The starter's own workspaces are `apps/*`, so
 * it anchors build output to the root and `apps/`; the lines a finding names cover every top-level directory that holds
 * one of this project's workspace members, so a `packages/*` member's `dist` stays excluded too.
 *
 * **It fails the exit.** The fault is established by the project's own file, and the main checkout hides it: there
 * Biome checks every file and passes, so it surfaces only as a worktree's or a CI checkout's lint failing with an error
 * that does not point at it. The remedy is an edit to that file, so it names no command.
 */
export interface BiomeIncludesCheck {
  /** `unanchored` when a config excludes a directory unanchored; `could-not-check` when a config would not read. */
  state: "ok" | "unanchored" | "could-not-check";
  /** One sentence per unanchored pattern, naming the file, the pattern and the lines to write instead. */
  findings: string[];
}

/** The directories the starter excludes, each with whether every workspace member has one of its own. */
const EXCLUDED_DIRECTORIES: ReadonlyMap<string, { perMember: boolean }> = new Map([
  [".worktrees", { perMember: false }],
  ["dist", { perMember: true }],
  [".wrangler", { perMember: true }],
]);

/** An unanchored exclusion: the directory it names, and the anchored lines that exclude it inside the project. */
export interface UnanchoredExclusion {
  directory: string;
  anchored: string[];
}

/**
 * Whether one `files.includes` entry excludes `.worktrees`, `dist` or `.wrangler` through a pattern that starts
 * with `*`, which Biome also matches against the directories above the project; and if so, the lines to write.
 * `memberRoots` are the top-level directories that hold a workspace member: a per-member directory is excluded
 * under each as `<root>/**\/<dir>`, which Biome also matches at `<root>/<dir>`.
 */
export function unanchoredExclusion(pattern: string, memberRoots: readonly string[]): UnanchoredExclusion | null {
  if (!pattern.startsWith("!")) return null;
  const segments = pattern.replace(/^!+/, "").split("/");
  if (!(segments[0] ?? "").startsWith("*")) return null;
  const directory = segments.find((segment) => EXCLUDED_DIRECTORIES.has(segment));
  if (directory === undefined) return null;
  const rest = segments.slice(segments.findIndex((segment) => !segment.startsWith("*"))).join("/");
  const anchored = [`!${rest}`];
  if (EXCLUDED_DIRECTORIES.get(directory)?.perMember && rest.startsWith(directory)) {
    for (const root of memberRoots) anchored.push(`!${root}/**/${rest}`);
  }
  return { directory, anchored };
}

/** Read every Biome config at the project root for an unanchored directory exclusion. Files only. */
export async function checkBiomeIncludes(projectDir: string): Promise<BiomeIncludesCheck> {
  const findings: string[] = [];
  const unreadable: string[] = [];
  const roots = await memberRoots(projectDir);
  for (const file of BIOME_CONFIG_FILES) {
    const read = await readFileOutcome(join(projectDir, file));
    if (read.state === "absent") continue;
    if (read.state !== "read") {
      unreadable.push(`${file} could not be read.`);
      continue;
    }
    let config: unknown;
    try {
      config = parse(read.text);
    } catch {
      unreadable.push(`${file} does not parse.`);
      continue;
    }
    for (const pattern of includesOf(config)) {
      const unanchored = unanchoredExclusion(pattern, roots);
      if (unanchored) findings.push(describeUnanchored(file, pattern, unanchored));
    }
  }
  if (findings.length > 0) return { state: "unanchored", findings };
  if (unreadable.length > 0) return { state: "could-not-check", findings: unreadable };
  return { state: "ok", findings: [] };
}

/** `apps` and the first path segment of every other workspace member, in name order. */
async function memberRoots(projectDir: string): Promise<string[]> {
  const roots = new Set(["apps"]);
  for (const member of await workspaceMembers(projectDir)) {
    const root = member.split("/")[0];
    if (root !== undefined && root !== ".") roots.add(root);
  }
  return [...roots].sort();
}

/** One finding: the file, the pattern, where it excludes every file, and the anchored lines to write. */
function describeUnanchored(file: string, pattern: string, { directory, anchored }: UnanchoredExclusion): string {
  const where =
    directory === ".worktrees"
      ? `in a ${commandName("feature create")} worktree`
      : `in a checkout under a directory named ${directory}`;
  const quoted = anchored.map((line) => `"${line}"`);
  const lines = quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}` : (quoted[0] ?? "");
  return `${file} excludes "${pattern}", which Biome also matches above the project, so ${where} it excludes every file. Write ${lines} instead.`;
}

/** The string entries of a config's `files.includes`, or none. */
function includesOf(config: unknown): string[] {
  if (typeof config !== "object" || config === null) return [];
  const files = (config as Record<string, unknown>).files;
  if (typeof files !== "object" || files === null) return [];
  const includes = (files as Record<string, unknown>).includes;
  return Array.isArray(includes) ? includes.filter((entry): entry is string => typeof entry === "string") : [];
}

/** The remedy line under the findings. */
export const BIOME_INCLUDES_ACTION =
  "Anchor each exclusion to the project: an anchored pattern skips that directory inside the project and nothing above it, so a feature worktree, or a checkout under a directory of the same name, checks its own files.";
