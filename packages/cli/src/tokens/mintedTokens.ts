// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { devSecretsDir } from "../devSecrets/location";
import { ensureOwnerOnlyDirFor, tightenMode } from "../devSecrets/mode";
import type { StatePathOptions } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";
import { readOptionalFile } from "../project/readOptionalFile";

/**
 * Where `pithy token mint --store dev-vars` puts a minted token: `<config>/<project>/tokens.json`,
 * keyed by environment, mode `0600`, in the `0700` project directory (#182).
 *
 * **It used to be `.dev.vars.<env>`, inside the checkout.** `devVarsFileName` returned `.dev.vars` for
 * dev and `.dev.vars.<env>` for anything else, so `pithy token mint --env production --store dev-vars`
 * wrote a **live production Cloudflare token into the project directory** — one file per environment,
 * each holding that environment's credential. They were gitignored, which is not sufficient on its own:
 * #145 was an `npm pack` leak, and `npm pack` does not consult `.gitignore` when `files` is set in
 * `package.json`. That path also had its own permissions defect on record — a private copy of the upsert
 * that lacked the shared one's `0600`, so minting for an environment with no file yet left a production
 * credential at the umask default, `0664`.
 *
 * The rule this file exists to make structural: **no minted credential is written into the checkout, for
 * any environment.** There is no filename here a project directory can hold.
 *
 * **Per project, not per account.** Unlike the bootstrap pair in `<config>/cloudflare.json`, these are
 * minted *for this project's* environments — the store entry name they mirror is project-scoped for
 * exactly that reason, since the Secrets Store is one flat account-wide namespace.
 *
 * **One file, keyed by environment, rather than a file per environment.** A family of files is the shape
 * that produced the defect above: each new environment is a new path, created by whichever call site got
 * there first, at whatever mode that call site remembered. One document has one creation site and one
 * mode.
 */

/** The file's name inside the project's config directory. Undotted: nothing here is hidden from anything. */
export const MINTED_TOKENS_FILE_NAME = "tokens.json";

/**
 * The minted-token document: environment → variable name → value.
 *
 * Validated because it is read off disk and hand-editable, and because a non-string value would be
 * handed to a later CLI run as a credential. The variable name is the profile's `secret` verbatim — a
 * local environment-variable name like `CF_TOKEN_CI_SYSTEM`, never project-scoped, because that is what
 * a pipeline reads.
 */
export const MintedTokens = z
  .record(
    z.string().describe("The environment the token was minted for — `dev`, `staging`, `production`."),
    z
      .record(
        z.string().describe("The token's variable key, exactly as the profile declares it."),
        z.string().describe("The minted token value. Never logged, never printed, never in --json."),
      )
      .describe("Every token minted for that environment, by variable key."),
  )
  .describe("Minted Cloudflare tokens this machine holds for one project, by environment. Mode 0600.");
export type MintedTokens = z.output<typeof MintedTokens>;

/**
 * `<config>/<project>/tokens.json`, from a project name that has already been resolved.
 *
 * The **name**, never a directory. It is the same key `secrets.jsonc` and `dev.json` are filed under, so
 * every worktree of one project reads one file — and the caller has already put the name through
 * `requireProjectName`, which is the gate that stops a checkout's basename from becoming a second answer.
 */
export function mintedTokensPath(project: string, options: StatePathOptions = {}): string {
  return join(devSecretsDir(project, options), MINTED_TOKENS_FILE_NAME);
}

/**
 * Record one minted token under its environment, and answer the file it landed in.
 *
 * **Read-modify-write over a credential file, so an unreadable-but-present one refuses** rather than
 * being replaced — only `ENOENT` licenses starting from `{}`. Writing this document over one that could
 * not be read would delete every other environment's token with no copy anywhere, which is the exact
 * shape of #142 and of the two `.dev.vars` losses before it.
 */
export async function writeMintedToken(
  project: string,
  env: string,
  name: string,
  value: string,
  options: StatePathOptions = {},
): Promise<string> {
  const path = mintedTokensPath(project, options);
  const document = await readMintedTokens(path);
  const merged: MintedTokens = { ...document, [env]: { ...(document[env] ?? {}), [name]: value } };
  await ensureOwnerOnlyDirFor(path);
  await writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  // Unconditionally and after the write, the same rule every other credential file here follows: a file
  // an editor or a `cp` created at the umask holds a live API token at 0644 until something narrows it.
  await tightenMode(path);
  return path;
}

/**
 * The document at `path`, or `{}` — and `{}` only when there is no file.
 *
 * A file that is there and will not parse resolves to `{}` for a *read*, because a caller reading a
 * token has nothing to destroy; the writer above is the one that refuses, because it is the one that
 * could.
 */
export async function readMintedTokens(path: string): Promise<MintedTokens> {
  const source = await readOptionalFile(path, {
    unreadable: ({ code, cause }) =>
      new ConflictError(
        {
          message: `Cannot update ${path}: Pithy could not read what is already in it.`,
          action:
            "Fix the file's permissions, or move it aside, and run the command again. Pithy won't rewrite a credential file it could not read.",
          detail: `${code ?? "unknown error"} while reading ${path}`,
        },
        { cause },
      ),
  });
  if (source === null) return {};
  const parsed = MintedTokens.safeParse(safeJson(source));
  return parsed.success ? parsed.data : {};
}

/** `JSON.parse` that answers `undefined` rather than throwing — this file is hand-edited. */
function safeJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}
