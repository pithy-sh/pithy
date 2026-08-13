// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { encodeVersionedValue, initialVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { mintDevValue } from "@pithy-sh/secrets/src/devValue";
import { isMintableSecret } from "@pithy-sh/secrets/src/registry";
import type { CliAuditEmit } from "../audit/cliAudit";
import type { MintStoreSecret } from "../provision/secretBindings";

/**
 * **Creating the secrets nobody chooses.**
 *
 * `pithy provision --env staging --yes` used to create three databases and then print three commands for
 * a human to run, each of which generates random bytes. `--yes` had been passed. The registry already
 * said which secrets those were — `devValue`, declared by the capability that owns each one — and only
 * local dev ever read it (#321).
 *
 * This is the deployed-environment reader of that same declaration. It mints one value and writes it
 * into the account's Secrets Store as the uniform `{ currentVersion, versions }` envelope every other
 * secret of that backend is stored as, so the Worker's `secretsStore` decodes it with no special case.
 *
 * **The value exists in one local and nowhere else.** It is never returned, never logged, never put in an
 * audit event, and never printed by the command that called this. What a run reports is that the secret
 * was created and which entry it went to.
 */

/** The slice of the Secrets Store minting needs: write an entry. Never reads, never deletes. */
export interface MintDestination {
  /** Write a value under `name`. Overwrites in place — which is why the caller checks absence first. */
  put(name: string, value: string): Promise<void>;
}

/** Build the live minter for one environment's Secrets Store. */
export function storeSecretMinter(options: {
  /** Where the value goes. */
  store: MintDestination;
  /** The environment being provisioned, for the audit trail. Never part of the entry name — the scope owns that. */
  environment: string;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}): MintStoreSecret {
  const audit = options.audit ?? (async () => {});
  return async ({ binding, secretName, entry }) => {
    // Defence in depth. `secretsStoreBindings` asks `isMintableSecret` before calling, so arriving here
    // with a supplied secret is a bug — and one that would write a random string where an OAuth client
    // secret was meant, leaving a gap that looks filled in. It refuses instead of inventing.
    if (!isMintableSecret(entry) || entry.devValue === undefined) {
      throw new InternalError({
        message: `Secret '${binding}' declares no value of its own, so nothing may mint one.`,
        detail: `mint called for ${secretName}, whose registry entry has no devValue.`,
      });
    }
    await options.store.put(secretName, encodeVersionedValue(initialVersionedValue(mintDevValue(entry.devValue))));
    // The name, the entry, the environment. Never the value, and nothing derived from it.
    await audit({
      environment: options.environment,
      action: "secrets/set",
      outcome: "success",
      severity: "warning",
      resourceType: "secret",
      resourceId: secretName,
      metadata: { name: secretName, binding, kind: "generated" },
    });
  };
}
