// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  type CapabilitySettings,
  SettingsAccountIncomplete,
  type SettingsFinding,
  type UnansweredEnvironment,
} from "@pithy-sh/core/src/capability/settings";
import { commandName, remedy } from "@pithy-sh/core/src/cli/command";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { runtimeTokenSecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { MEDIA_STORAGE_SECRET, MEDIA_SUPPLIED_TOKEN_FIELD } from "./registry";

/**
 * **`pithy doctor`'s check for the media token the runtime token superseded (#728).**
 *
 * Until #728, `pithy media provision` asked for an Images and Stream token and stored it in
 * `media-storage-credentials`. The application's one `runtime` token now does that job, and nothing reads
 * the stored one — but it is still a live Cloudflare credential, and nothing revokes it for you. The upgrade
 * path is mint `runtime`, deploy, then revoke the old token, so this names every environment that has done
 * the first step and still holds the old one.
 *
 * **Once runtime is minted, and only then.** Before that, the old token is still the one that works, and a
 * finding would tell an operator to throw away the credential their uploads run on.
 *
 * The bundle is sealed under a key that never leaves the environment's manager, so the manager is asked
 * whether it carries the field — a bit, never the value. `dev` has no manager and is never asked.
 */
export function suppliedTokenCheck(): CapabilitySettings {
  return {
    local: () => [],
    async account(context) {
      const findings: SettingsFinding[] = [];
      const unanswered: UnansweredEnvironment[] = [];
      const provision = remedy("media provision", { flags: { "--worker": context.workerDirectory } });
      for (const { name: environment } of context.environments) {
        if (environment === LOCAL_ENVIRONMENT) continue;
        try {
          const runtime = runtimeTokenSecretName(context.project, environment as ManagedEnvironment);
          if (!(await context.account.storeEntry(runtime))) continue;
          const carries = await context.account.vaultSecretField({
            name: MEDIA_STORAGE_SECRET,
            environment,
            field: MEDIA_SUPPLIED_TOKEN_FIELD,
          });
          if (!carries) continue;
        } catch (cause) {
          unanswered.push({ environment, cause });
          continue;
        }
        findings.push({
          setting: `${MEDIA_STORAGE_SECRET} ${MEDIA_SUPPLIED_TOKEN_FIELD}`,
          environment,
          problem: `${MEDIA_STORAGE_SECRET} still holds the Images and Stream token supplied to ${commandName("media provision")}. The runtime token replaced it, and nothing reads it.`,
          action: `${provision.say((command) => `Run ${command} to rewrite the bundle without it.`)} Then revoke that token where it was made.`,
          ...(provision.fix === undefined ? {} : { fix: String(provision.fix) }),
        });
      }
      if (unanswered.length > 0) throw new SettingsAccountIncomplete(findings, unanswered);
      return findings;
    },
  };
}
