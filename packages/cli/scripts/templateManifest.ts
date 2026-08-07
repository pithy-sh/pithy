// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What the published `@pithy-sh/cli` is allowed to carry from the starter template, and where it comes from.
 *
 * Side-effect free, because two scripts need the same answer: `vendorTemplate.ts` copies the allowlist in,
 * `verifyPack.ts` checks the tarball against it. One definition, or the check agrees with the copy by
 * coincidence.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { committedFiles } from "../src/project/templateFiles";

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
 * {@link committedFiles} is the allowlist itself, and it lives in `src/` because `pithy init` reads it
 * too: the packer decides what a published tarball carries, and the scaffold decides what an adopter's
 * new project carries, and both were reading the same directory by different rules. `.dev.vars` got past
 * `files` into the tarball (#145) and past `cp` into an adopter's project (#152) — one defect, two
 * readers, and fixing the packer alone left the worse half open.
 *
 * What is not shared is the answer to "no index". Here it is fatal: a tarball built from a working tree
 * is exactly what the allowlist exists to prevent, so a pack outside a checkout must stop. `pithy init`
 * carries on, because an installed CLI has a vendored copy and no `.git` to ask.
 */
export function templateFiles(source: string): string[] {
  const files = committedFiles(source);
  if (files === null) {
    throw new Error(
      `Could not read the git index at ${source}, or nothing under it is committed. Pack from a checkout, with git available.`,
    );
  }
  return files;
}
