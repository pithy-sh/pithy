// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What the published `@pithy-sh/cli` is allowed to carry from the starter template, and where it comes from.
 *
 * Side-effect free, because two scripts need the same answer: `vendorTemplate.ts` copies the allowlist in,
 * `verifyPack.ts` checks the tarball against it. One definition, or the check agrees with the copy by
 * coincidence.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/cli`. */
export const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The repo root's starter — the single copy. Present in a checkout, absent in an installed package. */
export const SOURCE = resolve(CLI_DIR, "../../templates/starter");

/** Where `prepack` puts it, and the only path `files` carries. */
export const TEMPLATES_DIR = resolve(CLI_DIR, "templates");

/** The template's path inside the package, and inside the tarball under `package/`. */
export const VENDORED = "templates/starter";

/**
 * The starter's committed files, relative to `source`, sorted. **The allowlist.**
 *
 * The alternative was an exclusion filter, and it is the weaker one: a filter has to predict the next
 * artefact somebody drops in that directory, and nobody predicted `.dev.vars` — the file `pithy add` and
 * `pithy token mint` write `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS` into, which `files`
 * published straight past `.gitignore`. Reading the index inverts the burden: a file ships because it was
 * committed, reviewed and pushed. Anything a working tree happens to hold is invisible to the packer.
 *
 * `--cached`, so an untracked or ignored file sitting beside a tracked one is not listed either.
 */
export function templateFiles(source: string): string[] {
  let listed: string;
  try {
    listed = execFileSync("git", ["-C", source, "ls-files", "-z", "--cached"], { encoding: "utf8" });
  } catch (cause) {
    throw new Error(`Could not read the git index at ${source}. Pack from a checkout, with git available.`, { cause });
  }
  const files = listed.split("\0").filter(Boolean).sort();
  if (files.length === 0) throw new Error(`No committed files under ${source}. Nothing to vendor.`);
  return files;
}
