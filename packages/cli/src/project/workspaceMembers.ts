// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readOptionalFile } from "./readOptionalFile";

/**
 * **Every directory the package manager installs from: the project's workspace members.**
 *
 * The globs come from the root `package.json` `workspaces`, as an array or as `{ packages }`, and from
 * `pnpm-workspace.yaml` when there is one. A glob-matched directory is a member when it holds a
 * `package.json`; a `!` glob removes what the others matched. The root and every `apps/*` directory are
 * always members, so a project with no `workspaces` reads exactly those.
 *
 * `node_modules` is never walked, a dot directory is never matched by a wildcard, and a glob that would
 * leave the project matches nothing. Each member appears once: the root as `.`, then the rest as paths
 * relative to it, `/`-separated and in name order.
 */
export async function workspaceMembers(projectDir: string): Promise<string[]> {
  const patterns = [...(await packageJsonPatterns(projectDir)), ...(await pnpmPatterns(projectDir))];
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const segments = segmentsOf(negated ? raw.slice(1) : raw);
    if (segments === null) continue;
    for (const dir of await expand(projectDir, "", segments)) {
      if (negated) excluded.add(dir);
      else if (await isFile(join(projectDir, dir, "package.json"))) included.add(dir);
    }
  }
  for (const dir of excluded) included.delete(dir);
  for (const app of await childDirs(projectDir, "apps")) included.add(`apps/${app}`);
  included.delete("");
  return [".", ...[...included].sort()];
}

/**
 * How a report names a member: an `apps/*` Worker by its directory, any other member by its path. A member
 * directly under the root is `./<dir>`, so it never reads as an `apps/*` Worker's name and two members
 * never share one.
 */
export function memberName(member: string): string {
  const match = /^apps\/([^/]+)$/.exec(member);
  if (match?.[1] !== undefined) return match[1];
  return member.includes("/") ? member : `./${member}`;
}

/** The member a {@link memberName} names, as a path from the project root. */
export function memberPath(name: string): string {
  if (name.startsWith("./")) return name.slice(2);
  return name.includes("/") ? name : `apps/${name}`;
}

/**
 * The `packages` list of a `pnpm-workspace.yaml`, block (indented or at column 0) or flow style, quotes and
 * comments dropped. Only that one key is read, so no YAML parser is needed for it.
 */
export function pnpmWorkspacePatterns(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start === -1) return [];
  const inline = stripComment(lines[start]?.replace(/^packages\s*:/, "") ?? "").trim();
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(unquote)
      .filter((entry) => entry.length > 0);
  }
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const content = stripComment(line);
    if (content.trim() === "") continue;
    const item = /^\s*-\s*(.*)$/.exec(content);
    if (!item) break;
    const entry = unquote(item[1] ?? "");
    if (entry.length > 0) out.push(entry);
  }
  return out;
}

function stripComment(line: string): string {
  return line.replace(/(^|\s)#.*$/, "");
}

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, "$2");
}

async function packageJsonPatterns(projectDir: string): Promise<string[]> {
  const raw = await readOptionalFile(join(projectDir, "package.json"));
  if (raw === null) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  const workspaces = typeof doc === "object" && doc !== null ? (doc as { workspaces?: unknown }).workspaces : undefined;
  const list =
    typeof workspaces === "object" && workspaces !== null && !Array.isArray(workspaces)
      ? (workspaces as { packages?: unknown }).packages
      : workspaces;
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
}

async function pnpmPatterns(projectDir: string): Promise<string[]> {
  const text = await readOptionalFile(join(projectDir, "pnpm-workspace.yaml"));
  return text === null ? [] : pnpmWorkspacePatterns(text);
}

/** A glob's path segments, or `null` for one that is absolute or climbs out of the project. */
function segmentsOf(pattern: string): string[] | null {
  if (pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) return null;
  const segments = pattern.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..") || segments.includes("node_modules")) return null;
  return segments;
}

/** Every directory under `base` that `segments` matches, relative to `projectDir`. */
async function expand(projectDir: string, base: string, segments: readonly string[]): Promise<string[]> {
  const [head, ...rest] = segments;
  if (head === undefined) return [base];
  const child = (name: string) => (base === "" ? name : `${base}/${name}`);
  if (head === "**") {
    const out = await expand(projectDir, base, rest);
    for (const name of await childDirs(projectDir, base)) {
      if (name.startsWith(".")) continue;
      out.push(...(await expand(projectDir, child(name), segments)));
    }
    return out;
  }
  if (!/[*?]/.test(head)) {
    return (await isDir(join(projectDir, base, head))) ? expand(projectDir, child(head), rest) : [];
  }
  const matcher = segmentMatcher(head);
  const out: string[] = [];
  for (const name of await childDirs(projectDir, base)) {
    if (name.startsWith(".") || !matcher.test(name)) continue;
    out.push(...(await expand(projectDir, child(name), rest)));
  }
  return out;
}

function segmentMatcher(segment: string): RegExp {
  let source = "";
  for (const char of segment) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** The real directories directly under `rel`, `node_modules` and symlinks left out. */
async function childDirs(projectDir: string, rel: string): Promise<string[]> {
  try {
    return (await readdir(join(projectDir, rel), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
