// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { CLOUDFLARE_CREDENTIAL_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import { type CloudflareCredentialSplit, cloudflareCredentialSplit, cloudflareEnv } from "../cloudflare/config";
import type { StatePathOptions } from "../notifier/state";

/**
 * Whether `pithy doctor` can reach Cloudflare with the credentials the project is configured with.
 *
 * **Why this is a health check and not a note.** The bootstrap `CLOUDFLARE_API_TOKEN` +
 * `CLOUDFLARE_ACCOUNT_ID` pair (`docs/TOKENS.md`) is the first thing anyone sets up on a new account and
 * the first thing they get wrong — and every failure downstream is a command that was going to work.
 * Nothing else reported a bad credential until the command that needed it failed mid-run, which is a
 * worse place to learn it.
 *
 * The two checks are deliberately separate because they fail for different reasons and want different
 * fixes. A live token scoped to the *wrong account* passes verification and fails everything after it —
 * the exact mistake available the moment somebody has a second Cloudflare account.
 */
export type CloudflareAccessState =
  /** Neither credential is set. Legitimate before provisioning; never fails the exit. */
  | "unconfigured"
  /** The token verified and the account answered. */
  | "ok"
  /** `GET /user/tokens/verify` rejected it — wrong value, revoked, or expired. */
  | "token_invalid"
  /** The token is live but this account did not answer — usually the wrong account id, or missing permissions. */
  | "account_unreachable";

/** What `doctor` learned about the configured Cloudflare credentials. */
export interface CloudflareAccess {
  state: CloudflareAccessState;
  /** Which credential keys were absent, so a half-configured setup names the missing half rather than both. */
  missing: string[];
  /** The token's lifecycle status from `GET /user/tokens/verify` (`active`), or null when it could not be read. */
  tokenStatus: string | null;
  /**
   * Set when the account id and the token came from **different sources** — part of the pair from
   * `<config>/cloudflare.json`, the rest overlaid from the ambient environment.
   *
   * Reported alongside the state rather than as one, because it is orthogonal to reachability: mixed
   * credentials may well reach *an* account. It never fails the exit — the pair may be valid, and only a
   * fault this project's own config positively establishes may gate CI.
   */
  credentialSplit: CloudflareCredentialSplit | null;
}

/**
 * The credential keys this check needs, in the order they are reported — the same group
 * {@link cloudflareCredentialSplit} watches, because "both must be set" and "both must come from one
 * account" are two readings of one pair.
 */
const REQUIRED_KEYS = CLOUDFLARE_CREDENTIAL_KEYS;

/**
 * Verify the token against the endpoint that matches its kind.
 *
 * **Cloudflare has two, and using the wrong one rejects a working credential.** `/user/tokens/verify`
 * answers only for user-bound (`cfut_*`) tokens; an account-owned (`cfat_*`) one gets `Invalid API Token`.
 * `CLAUDE.md` prefers account-owned tokens, so the user endpoint is wrong for the *common* case — a
 * diagnostic built on it would confidently reject the setup it was written to validate.
 *
 * The prefix is the only part of the token read, matching `@pithy-sh/audit`'s actor resolution. An
 * unrecognised prefix falls back to trying both rather than guessing, since a wrong "invalid" here is
 * worse than a slower answer.
 */
async function verifyByKind(clients: CloudflareClients, apiToken: string): Promise<string | null> {
  const account = () => clients.accountTokens().verifyToken();
  const user = () => clients.user().verifyToken();
  const order = apiToken.startsWith("cfat_") ? [account] : apiToken.startsWith("cfut_") ? [user] : [account, user];

  for (const attempt of order) {
    try {
      return (await attempt()).status;
    } catch {
      // Try the next shape, or fall through to "rejected".
    }
  }
  return null;
}

/**
 * Probe the configured Cloudflare credentials, reading `<config>/cloudflare.json` with the `process.env`
 * overlay {@link cloudflareEnv} applies — so this reports the same credentials every other command
 * resolves, in CI as well as locally.
 *
 * **It takes no project directory, and that is the finding rather than a simplification.** The
 * credentials are account-scoped (#182): one account holds many projects, and "can I reach Cloudflare"
 * has the same answer in every checkout on this machine. Passing a project root implied otherwise, and
 * the file it named was inside one.
 *
 * Never throws: a diagnostic command has to keep working in exactly the broken environment it exists to
 * diagnose, so every failure becomes a state rather than an exception.
 */
export async function checkCloudflareAccess(options: StatePathOptions = {}): Promise<CloudflareAccess> {
  const vars = cloudflareEnv(options);
  // Resolved from the same file and the same environment, so what is reported is a fact about *this*
  // resolution rather than about a second one taken a moment later.
  const credentialSplit = cloudflareCredentialSplit(options);
  const missing = REQUIRED_KEYS.filter((key) => !vars[key]);
  if (missing.length > 0) return { state: "unconfigured", missing: [...missing], tokenStatus: null, credentialSplit };

  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  const clients = new CloudflareClients({ accountId: vars.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken });

  const tokenStatus = await verifyByKind(clients, apiToken);
  if (tokenStatus === null) return { state: "token_invalid", missing: [], tokenStatus: null, credentialSplit };

  // Account-scoped, read-only, and never throws — and it exercises the one permission the bootstrap token
  // must hold to mint anything (`docs/TOKENS.md`), so a token that cannot mint is caught here rather than
  // by `pithy token mint`.
  const reachable = await clients.accountTokens().validateServiceAccess();
  if (!reachable) return { state: "account_unreachable", missing: [], tokenStatus, credentialSplit };

  return { state: "ok", missing: [], tokenStatus, credentialSplit };
}

/** The state's own line, before the split warning {@link describeCloudflareAccess} may append. */
function describeState(access: CloudflareAccess): string {
  switch (access.state) {
    case "ok":
      return `reachable (token ${access.tokenStatus ?? "verified"})`;
    case "unconfigured":
      return `not configured (set ${access.missing.join(" and ")} in ~/.config/pithy/cloudflare.json, or the environment)`;
    case "token_invalid":
      return "CLOUDFLARE_API_TOKEN rejected — check the value, or mint a new bootstrap token";
    case "account_unreachable":
      return "token is valid but the account did not answer — check CLOUDFLARE_ACCOUNT_ID and the token's permissions";
  }
}

/**
 * The one-line report for {@link renderDoctorText}, and the `action` a failing state should prompt.
 *
 * A split group is appended rather than substituted: both facts are true at once, and a reachable state
 * is exactly what makes the split easy to miss — mixed credentials still reach *an* account.
 */
export function describeCloudflareAccess(access: CloudflareAccess): string {
  const state = describeState(access);
  const split = access.credentialSplit;
  if (!split) return state;
  return `${state}; credentials come from two places — cloudflare.json sets ${split.fromFile.join(" and ")}, the environment supplies ${split.fromEnvironment.join(" and ")} — set the whole pair in one of them`;
}
