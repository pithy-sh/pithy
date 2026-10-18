// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CapabilitySettings, SettingsFinding } from "@pithy-sh/core/src/capability/settings";
import { remedy } from "@pithy-sh/core/src/cli/command";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { ManagedEnvironment } from "../scope";
import { managerCfApiTokenName, runtimeTokenSecretName } from "./provisionSecrets";

/** The redeploy that moves every manager onto the runtime token — said as a person's decision where it is one. */
const REDEPLOY = remedy("secrets provision").say((command) => `Redeploy the managers with ${command}.`);

/** The profile name the manager's own token was minted under by `pithy token mint`, before `runtime` (#728). */
const SUPERSEDED_PROFILE = "secrets";

/**
 * **`pithy doctor`'s check for the secrets manager's own token, superseded by `runtime` (#728).**
 *
 * The manager rotated with a token of its own — `<project>-global-secrets-manager`, minted by
 * `pithy secrets provision`, or `<project>-<env>-secrets`, minted by `pithy token mint secrets`. It now reads
 * the application's one runtime token, and nothing reads the old one, but it is still a live credential that
 * can write every entry in the account's Secrets Store, and nothing revokes it for you. The upgrade path is
 * mint `runtime`, deploy, then revoke — so this names each old token still present once some environment
 * holds a runtime token, and says nothing before: until then the old one is the one that works.
 *
 * Each is named by its exact token name, composed by the namer that minted it, so the finding names one
 * credential this project made and never a pattern that could match somebody else's.
 */
export function supersededManagerToken(): CapabilitySettings {
  return {
    local: () => [],
    async account(context) {
      const deployed = context.environments
        .map(({ name }) => name)
        .filter((name) => name !== LOCAL_ENVIRONMENT) as ManagedEnvironment[];
      const minted: ManagedEnvironment[] = [];
      for (const env of deployed) {
        if (await context.account.storeEntry(runtimeTokenSecretName(context.project, env))) minted.push(env);
      }
      if (minted.length === 0) return [];

      const findings: SettingsFinding[] = [];
      const global = managerCfApiTokenName(context.project);
      if (await context.account.accountToken(global)) {
        findings.push({
          setting: global,
          environment: null,
          problem:
            "The secrets manager's own Cloudflare token is still in the account. The runtime token replaced it, and nothing reads it once every manager is redeployed.",
          action: `${REDEPLOY} Then revoke it in the Cloudflare dashboard, under Manage Account → Account API Tokens. Nothing revokes it for you.`,
        });
      }
      for (const env of minted) {
        const name = resourceNames(context.project).env(env).apiToken(SUPERSEDED_PROFILE);
        if (!(await context.account.accountToken(name))) continue;
        const revoke = remedy("token revoke", { args: [SUPERSEDED_PROFILE], flags: { "--env": env } });
        findings.push({
          setting: name,
          environment: env,
          problem:
            "The secrets manager's own Cloudflare token for this environment is still in the account. The runtime token replaced it, and nothing reads it.",
          action: `${REDEPLOY} Then revoke the old token. ${revoke.say((command) => `Run ${command}.`)}`,
          ...(revoke.fix === undefined ? {} : { fix: String(revoke.fix) }),
        });
      }
      return findings;
    },
  };
}
