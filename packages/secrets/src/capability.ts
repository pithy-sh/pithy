// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { EncryptionConfig } from "@pithy-sh/core/src/crypto/envelope";
import { secretsHealth } from "./admin/health";
import { secretsRetainedTables, secretsTables } from "./data/tables";
import { MASTER_KEY_BINDING } from "./env/masterKeyBinding";
import { secretsAdminRoutes } from "./http/guards";
import { registerSecretsRoutes, SECRETS_DEFAULT_BASE_PATH } from "./http/routes";
import { SECRETS_RUNTIME_PERMISSIONS } from "./manager/managerRegistry";
import { secretsMigrations } from "./migrations/secretsMigrations";
import { supersededManagerToken } from "./provision/supersededToken";
import { defineSecretRegistry, type SecretRegistry, type SecretRegistryEntry } from "./registry";
import {
  aggregateSecretRegistries,
  configureSharedSecrets,
  DEFAULT_SECRETS_CACHE_TTL_SECONDS,
} from "./sharedSecretsStore";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.generated";

/**
 * The master key, declared as what it already is: a `cf-secrets-store` secret, one value for the whole
 * project, read from the `SECRETS_ENCRYPTION_KEYS` binding (#179).
 *
 * **It was a bare `requiredBindings` entry with no backend, scope, rotatable or valueType** — so nothing
 * could route it, and local dev had to keep it in a file of its own with a special case at every reader.
 * Production has always stored it in the account's Secrets Store, under the entry `masterKeySecretName`
 * composes; this records that, and dev then materializes it from `secrets.jsonc` like every other secret
 * of that backend.
 *
 * **`json`, against `EncryptionConfig`, because that is what the value is.** A hand-edit that drops
 * `lastRotatedAt` or mistypes a key version is caught by the seeder naming the secret, rather than by a
 * Worker answering every request with `secrets/crypto_failed`.
 *
 * **`bootstrap`, because the Worker reads it without the decoder.** See the axis for why that is the one
 * secret whose binding carries its value rather than its envelope — and, since #323, the one secret whose
 * entry in `secrets.jsonc` is that value rather than an envelope around it. Both statements are the same
 * rule: the file states the payload the destination receives.
 *
 * **No `devValue`.** A random string is not an `EncryptionConfig`, and the registry refuses `devValue` on
 * a non-text entry for exactly that reason. `pithy add secrets` mints one properly, through
 * `initialMasterKeyConfig`, and writes it into `secrets.jsonc`.
 *
 * **`rotatable: false` is about *value* versions, not key versions.** The master key rotates on the
 * `versions` map inside its own `EncryptionConfig` — that is what `atRestKeyRotation` walks — and a
 * second value-envelope version on top would be a second rotation axis for one key.
 *
 * **`origin` is a structured mint, and that is why `SecretRecipe` is a union (#322).** The issue that
 * introduced these axes asserted this secret was minted from a random string. It is minted — by
 * `initialMasterKeyConfig` — and its value is an `EncryptionConfig`, so a `recipe` that knew only
 * `random` would have failed on the first secret it was drafted around. `recipe: "encryptionConfig"` says
 * both halves, which is why the entry still carries no `devValue` and `isMintableSecret` still answers
 * false: nothing arbitrary fills this.
 *
 * **`rotation: "local"` and `rotatable: false` are not in conflict.** They answer different questions.
 * Replacing this value is something the kit does entirely by itself — that is `local`. Whether the stored
 * *envelope* accumulates versions is `rotatable`, and here it does not, because the versions live inside
 * the value.
 */
export const masterKeyRegistryEntry: SecretRegistryEntry = {
  backend: "cf-secrets-store",
  scope: "environment",
  rotatable: false,
  bootstrap: true,
  valueType: "json",
  schema: EncryptionConfig,
  origin: { kind: "minted", recipe: { kind: "encryptionConfig" } },
  rotation: { kind: "local" },
  notes: `The at-rest master key every other secret is encrypted under. Minted when ${commandName("add")} composes secrets.`,
};

/**
 * **The field key, as a registry entry (#390)** — `PITHY_FIELD_KEYS`, what app Workers seal `encrypted()` fields
 * with. The master key's shape and the master key's origin, and **never the master key**: an app Worker that holds
 * an encrypted field holds this, and only this, so one compromised app Worker cannot open the vault.
 *
 * Not in {@link secrets}' own registry. It is bound to a Worker because that Worker *holds an encrypted field*, not
 * because it composes this capability, so the CLI adds it to exactly those Workers' registries
 * (`cli/src/provision/secretBindings.ts`). `pithy secrets provision` mints it beside the master key, and the
 * manager's at-rest cron rotates it on the field key's own period.
 */
export const fieldKeysRegistryEntry: SecretRegistryEntry = {
  backend: "cf-secrets-store",
  scope: "environment",
  rotatable: false,
  bootstrap: true,
  valueType: "json",
  schema: EncryptionConfig,
  origin: { kind: "minted", recipe: { kind: "encryptionConfig" } },
  rotation: { kind: "local" },
  notes: `The key app Workers seal encrypted fields with. Minted by ${commandName("secrets provision")} and rotated by the manager every 30 days.`,
};

/** Sort order of the secrets migrations within the `SECRETS` database. */
const SECRETS_MIGRATION_ORDER = 100;

/** Default at-rest key-rotation cadence, in days. */
const DEFAULT_ROTATION_INTERVAL_DAYS = 30;

/** Configuration for the secrets capability, passed in `pithy.config.ts`. */
export interface SecretsConfig {
  /**
   * The project's secret registry — the single source of truth for backend, scope, rotatability,
   * value type, and (for json) schema, per secret. Both the worker's `secretsStore` and the
   * `pithy secrets` CLI read it: the CLI discovers it off this capability in `pithy.config.ts`.
   */
  registry: SecretRegistry;
  /** At-rest key-rotation cadence in days. Defaults to 30. Surfaced as the `rotationIntervalDays` option. */
  rotationIntervalDays?: number;
  /**
   * Lifetime in seconds of the shared per-invocation secrets cache. Within one worker invocation
   * every capability's secrets are resolved once and reused for this long; after it elapses the next
   * access re-fetches the full combined set. Defaults to 60. Lower it to pick up a rotated secret
   * sooner; raise it to cut Secrets Store round-trips further.
   */
  secretsCacheTtlSeconds?: number;
  /**
   * Mount the management surface somewhere other than `/secrets`. Moves the paths the control-plane
   * manifest advertises with it, so a client composing its calls from the manifest follows.
   */
  basePath?: string;
}

/**
 * The secrets capability, with its registry attached. The attachment is what lets the
 * `pithy secrets` CLI discover the registry by loading `pithy.config.ts` and finding this
 * capability — no separate registry-loading convention needed.
 */
export interface SecretsCapability extends Capability {
  secretRegistry: SecretRegistry;
  rotationIntervalDays: number;
  secretsCacheTtlSeconds: number;
}

/**
 * The secrets capability. It contributes a **dedicated** `SECRETS` D1 database — distinct from the
 * app `DB`, because the app database is provisioned ephemerally per feature branch and secrets are
 * durable and shared, so they cannot be the same database. It requires the `SECRETS` D1 binding and
 * the `SECRETS_ENCRYPTION_KEYS` master-key binding (CF Secrets Store, worker-only), and carries the
 * project's {@link SecretRegistry} — with {@link masterKeyRegistryEntry} merged in, so the binding it
 * requires and the secret that fills it are one declaration rather than two that can drift.
 *
 * It also contributes a **read-only** control-plane surface behind `secrets:status:read` — when each
 * secret was last rotated, and whether it is past the cadence its registry entry declares. Metadata
 * only, and structurally so: `http/responses.ts` has no field that could carry a value. Like every
 * capability's, the routes are always mounted and default-denied — with `controlplane()` uncomposed each
 * one raises `controlplane/not_connected`, because a management surface that appears only when something
 * else is installed is a surface nobody can discover.
 */
export function secrets(config: SecretsConfig): SecretsCapability {
  const ttlSeconds = config.secretsCacheTtlSeconds ?? DEFAULT_SECRETS_CACHE_TTL_SECONDS;
  // Resolved once, here, for the same reason `mountPath` is: two consumers, and a default applied twice
  // is a default that can be applied differently. The health key grades the last at-rest pass against
  // this cadence, and `SecretsCapability.rotationIntervalDays` is what the CLI writes into the manager
  // Worker's `ROTATION_INTERVAL_DAYS` var — so a project reporting "the rotation stopped" and a cron
  // deciding "it is time to rotate" are reading one number.
  const rotationIntervalDays = config.rotationIntervalDays ?? DEFAULT_ROTATION_INTERVAL_DAYS;
  // The capability's own secret, merged under the adopter's so a project that declares nothing still has
  // a routable master key — and so an adopter who deliberately overrides the entry keeps that power.
  //
  // Validated on the way out, because the merge is what produces the registry everything else reads and
  // it is the one registry nothing had checked: `masterKeyRegistryEntry` is a plain const, and an
  // override arrives from `pithy.config.ts` where an adopter may well have written an object literal.
  // Re-checking an already-defined registry costs nothing and is the difference between a contradiction
  // caught at boot and one discovered by a client rendering it.
  const registry: SecretRegistry = defineSecretRegistry({
    [MASTER_KEY_BINDING]: masterKeyRegistryEntry,
    ...config.registry,
  });
  // Resolved once, here, and handed to both the router and the manifest — so the advertised admin paths
  // and the mounted ones cannot disagree about where the surface lives.
  const mountPath = config.basePath ?? SECRETS_DEFAULT_BASE_PATH;
  // What the status surface reports over, replaced by `compose` with the combined registry. It starts as
  // this capability's own so a Worker that somehow answers before composing still reports honestly
  // rather than emptily; after compose it is every capability's, which is the useful answer — a project's
  // auth signing key and email link key are secrets its owner needs the status of just as much.
  const reported = { current: registry };
  const capability = defineCapability({
    name: "secrets",
    // The package this capability ships in and the version it ships at, both stamped by
    // `scripts/stampVersions.ts` — a Worker cannot read its own package.json. Reported per capability by
    // the control-plane manifest, and reported together: a release feed is keyed by package name, so the
    // version alone leaves a client guessing the key (#626).
    version: PACKAGE_VERSION,
    package: PACKAGE_NAME,
    secretRegistry: registry,
    // The manager's needs, unioned into the one `runtime` token. Never a token of its own (#728).
    runtimePermissions: SECRETS_RUNTIME_PERMISSIONS,
    // `pithy doctor` names the manager token `runtime` superseded while it is still in the account, since
    // nothing revokes it for you (#728).
    settings: supersededManagerToken(),
    requiredBindings: [
      { type: "d1", name: "SECRETS" },
      { type: "secret", name: "SECRETS_ENCRYPTION_KEYS" },
    ],
    databases: {
      secrets: {
        binding: "SECRETS",
        tables: secretsTables,
        migrationOrder: SECRETS_MIGRATION_ORDER,
        migrations: { ...secretsMigrations },
        // The vault. A sealed credential Google or Paddle issued exists here and in their console, nowhere
        // else, and rotation history is the only record of when a key last moved. Declared retained, so no
        // `down` runs here while either table holds rows unless the operator counts them (#588). The
        // registry `0002_tables` adds is not: every row in it is written by a declared table's own
        // migration, which sorts after it and is reversed before it.
        retained: secretsRetainedTables,
      },
    },
    routes: registerSecretsRoutes({ registry: () => reported.current, basePath: mountPath }),
    // Built from the resolved mount path, never the default: an adopter who mounts this at `/vault` gets
    // a manifest naming `/vault/admin/status`, which is what a management client composes its calls from.
    adminRoutes: secretsAdminRoutes(mountPath),
    // One number on the manifest entry — how many secrets are past their declared cadence — so a client
    // renders "3 need rotating" beside the rail from the read it already made, instead of spending a
    // credential per screen load to ask (#317). Behind the same scope as the listing it summarizes, and
    // over the same combined registry, so a secret whose freshness can be seen is one this counts.
    //
    // And one outcome beside it: how the last whole-store at-rest key rotation ended, graded against the
    // cadence above so a cron that stopped firing stops reading as healthy (#647).
    health: secretsHealth(() => reported.current, rotationIntervalDays),
    // At worker startup, merge every capability's secret-registry slice into one combined registry and
    // back the shared per-invocation accessor from it — so all secrets resolve in one batch, shared
    // across capabilities, with this capability's configured TTL.
    compose: ({ capabilities }) => {
      const combined = aggregateSecretRegistries(capabilities);
      configureSharedSecrets({ registry: combined, ttlSeconds });
      // The same combined set the accessor resolves is the set the status surface reports. One
      // aggregation, so a secret that can be read is a secret whose freshness can be seen.
      reported.current = combined;
    },
  });
  return Object.assign(capability, {
    secretRegistry: registry,
    rotationIntervalDays,
    secretsCacheTtlSeconds: ttlSeconds,
  });
}

/** Whether a capability is the secrets capability — carries a registry. The CLI uses this to discover it. */
export function isSecretsCapability(capability: Capability): capability is SecretsCapability {
  return capability.name === "secrets" && "secretRegistry" in capability;
}
