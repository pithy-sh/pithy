// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEV_SECRETS_FILE } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { writeFileAtomic } from "../project/atomic";

/**
 * The guarantee that stands between a minted secret and a commit: **`.dev.secrets.jsonc` is ignored
 * before anything writes a value into it.**
 *
 * The ignore lines ship in `templates/starter/gitignore`, which is applied at `pithy init` — so they
 * exist in projects scaffolded *after* this file landed, and in no others. `pithy add auth` mints a
 * live session-signing secret, and in every project older than that it was minting into a file git
 * would happily commit. `pithy-sh/dashboard` is one of those projects. Minting first and hoping the
 * ignore is there is not a guarantee; checking is.
 *
 * **The temp file counts.** `writeFileAtomic` writes `<path>.tmp` and renames. `.dev.vars.*` covers
 * `.dev.vars`'s sibling and nothing covered this one — and a `.dev.secrets.jsonc.tmp` left behind by a
 * SIGINT holds the full plaintext, which is the #145 leak class exactly.
 *
 * **Conservative on purpose.** A pattern this cannot prove covers the file is treated as if it does
 * not, so the worst case is a redundant line in a `.gitignore` rather than a secret in a repository.
 * Full gitignore semantics are not reimplemented here: literal entries and a simple trailing-`*` glob
 * are recognised, negation is honoured, and last match wins as git specifies.
 */

/** Every path that must be ignored before a dev secret is written — the file, and its atomic-write temp. */
export const DEV_SECRETS_IGNORED = [DEV_SECRETS_FILE, `${DEV_SECRETS_FILE}.tmp`] as const;

/** The header the appended block leads with, so the next reader knows why the lines are there. */
const HEADER = "# pithy dev secrets: plaintext values, and the temp file an atomic write leaves behind.";

/** What {@link ensureDevSecretsIgnored} found, and what it did about it. */
export interface DevSecretsIgnore {
  /** True when every path in {@link DEV_SECRETS_IGNORED} is ignored. The only state a secret may be written in. */
  covered: boolean;
  /** The paths this call added to `.gitignore`. Empty when they were already there. */
  added: string[];
  /** Why the guarantee could not be made, naming exactly what to add by hand. `null` when it holds. */
  reason: string | null;
}

/**
 * Make sure the project's `.gitignore` covers the dev secrets file and its temp sibling, adding the
 * lines when it does not — and answer whether it now does.
 *
 * A project with no `.gitignore` gets one. That is the smallest thing that removes the risk, and a
 * nested `.gitignore` is a normal thing for a project to have; the alternative is refusing to mint in
 * a directory whose repository root we cannot see from here.
 *
 * Never throws. A `.gitignore` that cannot be read or written comes back as `covered: false` with the
 * two lines spelled out, because the caller's answer to that is to write nothing and say so — not to
 * fail the command with a filesystem error.
 */
export async function ensureDevSecretsIgnored(projectDir: string): Promise<DevSecretsIgnore> {
  const path = join(projectDir, ".gitignore");
  const content = await readFile(path, "utf8").catch(() => null);
  if (content === null && (await exists(path))) return refusal();

  const missing = DEV_SECRETS_IGNORED.filter((name) => !ignores(content ?? "", name));
  if (missing.length === 0) return { covered: true, added: [], reason: null };

  const body = content ?? "";
  const separator = body.length === 0 || body.endsWith("\n") ? "" : "\n";
  try {
    await writeFileAtomic(path, `${body}${separator}\n${HEADER}\n${missing.join("\n")}\n`);
  } catch {
    return refusal();
  }
  return { covered: true, added: [...missing], reason: null };
}

/** The one thing to do by hand when this cannot do it. Names both paths — the temp file is the one nobody thinks of. */
function refusal(): DevSecretsIgnore {
  return {
    covered: false,
    added: [],
    reason: `.gitignore could not be updated. Add ${DEV_SECRETS_IGNORED.join(" and ")} to it, then run the command again.`,
  };
}

/** True if anything is at `path`, readable or not — a `.gitignore` that exists and will not open is a refusal. */
function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Whether `content` ignores `name` at the project root. Git's rule: every pattern is considered in
 * order and **the last one that matches decides**, so a later `!pattern` un-ignores what an earlier
 * line ignored.
 */
export function ignores(content: string, name: string): boolean {
  let ignored = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const negated = trimmed.startsWith("!");
    const pattern = negated ? trimmed.slice(1) : trimmed;
    if (!matches(pattern, name)) continue;
    ignored = !negated;
  }
  return ignored;
}

/**
 * Whether one pattern matches `name`, a file sitting at the project root.
 *
 * Two forms are recognised and no more: a literal path, and a prefix glob ending in a single `*`. A
 * pattern this does not understand answers false, which costs a redundant line and never a leaked
 * value. A trailing `/` makes a pattern directory-only, and this file is not a directory.
 */
function matches(pattern: string, name: string): boolean {
  if (pattern.endsWith("/")) return false;
  // A leading `/` anchors a pattern to the directory holding the `.gitignore`, which is where this
  // file lives — so it matches exactly what the unanchored form does here.
  const bare = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  if (bare === name) return true;
  const star = bare.indexOf("*");
  if (star === -1 || star !== bare.length - 1) return false;
  const prefix = bare.slice(0, -1);
  return !prefix.includes("?") && !prefix.includes("[") && name.startsWith(prefix);
}
