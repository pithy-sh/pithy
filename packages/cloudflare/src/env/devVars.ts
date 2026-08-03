// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Cloudflare credential keys pithy reads out-of-Worker (CLI, provisioning, live tests). These are
 * wrangler's own env-var names plus the Secrets Store id. From this single bootstrap token
 * (`CLOUDFLARE_API_TOKEN`) pithy **mints** the scoped, least-privilege tokens each use case needs —
 * most notably the secrets manager's runtime token, minted at provision time and written straight into
 * the Secrets Store, so no scoped token is ever supplied or kept here.
 */
export const CLOUDFLARE_ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "SECRETS_STORE_ID",
  "R2_CREDENTIALS",
] as const;

/**
 * Parse a `.dev.vars` file body into a map: `KEY=value` lines, `#` comments and blanks skipped, and
 * a single layer of surrounding quotes stripped. Pure — the caller owns the file read.
 */
export function parseDevVars(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return vars;
}

/**
 * Load Cloudflare credentials for out-of-Worker use: parse `<dir>/.dev.vars` if it exists, then
 * overlay `process.env` for any {@link CLOUDFLARE_ENV_KEYS} the file did not set — so CI can pass them
 * as plain environment variables (e.g. GitHub Actions secrets) with no `.dev.vars` file present. A
 * missing or unreadable file is not an error; the environment overlay still applies.
 */
export function loadCloudflareEnv(dir: string): Record<string, string> {
  let vars: Record<string, string> = {};
  try {
    vars = parseDevVars(readFileSync(join(dir, ".dev.vars"), "utf8"));
  } catch {
    // No file — rely on the environment overlay below.
  }
  for (const key of CLOUDFLARE_ENV_KEYS) {
    const fromEnv = process.env[key];
    if (!vars[key] && fromEnv) vars[key] = fromEnv;
  }
  return vars;
}

/**
 * The keys that only mean anything **together, from one account**: the account id, and a token minted in
 * that account. Deliberately just the pair.
 *
 * The other {@link CLOUDFLARE_ENV_KEYS} stay out, because each is legitimately supplied on its own:
 * `SECRETS_STORE_ID` is an address rather than a credential, routinely passed per environment while the
 * pair sits in the file, and `R2_CREDENTIALS` is a separate S3 credential most projects never set at all.
 * From the wrong account both fail loudly and immediately — a store id this account does not hold 404s,
 * and an S3 key that does not belong to the account in the endpoint will not sign. Only the pair can
 * *quietly* succeed somewhere unintended, so only the pair is a group.
 */
export const CLOUDFLARE_CREDENTIAL_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const;

/** One credential group assembled from two places: what the file supplied, and what the environment filled in. */
export interface CloudflareCredentialSplit {
  /** The {@link CLOUDFLARE_CREDENTIAL_KEYS} `<dir>/.dev.vars` sets. Non-empty, or there is no split. */
  fromFile: string[];
  /** The rest of the group, which {@link loadCloudflareEnv} therefore overlays from the environment. Non-empty. */
  fromEnvironment: string[];
}

/**
 * Whether the effective Cloudflare credentials for `<dir>` are **assembled from two sources** — some of
 * {@link CLOUDFLARE_CREDENTIAL_KEYS} from `.dev.vars`, the rest overlaid from the ambient environment.
 *
 * {@link loadCloudflareEnv} overlays *per key*, so a `.dev.vars` that sets only `CLOUDFLARE_API_TOKEN`
 * silently takes `CLOUDFLARE_ACCOUNT_ID` from whatever the shell exports. Nothing disagrees, nothing
 * warns, and the run authenticates as one account against another account's id — a confusing 403, or an
 * empty listing, at some much later call.
 *
 * **What it cannot see.** It checks that one source decided the group, not that the group is right. A
 * complete `.dev.vars` naming the wrong account is invisible here, and so is a complete pair in the
 * environment that you never meant to use — both are coherent, and coherent is all this can judge. It
 * also cannot tell you which account you meant: `fromFile` and `fromEnvironment` say where each half came
 * from, never which half is the mistake.
 *
 * A complete file, a complete absence of one (CI passes the pair as environment variables), and a half
 * file with nothing to fill the other half are all silent. An empty value counts as unset, matching the
 * overlay exactly, so this reports the credentials that actually resolve.
 */
export function cloudflareCredentialSplit(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): CloudflareCredentialSplit | null {
  let file: Record<string, string> = {};
  try {
    file = parseDevVars(readFileSync(join(dir, ".dev.vars"), "utf8"));
  } catch {
    return null; // No file — the environment supplies the whole group, which is how CI runs.
  }
  const fromFile = CLOUDFLARE_CREDENTIAL_KEYS.filter((key) => Boolean(file[key]));
  const fromEnvironment = CLOUDFLARE_CREDENTIAL_KEYS.filter((key) => !file[key] && Boolean(env[key]));
  if (fromFile.length === 0 || fromEnvironment.length === 0) return null;
  return { fromFile: [...fromFile], fromEnvironment: [...fromEnvironment] };
}
