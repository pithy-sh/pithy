// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { devSecretsDir } from "../devSecrets/location";
import { ensureOwnerOnlyDirFor, tightenMode } from "../devSecrets/mode";
import type { StatePathOptions } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";
import { type MergeBase, readMergeBase, readOptionalFile, requireRecord } from "../project/readOptionalFile";

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
 * **Read-modify-write over a credential file, so every state but "there is no file" refuses.** Only
 * `ENOENT` licenses starting from `{}`. A file that could not be read, one that is not JSON, one that
 * parsed to something that is not a document, one that is a record of something else — writing this
 * document over any of them deletes every other environment's live token with no copy anywhere, which is
 * the exact shape of #142 and of the two `.dev.vars` losses before it. Each refusal is
 * {@link mintedTokensBase}'s, because it is the one that can tell an absence from an answer, and the
 * merge below takes a {@link MergeBase} so that no other read can be handed to it (#219).
 */
export async function writeMintedToken(
  project: string,
  env: string,
  name: string,
  value: string,
  options: StatePathOptions = {},
): Promise<string> {
  const base = await mintedTokensBase(mintedTokensPath(project, options));
  const merged = withMintedToken(base, env, name, value);
  await ensureOwnerOnlyDirFor(base.path);
  // The path comes off the base rather than being re-derived, so what is written can only ever land back
  // on the file the base was read from.
  await writeFileAtomic(base.path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  // Unconditionally and after the write, the same rule every other credential file here follows: a file
  // an editor or a `cp` created at the umask holds a live API token at 0644 until something narrows it.
  await tightenMode(base.path);
  return base.path;
}

/**
 * The document to write: the base, with one token recorded under its environment.
 *
 * **It takes a {@link MergeBase} and that is the whole point.** Only {@link readMergeBase} mints one, so
 * the lenient {@link readMintedTokens} below — which answers `{}` for a file it cannot make sense of,
 * correctly, because it rewrites nothing — cannot reach this function. The accident that produced all
 * five instances of this defect is a type error here rather than a replaced credential file on disk.
 */
function withMintedToken(base: MergeBase<MintedTokens>, env: string, name: string, value: string): MintedTokens {
  const document = base.document;
  return { ...document, [env]: { ...(document[env] ?? {}), [name]: value } };
}

/**
 * The merge base for a write over `tokens.json`: the whole document, known-good, or a refusal.
 *
 * The strict half of the reader/writer split (#219). Absent is `{}`; unopenable, not JSON, not a record
 * and not a document of minted tokens are four refusals, each in this file's own words — "Pithy won't
 * rewrite a credential file it could not read" is the sentence, and the four spellings of "could not
 * read" are the four ways a hand edit gets there.
 */
async function mintedTokensBase(path: string): Promise<MergeBase<MintedTokens>> {
  return readMergeBase(path, MintedTokens, {
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
    unparseable: () =>
      new ConflictError({
        message: `Cannot update ${path}: it is there and is not JSON.`,
        action:
          "Fix the JSON, or move it aside, and run the command again. Pithy won't rewrite a credential file it could not parse — every other environment's token is still in it.",
        // Never the parser's own message: it quotes the line it choked on, and these lines are tokens.
        detail: `${MINTED_TOKENS_FILE_NAME} at ${path} did not parse`,
      }),
    notARecord: ({ found }) =>
      new ConflictError({
        message: `Cannot update ${path}: it holds ${found}, not a document of minted tokens.`,
        action:
          "Restore it to a JSON object keyed by environment, or move it aside, and run the command again. Pithy won't rewrite a credential file it could not make sense of.",
        detail: `${MINTED_TOKENS_FILE_NAME} at ${path} parsed to ${found}`,
      }),
    invalid: ({ at }) =>
      new ConflictError({
        message: `Cannot update ${path}: it is not a document of minted tokens.`,
        action:
          "Restore it to a JSON object of environment → variable name → token, or move it aside, and run the command again.",
        // The key path, so the line can be found. Never the value on it, which is a credential.
        detail: `${MINTED_TOKENS_FILE_NAME} at ${path} failed its schema at ${at}`,
      }),
  });
}

/**
 * **The reporting read**, for a caller that wants to know what has been minted and will rewrite nothing.
 *
 * `pithy adopt` is the caller: it reads every destination to say what it would move where. The write
 * that follows goes through {@link writeMintedToken}, which reads its own base through
 * {@link mintedTokensBase} — so this answer is never anybody's merge base, and the type says so, since
 * a `MintedTokens` is not a {@link MergeBase} of one (#219).
 *
 * **Which of the two this is, stated, because that was the ambiguity that cost four files.** This is the
 * one that may answer `{}`, and it does so for a file that is not there and for one that nothing can be
 * made of at all — it will not parse, or it parses and is not a document of minted tokens. A reader has
 * nothing to destroy, and a caller reading a token back gets an honest "nothing here" rather than a
 * command that will not run.
 *
 * **Two failures are refusals even here, and they are the file's rather than the caller's.** A file that
 * is there and will not open, because "absent" is a claim about the filesystem that this read cannot
 * make ({@link readOptionalFile}, #190). And a value that parsed to something that is not a record,
 * because that is a claim about what is in the file — something is here, this is not what it is
 * ({@link requireRecord}, #209).
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
  const value = safeJson(source);
  if (value === undefined) return {};
  const document = requireRecord(path, value, {
    notARecord: ({ found }) =>
      new ConflictError({
        message: `Cannot update ${path}: it holds ${found}, not a document of minted tokens.`,
        action:
          "Restore it to a JSON object keyed by environment, or move it aside, and run the command again. Pithy won't rewrite a credential file it could not make sense of.",
        detail: `${MINTED_TOKENS_FILE_NAME} at ${path} parsed to ${found}`,
      }),
  });
  const parsed = MintedTokens.safeParse(document);
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
