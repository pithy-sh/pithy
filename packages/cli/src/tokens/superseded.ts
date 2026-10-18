// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AccountTokenSummary } from "@pithy-sh/cloudflare/src/tokens/accountTokensManager";
import { RUNTIME_PROFILE } from "@pithy-sh/cloudflare/src/tokens/runtime";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { SecretFieldProbe } from "@pithy-sh/secrets/src/cli/dispatch";
import { MANAGER_CF_API_TOKEN_SECRET, managerCfApiTokenName } from "@pithy-sh/secrets/src/provision/provisionSecrets";

/**
 * **The Cloudflare tokens `runtime` superseded, and where each one still is (#728).**
 *
 * A deployed application holds one Cloudflare API token now. Before, it held up to three: the secrets
 * manager's own, minted by `pithy secrets provision` (`<project>-global-secrets-manager`) or by `pithy token
 * mint secrets` (`<project>-<env>-secrets`), and the Images and Stream token an operator made by hand and
 * handed to `pithy media provision`, which stored it in `media-storage-credentials` — the bootstrap token,
 * unless `--api-token` named another. The upgrade is mint `runtime`, deploy, then revoke the manager's
 * tokens and rewrite the media bundle — and **nothing revokes them for you**, so `pithy token list`
 * names each one still present, and `pithy doctor` names it again once `runtime` is minted.
 *
 * Every name is composed by the namer that minted it, so a listing names this project's credentials and
 * never a pattern that could match somebody else's. The media token has no name the kit chose, so it is
 * found where it was stored: the manager is asked whether the bundle still carries the field — a bit.
 */

/** The profile the manager's own token was minted under by `pithy token mint`, before `runtime`. */
const SUPERSEDED_PROFILE = "secrets";

/**
 * The variable key each retired profile wrote its value under, by profile name.
 *
 * A retired profile is not in the registry, and `pithy doctor` still tells an operator to run `token revoke
 * secrets --env <env>`. The revoke deletes by a name the root config composes. Its local cleanup needs the
 * variable key, and this table is where that key lives once the profile is gone.
 */
const SUPERSEDED_PROFILE_SECRETS: Readonly<Record<string, string>> = {
  [SUPERSEDED_PROFILE]: MANAGER_CF_API_TOKEN_SECRET,
};

/** The variable key a retired profile wrote its value under, or `undefined` when the name was never one. */
export function supersededProfileSecret(profile: string): string | undefined {
  return Object.hasOwn(SUPERSEDED_PROFILE_SECRETS, profile) ? SUPERSEDED_PROFILE_SECRETS[profile] : undefined;
}

/** One credential `runtime` superseded that is still there. */
export interface SupersededToken {
  /** An account token, by its name; or a token stored inside a secret, by the secret's name. */
  kind: "account-token" | "stored";
  /** The account token's name, or the secret that stores one. */
  name: string;
  /** The account token's id, for an account token. */
  tokenId?: string;
  /** The account token's status, when Cloudflare returned one. */
  status?: string;
  /** The environment whose vault stores it, for a stored token. */
  env?: string;
  /** What it was, in the operator's words. */
  was: string;
  /** The profile that replaced it. */
  supersededBy: typeof RUNTIME_PROFILE;
}

/** Where a capability stored a token `runtime` superseded: the `json` secret, and the field it is in. */
export interface StoredTokenField {
  /** The secret's registry name. */
  secret: string;
  /** The top-level field that held the token. */
  field: string;
}

/** The secrets manager's own tokens, out of the account's token list. */
export function supersededAccountTokens(
  tokens: readonly AccountTokenSummary[],
  project: string,
  env: string,
): SupersededToken[] {
  const named = [
    { name: managerCfApiTokenName(project), was: "the secrets manager's own token" },
    {
      name: resourceNames(project).env(env).apiToken(SUPERSEDED_PROFILE),
      was: `the secrets manager's own token, minted for ${env}`,
    },
  ];
  return named.flatMap(({ name, was }) =>
    tokens
      .filter((token) => token.name === name)
      .map((token) => ({
        kind: "account-token" as const,
        name,
        tokenId: token.id,
        ...(token.status === undefined ? {} : { status: token.status }),
        was,
        supersededBy: RUNTIME_PROFILE,
      })),
  );
}

/**
 * The media token still stored in this environment's bundle, or `null`. `media` is where a composed media
 * capability says it stored one, or `null` when nothing here composes media. `dev` has no manager to ask.
 */
export async function supersededStoredToken(input: {
  env: string;
  media: StoredTokenField | null;
  carries: SecretFieldProbe["carries"];
}): Promise<SupersededToken | null> {
  if (input.media === null || input.env === LOCAL_ENVIRONMENT) return null;
  const { secret, field } = input.media;
  if (!(await input.carries({ env: input.env as "staging" | "prod", name: secret, field }))) return null;
  return {
    kind: "stored",
    name: secret,
    env: input.env,
    // The supplied token defaulted to the bootstrap one, so the operator is told which it most likely is.
    was: `the Images and Stream token supplied to \`${commandName("media provision")}\` — your bootstrap token, unless you passed \`--api-token\``,
    supersededBy: RUNTIME_PROFILE,
  };
}

/**
 * What `pithy token list` adds for the tokens `runtime` superseded, or `null` when there is nothing to say.
 * `unasked` is why the stored token could not be asked about, when it could not.
 */
export function supersededNotice(found: readonly SupersededToken[], unasked: string | null): string | null {
  const lines: string[] = [];
  if (found.length > 0) {
    lines.push(`Superseded by ${RUNTIME_PROFILE}, and still present:`);
    for (const token of found) {
      const where =
        token.kind === "account-token" ? `${token.name} · ${token.tokenId}` : `${token.name} in ${token.env}`;
      lines.push(`  ${where} — ${token.was}`);
    }
    const revoke = found.some((token) => token.kind === "account-token") ? ", then revoke each account token" : "";
    lines.push(
      `Mint ${RUNTIME_PROFILE}, redeploy${revoke}. Nothing is revoked for you. ${commandName("doctor")} names the step for each one.`,
    );
    if (found.some((token) => token.kind === "stored")) {
      lines.push(
        "A stored token is your bootstrap one unless you passed another. Rewrite the bundle, and revoke it only if you made it for media.",
      );
    }
  }
  if (unasked !== null) lines.push(`Whether a supplied media token is still stored could not be asked: ${unasked}`);
  return lines.length === 0 ? null : `${lines.join("\n")}\n`;
}
