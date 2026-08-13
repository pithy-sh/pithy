// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { bindingValue } from "@pithy-sh/secrets/src/bindingValue";
import { dispatchSecretWrite, type SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { initialVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { mintSecretValue } from "@pithy-sh/secrets/src/mintValue";
import { isMintableSecret, type SecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
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
 * **Two creators, because there are two stores and each owns the absence check the other cannot make.**
 * A minted value is created once and never regenerated — a second session secret signs everyone out, a
 * second link key stops verifying links already in inboxes, a second key-encryption key orphans
 * everything sealed under the first — so "only if absent" is the property both have to hold.
 *
 * - {@link storeSecretMinter}, for `cf-secrets-store`. The CLI can read the account's store, so
 *   `secretsStoreBindings` asks whether the entry is there and this writes it when it is not.
 * - {@link mintDeclaredSecrets}, for `d1`. The CLI cannot read one: the value is sealed under a master
 *   key that never leaves the manager Worker. So it dispatches `ensure` and the manager — which holds
 *   the store — does the read and the write together, atomically. See `management/writeSecret.ts`.
 *
 * #321 shipped only the first, and the kit declares no `cf-secrets-store` secret that a random string
 * could satisfy, so nothing the kit ships could reach it. `provision/mintCoverage.test.ts` is the gate
 * that now says so, against the registries the kit actually ships rather than one a test made up.
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
    // Through `bindingValue`, never restating what it says. A Secrets Store entry is read by the Worker
    // straight off its binding, so what is written here is what the Worker gets — and a `bootstrap`
    // secret's binding carries the current value, not the envelope, because it is what the envelope
    // decoder needs in order to exist. This wrote an envelope unconditionally, which is the defect the
    // whole of #323's wave was about, reappearing at a new producer.
    await options.store.put(secretName, bindingValue(entry, initialVersionedValue(mintSecretValue(entry.devValue))));
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

/** One secret this run asked the managers to create, and the environments the request reached. */
export interface MintedSecret {
  /** The secret's registry name. Never its value. */
  name: string;
  /** The environments the write was dispatched to — one for an `environment` secret, all for a `global` one. */
  environments: ManagedEnvironment[];
}

/**
 * Create every `d1` secret the registry declares mintable, across the environments the project declares.
 *
 * **`ensure`, never `create` and never an upsert.** `create` fails on a re-run, which would make
 * provisioning a one-shot command; the `create`-then-`update` upsert the storage, turnstile and media
 * provisioners use is right for a credential the provisioner just obtained from a third party and is
 * wrong here, because it would replace a live minted key on every run. `ensure` writes only when the
 * name is absent, decided inside the manager where the check and the write are one read apart. See
 * `management/writeSecret.ts`.
 *
 * **Scope decides how many values are minted, and it is the whole reason this owns the environment
 * loop.** A `global` secret is minted **once** and fanned out unchanged — that is what `global` means,
 * and a value that differed per environment would leave a link signed in staging unverifiable in prod.
 * An `environment` secret is minted **afresh for each** — a staging session key that also signs prod
 * sessions makes the environment boundary decorative. A caller iterating environments and calling this
 * once per environment would get the first wrong, so it does not get to.
 *
 * `dispatchSecretWrite` still owns the routing, so where a write lands cannot disagree with where
 * `pithy secrets create` puts the same secret.
 *
 * Returns what it dispatched for, in registry order. Never a value.
 */
export async function mintDeclaredSecrets(options: {
  /** The registry to read — every declared secret, of every backend. This picks its own out. */
  registry: SecretRegistry;
  /** Where a write goes: the target environment's manager write-Workflow. */
  dispatcher: SecretDispatcher;
  /** Every environment the project declares. Both the targets and the fan-out set. */
  environments: DeclaredEnvironments | readonly string[];
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}): Promise<MintedSecret[]> {
  const audit = options.audit ?? (async () => {});
  const declared = [...options.environments] as ManagedEnvironment[];
  const minted: MintedSecret[] = [];
  for (const name of Object.keys(options.registry).sort()) {
    const entry = options.registry[name];
    // `cf-secrets-store` is the other creator's, and `isMintableSecret` refuses both a supplied secret
    // and a keyspace. The `devValue` re-check is for the type; the predicate is what decides.
    if (!entry) continue;
    if (entry.backend !== "d1") continue;
    if (!isMintableSecret(entry) || entry.devValue === undefined) continue;
    // A global write reaches every declared environment from any one request, so it is dispatched once.
    // `requested` is unread for that case (see `resolveWriteTargets`) but has to be a real environment.
    const requests = entry.scope === "global" ? declared.slice(0, 1) : declared;
    for (const requested of requests) {
      const environments = await dispatchSecretWrite(
        options.dispatcher,
        {
          mode: "ensure",
          name,
          backend: entry.backend,
          scope: entry.scope,
          rotatable: entry.rotatable,
          valueType: entry.valueType,
          value: mintSecretValue(entry.devValue),
          requested,
        },
        options.environments,
      );
      minted.push({ name, environments });
      // The name and where it was sent. Never the value. `mode: ensure` is recorded because it is the
      // honest limit of what the CLI knows: the manager decides whether a value was written and does not
      // report back, so this says a creation was dispatched rather than claiming one happened.
      await audit({
        environment: requested,
        action: "secrets/set",
        outcome: "success",
        severity: "warning",
        resourceType: "secret",
        resourceId: name,
        metadata: { name, environments, kind: "generated", mode: "ensure" },
      });
    }
  }
  return minted;
}
