// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { errnoOf, writeFileAtomic } from "./atomic";

/**
 * The mode a `.dev.vars` this module *creates* lands with. `pithy init` seeds the project's own at 0600;
 * this is the same rule for every other one — a `.dev.vars.<env>`, or a shared file a checkout has not
 * got yet — because the very next thing written into it is a Cloudflare API token or the master key. The
 * umask is not a permission policy for a credential file. A file already there keeps its own mode.
 */
const DEV_VARS_MODE = 0o600;

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
 * Read a dev-vars file (empty if absent), upsert the keys, and write it back atomically — owner-only when
 * it has to be created, and through the shared file's symlink when `path` is a worker's link at it.
 */
export async function upsertDevVars(path: string, vars: Record<string, string>): Promise<void> {
  const content = await readDevVarsFile(path);
  await writeFileAtomic(path, upsertDevVarsContent(content ?? "", vars), { mode: DEV_VARS_MODE });
}

/** Read a dev-vars file (no-op if absent), remove the keys, and write it back atomically. */
export async function removeDevVars(path: string, keys: string[]): Promise<void> {
  const content = await readDevVarsFile(path);
  if (content === null) return;
  await writeFileAtomic(path, removeDevVarsContent(content, keys), { mode: DEV_VARS_MODE });
}

/**
 * The file's current contents, or `null` — **and `null` means `ENOENT` and nothing else.**
 *
 * Both writers above are read-modify-write over a credential file, so "absent" is the one answer that
 * licenses replacing it. A `catch(() => "")` licensed it for every failure: `EACCES` on a file that
 * plainly exists, `EISDIR`, `ELOOP`, an I/O error — and the atomic write then landed a `.dev.vars`
 * holding **only the keys being upserted**, every other secret in it gone. No attacker is involved, and
 * the file is gitignored, so there is no copy of what it held. `removeDevVars` had the same shape with a
 * quieter failure: it returned early and its caller printed success, telling the adopter a credential
 * was removed while it sat in the file untouched.
 *
 * This is the third data loss on this branch from that one shape, so the read is one function and the
 * distinction is made once. A file we cannot read is not a file we may overwrite.
 */
async function readDevVarsFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ENOENT") return null;
    throw new ConflictError(
      {
        message: `Cannot update ${path}: Pithy could not read what is already in it.`,
        action:
          "Fix the file's permissions, or move it aside, and run the command again. Pithy won't rewrite a credential file it could not read.",
        detail: `${code ?? "unknown error"} while reading ${path}`,
      },
      { cause: err },
    );
  }
}
