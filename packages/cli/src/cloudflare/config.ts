// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUDFLARE_CREDENTIAL_KEYS, CLOUDFLARE_ENV_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { ensureOwnerOnlyDirFor, tightenMode } from "../devSecrets/mode";
import { type StatePathOptions, stateDir } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";
import { readOptionalFile } from "../project/readOptionalFile";

/**
 * The CLI's Cloudflare credentials: `<config>/cloudflare.json`, **account-scoped**, `0600`, in the
 * `0700` config directory (#182).
 *
 * **Account-scoped, not per project.** `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and
 * `SECRETS_STORE_ID` are functions of the *account*: one account holds many pithy projects, Cloudflare
 * permits one Secrets Store per account, and a per-project home would store one copy of the same token
 * per project and make rotation an N-place edit. It is also the only scope `pithy init` can write at —
 * the token is needed to list zones *before* there is a project name to key a directory on, which is
 * exactly the case `bootstrapVarsPath` answers `null` for.
 *
 * **These left the checkout, and nothing minted goes back into it.** They used to be read from the
 * project root's `.dev.vars`, and `pithy token mint --env production --store dev-vars` wrote a live
 * production credential into `.dev.vars.production` beside it. Gitignored is not sufficient: #145 was an
 * `npm pack` leak, and `npm pack` does not consult `.gitignore` when `files` is set. So no command
 * writes a credential inside the project any more, for any environment — see `../tokens/sinks`.
 *
 * **`CLOUDFLARE_API_TOKEN` is not a registry secret and is not in `secrets.jsonc`.** That file holds
 * secrets a *Worker* reads; this is a CLI credential that is never a Worker binding. `pithy doctor`
 * already treats the two as different categories, and this file is what makes that true on disk.
 *
 * **The store id is written once and read from a file forever after.** Resolving it from the account on
 * each run was considered and rejected: avoiding an API call per invocation would mean caching the id in
 * a file, which is this key again with a staleness question and a network failure mode added. `pithy
 * init` writes the pair at the one moment the operator is holding them; `pithy add secrets` appends the
 * store id at the moment it provisions one. A CLI that has to ask Cloudflare where its own store is
 * cannot run offline, which costs more than the key was costing.
 *
 * **`process.env` still overlays, per key.** CI supplies these as real environment variables and has no
 * file at all — see {@link cloudflareEnv}.
 */

/** The file's name inside the Pithy config directory. Undotted: nothing here is hidden from anything. */
export const CLOUDFLARE_CONFIG_FILE_NAME = "cloudflare.json";

/**
 * The account's Cloudflare configuration as it appears on disk.
 *
 * Every field is optional because every one of them is legitimately absent: a project that has not been
 * provisioned yet has no store id, and most accounts never set `R2_CREDENTIALS`. The keys are
 * {@link CLOUDFLARE_ENV_KEYS} verbatim, so the file, the environment overlay, and every error message
 * name one set of strings.
 */
export const CloudflareConfig = z
  .object({
    CLOUDFLARE_ACCOUNT_ID: z
      .string()
      .optional()
      .describe("The Cloudflare account id every provisioned resource is created under."),
    CLOUDFLARE_API_TOKEN: z
      .string()
      .optional()
      .describe("The bootstrap API token pithy mints every scoped token from. Never logged, never printed."),
    SECRETS_STORE_ID: z
      .string()
      .optional()
      .describe("The account's one Secrets Store id. Written by pithy add secrets; never resolved over the network."),
    R2_CREDENTIALS: z
      .string()
      .optional()
      .describe("The account's R2 S3 credentials, as the JSON blob R2Credentials validates. Most projects have none."),
  })
  .catchall(z.unknown().describe("Another tenant's key, read and written back untouched."))
  .describe("This machine's account-scoped Cloudflare credentials — <config>/cloudflare.json, mode 0600.");

/** The account's Cloudflare configuration. Same name as its schema, as every Zod object in this repo is. */
export type CloudflareConfig = z.output<typeof CloudflareConfig>;

/** `<config>/cloudflare.json` — beside `state.json`, above every project's own directory. */
export function cloudflareConfigPath(options: StatePathOptions = {}): string {
  return join(stateDir(options), CLOUDFLARE_CONFIG_FILE_NAME);
}

/**
 * The Cloudflare credentials every out-of-Worker call resolves: `<config>/cloudflare.json`, then
 * `process.env` for any {@link CLOUDFLARE_ENV_KEYS} the file did not set.
 *
 * **Synchronous, and that is load-bearing for the twenty-odd call sites.** Every command resolves these
 * before doing anything else; making the read async would turn a settled call into a refactor of each.
 *
 * **A missing or unreadable file is not an error here.** CI has no file and passes the whole set as
 * environment variables; a developer who has not run `pithy init` yet has neither. The overlay applies
 * per key, so a file holding only the account id still takes the token from the environment — which is
 * exactly the mixture {@link cloudflareCredentialSplit} exists to name.
 */
export function cloudflareEnv(options: StatePathOptions = {}): Record<string, string> {
  const vars = readCloudflareConfigSync(cloudflareConfigPath(options));
  const env = options.env ?? process.env;
  for (const key of CLOUDFLARE_ENV_KEYS) {
    const fromEnv = env[key];
    if (!vars[key] && fromEnv) vars[key] = fromEnv;
  }
  return vars;
}

/** One credential group assembled from two places: what the file supplied, and what the environment filled in. */
export interface CloudflareCredentialSplit {
  /** The {@link CLOUDFLARE_CREDENTIAL_KEYS} `cloudflare.json` sets. Non-empty, or there is no split. */
  fromFile: string[];
  /** The rest of the group, which {@link cloudflareEnv} therefore overlays from the environment. Non-empty. */
  fromEnvironment: string[];
}

/**
 * Whether the effective Cloudflare credentials are **assembled from two sources** — some of
 * {@link CLOUDFLARE_CREDENTIAL_KEYS} from `cloudflare.json`, the rest overlaid from the ambient
 * environment.
 *
 * {@link cloudflareEnv} overlays *per key*, so a file that sets only `CLOUDFLARE_API_TOKEN` silently
 * takes `CLOUDFLARE_ACCOUNT_ID` from whatever the shell exports. Nothing disagrees, nothing warns, and
 * the run authenticates as one account against another account's id — a confusing 403, or an empty
 * listing, at some much later call.
 *
 * **What it cannot see.** It checks that one source decided the group, not that the group is right. A
 * complete file naming the wrong account is invisible here, and so is a complete pair in the environment
 * that you never meant to use — both are coherent, and coherent is all this can judge.
 *
 * A complete file, a complete absence of one (CI passes the pair as environment variables), and a half
 * file with nothing to fill the other half are all silent. An empty value counts as unset, matching the
 * overlay exactly, so this reports the credentials that actually resolve.
 */
export function cloudflareCredentialSplit(options: StatePathOptions = {}): CloudflareCredentialSplit | null {
  const path = cloudflareConfigPath(options);
  let file: Record<string, string>;
  try {
    file = parseCloudflareConfig(readFileSync(path, "utf8"));
  } catch {
    return null; // No file — the environment supplies the whole group, which is how CI runs.
  }
  const env = options.env ?? process.env;
  const fromFile = CLOUDFLARE_CREDENTIAL_KEYS.filter((key) => Boolean(file[key]));
  const fromEnvironment = CLOUDFLARE_CREDENTIAL_KEYS.filter((key) => !file[key] && Boolean(env[key]));
  if (fromFile.length === 0 || fromEnvironment.length === 0) return null;
  return { fromFile: [...fromFile], fromEnvironment: [...fromEnvironment] };
}

/**
 * Parse the file's bytes into the string-valued keys a caller resolves credentials from.
 *
 * Validated because it is read off disk and hand-editable, and it decides which account every
 * provisioning call lands in. A non-string value would reach a Cloudflare client as an object and
 * authenticate as `[object Object]`; a malformed document resolves to no credentials rather than to
 * half of somebody else's.
 */
export function parseCloudflareConfig(source: string): Record<string, string> {
  const parsed = CloudflareConfig.safeParse(safeJson(source));
  if (!parsed.success) return {};
  const vars: Record<string, string> = {};
  for (const key of CLOUDFLARE_ENV_KEYS) {
    const value = parsed.data[key];
    if (typeof value === "string" && value !== "") vars[key] = value;
  }
  return vars;
}

/**
 * Merge `values` into the account's config and write it back. Returns the merged set.
 *
 * **Read-modify-write over a credential file, so an unreadable-but-present one refuses rather than being
 * replaced.** Only `ENOENT` licenses starting from `{}` — every other errno is a file that exists and did
 * not open, and writing over it would delete a token nothing else has a copy of. That rule is
 * {@link readOptionalFile}'s; the sentence below is this file's.
 *
 * Written `0600` in a `0700` directory, and narrowed again after the write: a file an editor or an older
 * pithy created at the umask holds a live API token at `0644` until something narrows it.
 */
export async function writeCloudflareConfig(
  values: Partial<Record<(typeof CLOUDFLARE_ENV_KEYS)[number], string>>,
  options: StatePathOptions = {},
): Promise<Record<string, string>> {
  const path = cloudflareConfigPath(options);
  const document = await readCloudflareDocument(path);
  const merged: Record<string, unknown> = { ...document };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  await ensureOwnerOnlyDirFor(path);
  await writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  await tightenMode(path);
  return parseCloudflareConfig(JSON.stringify(merged));
}

/** The parsed document with every tenant's key intact, for a read-modify-write. `{}` only for an absent file. */
async function readCloudflareDocument(path: string): Promise<Record<string, unknown>> {
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
  const parsed = CloudflareConfig.safeParse(safeJson(source));
  return parsed.success ? parsed.data : {};
}

/**
 * The file's credential keys, or none.
 *
 * **Every failure is an empty set here, where it is a refusal in the writer.** Nothing is rewritten from
 * this call — the result is handed to a Cloudflare client — so a file that will not open costs a set of
 * credentials and says so through `pithy doctor`'s `Cloudflare: unconfigured`, rather than stopping every
 * command in the CLI over a permission bit. {@link writeCloudflareConfig} is the one that refuses,
 * because it is the one that could destroy what it could not read.
 */
function readCloudflareConfigSync(path: string): Record<string, string> {
  try {
    return parseCloudflareConfig(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** `JSON.parse` that answers `undefined` rather than throwing — this file is hand-edited. */
function safeJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}
