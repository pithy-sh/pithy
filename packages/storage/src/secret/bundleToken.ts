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
 * **The app Workers move first.** A Worker on the kit before #728 requires the token in this bundle, and the
 * new kit reads the old bundle as well as the new one. So deploying the app on this kit, then rewriting, has
 * no gap; the other order has one.
 */
const UPGRADE_FIRST = "Deploy your app Workers on this kit first. An older one cannot read the rewritten bundle.";

/**
 * **Nothing to revoke.** The bundle's token was the bootstrap one unless the operator passed another, and the
 * one they passed was the R2 token the S3 key pair derives from: an R2 access key is a Cloudflare API token,
 * its id the key id. Revoking that parent invalidates the pair the rewritten bundle still signs with.
 */
const KEEP_THE_TOKEN =
  "Keep that token. It is your bootstrap one, or the R2 token the key pair derives from, and revoking that breaks the pair.";

/**
 * **`pithy doctor`'s check for a Cloudflare API token still stored in an R2 bundle (#728).**
 *
 * Until #728, `pithy storage provision` and `pithy media provision` wrote a Cloudflare API token into the
 * R2 bundle beside the key pair — the bootstrap one, unless the operator passed another. Nothing reads it:
 * the object store signs every call with the pair. It is still a credential the application holds, and a
 * deployed application holds one, `runtime`. The provision rewrites the bundle whole, so re-running it — once
 * the app Workers run this kit — is the fix. The token itself stays: see {@link KEEP_THE_TOKEN}.
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
          action: `${UPGRADE_FIRST} ${provision.say((command) => `Then run ${command} to rewrite the bundle without it.`)} ${KEEP_THE_TOKEN}`,
          ...(provision.fix === undefined ? {} : { fix: String(provision.fix) }),
        });
      }
      if (unanswered.length > 0) throw new SettingsAccountIncomplete(findings, unanswered);
      return findings;
    },
  };
}
