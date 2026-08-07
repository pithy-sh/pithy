// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The files git has committed under a directory. One question, asked by the packer and by `pithy init`.
 *
 * It lives in `src/` and nothing else does, because that is the only side of the boundary both programs
 * can reach. `packages/cli/tsconfig.json` roots at `src`, so a module under `src` importing
 * `scripts/templateManifest.ts` is `TS6059` — the file is outside the emit root. The other direction
 * costs nothing: `scripts/tsconfig.json` roots one level higher and picks this file up through the
 * import, and **this module imports nothing but `node:child_process` and `node:path`**, so it drags no
 * graph behind it into a program that has no Workers types and must not acquire any.
 *
 * The alternative was two copies with a test asserting they agree, and a copy is what the last four
 * fixes on this branch were each cleaning up.
 */

import { execFileSync } from "node:child_process";
import { sep } from "node:path";

/**
 * The paths git has committed under `dir`, relative to it, sorted — or `null` when there is no index to
 * read: `dir` is not in a checkout, or git is not installed, or nothing under it is tracked.
 *
 * **The allowlist, and it inverts the burden.** An exclusion filter has to predict the next artefact
 * somebody drops in the directory, and nobody predicted `.dev.vars` — the file `pithy add` and
 * `pithy token mint` write `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS` into. It was published
 * straight past `.gitignore` by `files`, and copied straight past it into an adopter's brand-new project
 * by `pithy init`. Reading the index means a file ships because it was committed, reviewed and pushed;
 * anything a working tree happens to hold is invisible.
 *
 * `--cached`, so an untracked or ignored file sitting beside a tracked one is not listed either.
 *
 * `null` rather than a throw, because "no index" is a normal answer to both callers and they answer it
 * differently: a pack must refuse, and a scaffold from an installed package must carry on — the vendored
 * template is a copy of this same allowlist, made when there was an index to read.
 *
 * git's own stderr is discarded. The failure is a value here, not a message: an installed CLI running
 * `pithy init` outside a repository must not print `fatal: not a git repository` at the adopter.
 */
export function committedFiles(dir: string): string[] | null {
  let listed: string;
  try {
    listed = execFileSync("git", ["-C", dir, "ls-files", "-z", "--cached"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const files = listed.split("\0").filter(Boolean).sort();
  return files.length === 0 ? null : files.map((path) => path.split("/").join(sep));
}
