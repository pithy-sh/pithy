// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic";

function detectEol(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Upsert `KEY=value` lines into a `.dev.vars` file body, preserving every other line — comments, blanks,
 * and unrelated keys — and updating a key in place where it already exists. New keys are appended. Pure;
 * the caller owns the file IO. Existing line endings (CRLF or LF) are preserved; empty content defaults to LF.
 */
export function upsertDevVarsContent(content: string, vars: Record<string, string>): string {
  const eol = detectEol(content);
  const updates = new Map(Object.entries(vars));
  const lines = content.length === 0 ? [] : content.replace(/\r?\n$/, "").split(/\r?\n/);
  const written = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trimStart().startsWith("#")) {
      out.push(line);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!updates.has(key)) {
      out.push(line);
      continue;
    }
    // First occurrence of an upserted key: update in place. Any later duplicate of the same key is
    // dropped, so a key never appears twice — otherwise `parseDevVars` (last-wins) would read a stale value.
    if (!written.has(key)) {
      out.push(`${key}=${updates.get(key)}`);
      written.add(key);
    }
  }
  for (const [key, value] of updates) {
    if (!written.has(key)) out.push(`${key}=${value}`);
  }
  return out.length === 0 ? "" : `${out.join(eol)}${eol}`;
}

/** Remove the given `KEY=` lines from a `.dev.vars` file body, leaving everything else untouched. */
export function removeDevVarsContent(content: string, keys: string[]): string {
  const eol = detectEol(content);
  const drop = new Set(keys);
  const lines = content.length === 0 ? [] : content.replace(/\r?\n$/, "").split(/\r?\n/);
  const out = lines.filter((line) => {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trimStart().startsWith("#")) return true;
    return !drop.has(line.slice(0, eq).trim());
  });
  return out.length === 0 ? "" : `${out.join(eol)}${eol}`;
}

/**
 * Read a dev-vars file (no-op if absent), remove the keys, and write it back atomically.
 *
 * **There is deliberately no `upsertDevVars` beside it.** There was, and it was the raw writer: it
 * wrote values unquoted, at whatever path it was handed, and delivered them to no Worker. Every one of
 * its callers had one of those two defects. It is the obvious thing the next producer would reach for,
 * so it is gone — `devSecrets/devVars.ts`'s `writeDevVars` is the one way a value becomes a `.dev.vars`
 * line, and `upsertDevVarsContent` above is the pure half it composes.
 */
export async function removeDevVars(path: string, keys: string[]): Promise<void> {
  const content = await readFile(path, "utf8").catch(() => null);
  if (content === null) return;
  await writeFileAtomic(path, removeDevVarsContent(content, keys));
}
