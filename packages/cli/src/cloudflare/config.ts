// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUDFLARE_CREDENTIAL_KEYS, CLOUDFLARE_ENV_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import { ConflictError, fromZodError } from "@pithy-sh/core/src/error/pithyError";
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
 * The shape a `cloudflare.accountName` may take: **a bare token** — lowercase letters, digits, and
 * single interior hyphens.
 *
 * **This schema is the gate, and it is the only one there is.** The name becomes a file name in the
 * *config directory*, which sits outside every checkout, so `ensureScaffoldPath` and the atomic writer —
 * the two things that guard a path inside a project — never see it. #174 and #183 were both an
 * unvalidated string reaching somewhere structural, and #183's lesson was to state the rule at the thing
 * being validated rather than at each site that uses it. So `../../etc/passwd`, `a/b`, `a\b`, the empty
 * string, a trailing space, a null byte and a control character are all refused *here*, once, and every
 * way a name can arrive — typed into `pithy.config.ts`, or slugified by `pithy init` from a Cloudflare
 * account's free-text name — goes through this same parse. A second path would make the rule true of
 * only one of them.
 *
 * The refusal names the config and the value, because those are the two things needed to fix it and
 * neither is recoverable from a bare "invalid string".
 */
const ACCOUNT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** No file name has any business being longer, and a cap keeps a pathological value off the filesystem. */
const MAX_ACCOUNT_NAME = 64;

export const CloudflareAccountName = z
  .string()
  .max(MAX_ACCOUNT_NAME, {
    error: (issue) =>
      `\`cloudflare.accountName\` in pithy.config.ts is longer than ${MAX_ACCOUNT_NAME} characters: ${JSON.stringify(issue.input)}. It is a file name — <config>/cloudflare.<name>.json — so keep it to a short nickname.`,
  })
  .regex(ACCOUNT_NAME_PATTERN, {
    error: (issue) =>
      `\`cloudflare.accountName\` in pithy.config.ts must be a bare token — lowercase letters, digits, and single hyphens, like "leed". It was ${JSON.stringify(issue.input)}. The name becomes the file name <config>/cloudflare.<name>.json, so a path separator, "..", an empty value, or a control character is refused here rather than where the path is built.`,
  })
  .describe(
    "The nickname a project's root pithy.config.ts gives its Cloudflare account — a bare token, because it becomes <config>/cloudflare.<name>.json.",
  );

/** The nickname a project gives its Cloudflare account. Same name as its schema, as every Zod object here is. */
export type CloudflareAccountName = z.output<typeof CloudflareAccountName>;

/**
 * The credentials file for a named account, or the unnamed default.
 *
 * The name is parsed here as well as at the config's own schema, and that is not belt-and-braces: this
 * is the function that turns a string into a path, so it is the one place that must be impossible to
 * reach with an unvalidated one. Callers that already parsed pay a regex; a caller that did not is
 * refused rather than trusted.
 */
export function cloudflareAccountFile(accountName: string | null | undefined): string {
  if (accountName === null || accountName === undefined) return CLOUDFLARE_CONFIG_FILE_NAME;
  const parsed = CloudflareAccountName.safeParse(accountName);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      // The schema's sentence, promoted: the CLI renders `message` and `action` and drops `issues`, and a
      // refusal that does not name the value is one the reader has to go and look up.
      message: parsed.error.issues.map((issue) => issue.message).join(" "),
      action: "Set `cloudflare.accountName` in pithy.config.ts to a bare token — lowercase, digits, hyphens.",
    });
  }
  return `cloudflare.${parsed.data}.json`;
}

/**
 * Which Cloudflare account a project belongs to, as its root `pithy.config.ts` declares it (#206).
 *
 * Both fields are optional and they answer different questions. `accountName` selects the credentials
 * file; absent, the file is `cloudflare.json` exactly as before, so a single-account machine is
 * untouched and there is nothing to migrate. `accountId` is a **pin**, not a credential — an account id
 * is an identifier, the kind `wrangler.toml` commits routinely — and it is what makes the nickname mean
 * the same thing on two developers' machines.
 */
export interface CloudflareAccountSelection {
  /** Selects `<config>/cloudflare.<accountName>.json`. Absent selects `cloudflare.json`. */
  accountName?: string;
  /** The account the project belongs to. Verified against whatever the credentials resolve to. */
  accountId?: string;
}

/**
 * Where the credentials come from, and which account they must belong to.
 *
 * **`account` is required, and there is no ambient behind it.** The first shape of this change kept the
 * selection in a process-wide holder that `loadProject` published into, so a call resolved correctly
 * only if the project had already been loaded. Six call sites resolved credentials before it had —
 * including the pair handed to `wrangler deploy` — and each was silently right on a single-account
 * machine and silently wrong on any other. Six is this repository's usual count for a rule living at
 * call sites instead of at the thing being called, and a holder makes the rule *invisible*: the wrong
 * code is the code with nothing written in it.
 *
 * So the account is an argument with no default. Omitting it is a type error, which is the only form of
 * "you must think about this" that survives the next person in a hurry. `null` is the deliberate answer
 * — this project names no account, or there is no project here — and it is a statement a reviewer can
 * see in a diff, which the omission never was.
 *
 * {@link projectCloudflareAccount} is where a value comes from; it loads the project, so the ordering
 * that used to be implicit is now the `await` in front of it.
 */
export interface CloudflareConfigOptions extends StatePathOptions {
  /** The project's account, from `projectCloudflareAccount`, or `null` when it names none. */
  account: CloudflareAccountSelection | null;
}

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

/**
 * `<config>/cloudflare.json`, or `<config>/cloudflare.<accountName>.json` when the project names an
 * account — beside `state.json`, above every project's own directory.
 */
export function cloudflareConfigPath(options: CloudflareConfigOptions): string {
  return join(stateDir(options), cloudflareAccountFile(options.account?.accountName));
}

/** Where a resolved `CLOUDFLARE_ACCOUNT_ID` came from — the two sources {@link cloudflareEnv} merges. */
export type CloudflareAccountSource = "file" | "environment";

/**
 * A project's pin disagreeing with the account the credentials actually belong to.
 *
 * `cloudflare.<name>.json` is a local file, so the nickname means whatever each machine says it means:
 * two developers on one repository can both have that file and have it point at different accounts, and
 * nothing in the repository would disagree with either of them. The pin is what makes the repository the
 * authority — the local file may only supply credentials *for the account the project says it belongs to*.
 */
export interface CloudflareAccountMismatch {
  /** `cloudflare.accountId` from the project's root config. */
  pinned: string;
  /** The `CLOUDFLARE_ACCOUNT_ID` that actually resolved. */
  resolved: string;
  /** Which of the two sources supplied it — the environment overlay is the CI case. */
  source: CloudflareAccountSource;
  /** The credentials file this resolution named, whether or not it existed. */
  path: string;
}

/** One credential resolution, with everything a caller may need to refuse or to report it. */
export interface CloudflareResolution {
  /** The file this resolution read, named whether or not it exists. */
  path: string;
  /** The `cloudflare.accountName` that selected it, or `null` for the unnamed default. */
  accountName: string | null;
  /** The credentials: the file's keys, with `process.env` overlaid per key for the ones it did not set. */
  vars: Record<string, string>;
  /** The project's `cloudflare.accountId`, or `null` when it set none. */
  pinnedAccountId: string | null;
  /** Set when the pin and the resolved account id disagree. */
  mismatch: CloudflareAccountMismatch | null;
}

/**
 * Resolve the credentials **and** everything that can be said about them, without throwing.
 *
 * The non-throwing half of {@link cloudflareEnv}, for the two callers that must keep working in exactly
 * the state they exist to report: `pithy doctor`, which turns a mismatch into a line and a non-zero exit,
 * and `pithy add secrets`, whose store-id recording is a convenience that may never fail the command it
 * rides on.
 */
export function resolveCloudflare(options: CloudflareConfigOptions): CloudflareResolution {
  const selection = options.account;
  const accountName = selection?.accountName ?? null;
  const path = join(stateDir(options), cloudflareAccountFile(accountName));
  const fromFile = readCloudflareConfigSync(path);
  const vars = { ...fromFile };
  const env = options.env ?? process.env;
  for (const key of CLOUDFLARE_ENV_KEYS) {
    const overlay = env[key];
    if (!vars[key] && overlay) vars[key] = overlay;
  }

  const pinnedAccountId = selection?.accountId ?? null;
  const resolved = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  // A pin with nothing resolved is not a mismatch: unconfigured is a legitimate state, and `pithy doctor`
  // already names it every run. Only a *disagreement* is a fault.
  const mismatch =
    pinnedAccountId && resolved && resolved !== pinnedAccountId
      ? {
          pinned: pinnedAccountId,
          resolved,
          source: (fromFile.CLOUDFLARE_ACCOUNT_ID ? "file" : "environment") as CloudflareAccountSource,
          path,
        }
      : null;

  return { path, accountName, vars, pinnedAccountId, mismatch };
}

/**
 * The one sentence a mismatch gets, so the refusal and `pithy doctor`'s line say the same thing.
 *
 * Both ids are named, because the whole failure is that two of them exist and nothing else in the
 * toolchain compares them. The source is named too: a file naming the wrong account is a local
 * misconfiguration, and an *environment* naming it is a CI job pointed at the wrong tenant — the one
 * place that deploys to production.
 */
export function describeCloudflareAccountMismatch(mismatch: CloudflareAccountMismatch): string {
  const where = mismatch.source === "file" ? mismatch.path : "the environment";
  return `This project pins Cloudflare account ${mismatch.pinned}, and ${where} supplies credentials for ${mismatch.resolved}.`;
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
export function cloudflareEnv(options: CloudflareConfigOptions): Record<string, string> {
  const resolved = resolveCloudflare(options);
  if (resolved.mismatch) {
    throw new ConflictError({
      message: describeCloudflareAccountMismatch(resolved.mismatch),
      action:
        "Fix `cloudflare.accountId` in pithy.config.ts, or point `cloudflare.accountName` at the file holding this account's credentials. Pithy will not use credentials for an account the project does not claim.",
      detail: `pinned ${resolved.mismatch.pinned}; ${resolved.mismatch.source} supplied ${resolved.mismatch.resolved} (${resolved.mismatch.path})`,
    });
  }
  return resolved.vars;
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
export function cloudflareCredentialSplit(options: CloudflareConfigOptions): CloudflareCredentialSplit | null {
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
  options: CloudflareConfigOptions,
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
