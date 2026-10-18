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
 * **The app Workers move first.** A Worker on the kit before #728 requires the token in this bundle, and the
 * new kit reads the old bundle as well as the new one. So deploying the app on this kit, then rewriting, has
 * no gap; the other order has one.
 */
const UPGRADE_FIRST = "Deploy your app Workers on this kit first. An older one cannot read the rewritten bundle.";

/**
 * **Which token to revoke, said with its default.** `pithy media provision` stored `--api-token` when one was
 * passed, and the bootstrap `CLOUDFLARE_API_TOKEN` otherwise. A bare "revoke it" revokes the operator's own.
 */
const REVOKE_IF_MADE_FOR_MEDIA =
  "Revoke that token only if you made it for media. Unless you passed --api-token, it is your bootstrap CLOUDFLARE_API_TOKEN: keep it.";

/**
 * **`pithy doctor`'s check for the media token the runtime token superseded (#728).**
 *
 * Until #728, `pithy media provision` asked for an Images and Stream token and stored it in
 * `media-storage-credentials`. The application's one `runtime` token now does that job, and nothing reads
 * the stored one — but the deployed application still holds it, and an application holds one token. The
 * upgrade path is mint `runtime`, deploy the app Workers on this kit, then rewrite the bundle, so this names
 * every environment that has done the first step and still holds the old one. Whether to revoke it as well
 * depends on what it was: by default, the operator's own bootstrap token.
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
          action: `${UPGRADE_FIRST} ${provision.say((command) => `Then run ${command} to rewrite the bundle without it.`)} ${REVOKE_IF_MADE_FOR_MEDIA}`,
          ...(provision.fix === undefined ? {} : { fix: String(provision.fix) }),
        });
      }
      if (unanswered.length > 0) throw new SettingsAccountIncomplete(findings, unanswered);
      return findings;
    },
  };
}
