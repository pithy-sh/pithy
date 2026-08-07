// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEV_SECRETS_FILE, type DevSecretsFile } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { loadDevSecrets } from "@pithy-sh/secrets/src/dev/loadDevSecrets";
import { parse, stringify } from "comment-json";
import { writeFileAtomic } from "../project/atomic";

/**
 * `.dev.secrets.jsonc` as a file on disk — the bytes half of the seam `@pithy-sh/secrets` deliberately
 * left open. That package is Workers-runtime code with no `node:` imports: it parses text and returns
 * what should be written. Reading, writing, the mode, and "absent means no secrets" are the CLI's.
 *
 * **The mode is not a detail.** The file holds OAuth client secrets, Stripe keys, and whatever else a
 * capability needs that cannot be minted. It is written `0600` on creation *and on every rewrite* — see
 * {@link writeFileAtomic}, where the rename is what used to widen it back to the umask default.
 *
 * **Writes merge, they never replace.** The file is hand-edited: comments say where a value came from,
 * and a trailing comma is the residue of deleting a line. So a write re-parses the adopter's own text
 * with `comment-json` and edits *that* tree, rather than stringifying what the loader returned — the
 * loader strips comments, and a write built from it would quietly delete every note in the file.
 *
 * **And a present secret always wins.** Minting over a value that is already there is how a re-run
 * invalidates every live session and breaks every magic link already in an inbox. The merge adds keys
 * and changes none.
 */

/** The `.dev.secrets.jsonc` path for a project root. */
export function devSecretsPath(projectDir: string): string {
  return join(projectDir, DEV_SECRETS_FILE);
}

/**
 * The header a file this command creates leads with. Two lines, because two things are not obvious from
 * the contents: that the file is gitignored, and that the outer object is always the envelope.
 */
const HEADER = `// Local dev secret values. Gitignored. Never committed, never deployed.
// Keys are registry secret names — <capability>-<what>. The registry decides where each one is seeded.
// Every value is a full envelope: { "currentVersion": "1", "versions": { "1": <value> } }.
`;

/**
 * The project's dev secrets, validated. An absent file is `{}` — a project has none until a capability
 * needs one, and that is not a fault. A file that is *there* and malformed is, and comes back as the
 * loader's `ValidationError` naming this project's real path rather than the bare default.
 */
export async function readDevSecrets(projectDir: string): Promise<DevSecretsFile> {
  const path = devSecretsPath(projectDir);
  const source = await readFile(path, "utf8").catch(() => null);
  if (source === null) return {};
  return loadDevSecrets(source, { path });
}

/**
 * Merge `added` into the file body, keeping every comment, and keeping every value already there.
 * Pure — the caller owns the read and the write.
 *
 * Returns the source unchanged when there is nothing to add, so a re-run rewrites no bytes: the file's
 * mtime is what an adopter's editor and `git status` watch, and churning it on every `pithy dev` would
 * make the idempotence the seeder works for invisible.
 */
export function mergeDevSecretsContent(content: string, added: DevSecretsFile): string {
  return mergeDevSecrets(content, added).content;
}

/** The merge, plus the names it actually landed — what {@link writeDevSecrets} reports to its caller. */
function mergeDevSecrets(content: string, added: DevSecretsFile): { content: string; added: string[] } {
  const source = content.trim().length === 0 ? `${HEADER}{}\n` : content;
  const tree = parse(source) as Record<string, unknown> | null;
  // A file whose top level is not an object is the loader's error to raise, with its own actionable
  // message. Anything written here would land inside something that is not a secrets file.
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) return { content, added: [] };

  const names = Object.keys(added).filter((name) => !(name in tree));
  if (names.length === 0) return { content, added: [] };
  for (const name of names) tree[name] = added[name];
  return { content: `${stringify(tree, null, 2)}\n`, added: names };
}

/**
 * Add every secret in `added` that the file does not already carry, and return the names that landed.
 *
 * The return value is the whole point of the call for a caller that reports: `pithy add` says "minted"
 * only for what it actually minted, and says "left as it is" for the rest. Assuming the write happened
 * is how a command claims to have minted a value it did not.
 *
 * Nothing to add writes nothing at all — an empty `.dev.secrets.jsonc` conjured by a no-op `pithy add`
 * would be one more file to explain.
 */
export async function writeDevSecrets(projectDir: string, added: DevSecretsFile): Promise<string[]> {
  if (Object.keys(added).length === 0) return [];
  const path = devSecretsPath(projectDir);
  const content = await readFile(path, "utf8").catch(() => "");
  const merged = mergeDevSecrets(content, added);
  if (merged.added.length === 0) return [];
  await writeFileAtomic(path, merged.content, { mode: 0o600 });
  return merged.added;
}
