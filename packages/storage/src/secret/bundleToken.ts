// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  type CapabilitySettings,
  SettingsAccountIncomplete,
  type SettingsFinding,
  type UnansweredEnvironment,
} from "@pithy-sh/core/src/capability/settings";
import { remedy } from "@pithy-sh/core/src/cli/command";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { runtimeTokenSecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";

/** The field an R2 bundle carried a Cloudflare API token in, before #728. */
export const R2_BUNDLE_TOKEN_FIELD = "apiToken";

/**
 * **`pithy doctor`'s check for a Cloudflare API token still stored in an R2 bundle (#728).**
 *
 * Until #728, `pithy storage provision` and `pithy media provision` wrote a Cloudflare API token into the
 * R2 bundle beside the key pair — the bootstrap one, unless the operator passed another. Nothing reads it:
 * the object store signs every call with the pair. It is still a credential the application holds, and a
 * deployed application holds one, `runtime`. The provision rewrites the bundle whole, so re-running it is
 * the fix.
 *
 * Asked once `runtime` is minted in an environment, which is the mark that it has taken the upgrade, the
 * way media's check for its own supplied token is. The bundle is sealed under a key that never leaves the
 * manager, so the manager is asked whether it carries the field — a bit, never the value. `dev` has no
 * manager and is never asked.
 */
export function bundleTokenCheck(options: { secret: string; provision: string }): CapabilitySettings {
  return {
    local: () => [],
    async account(context) {
      const findings: SettingsFinding[] = [];
      const unanswered: UnansweredEnvironment[] = [];
      const provision = remedy(options.provision, { flags: { "--worker": context.workerDirectory } });
      for (const { name: environment } of context.environments) {
        if (environment === LOCAL_ENVIRONMENT) continue;
        try {
          const runtime = runtimeTokenSecretName(context.project, environment as ManagedEnvironment);
          if (!(await context.account.storeEntry(runtime))) continue;
          const carries = await context.account.vaultSecretField({
            name: options.secret,
            environment,
            field: R2_BUNDLE_TOKEN_FIELD,
          });
          if (!carries) continue;
        } catch (cause) {
          unanswered.push({ environment, cause });
          continue;
        }
        findings.push({
          setting: `${options.secret} ${R2_BUNDLE_TOKEN_FIELD}`,
          environment,
          problem: `${options.secret} still holds a Cloudflare API token beside the R2 key pair. Nothing reads it, and the application holds one token: runtime.`,
          action: `${provision.say((command) => `Run ${command} to rewrite the bundle without it.`)} Then revoke that token if it was made for R2.`,
          ...(provision.fix === undefined ? {} : { fix: String(provision.fix) }),
        });
      }
      if (unanswered.length > 0) throw new SettingsAccountIncomplete(findings, unanswered);
      return findings;
    },
  };
}
