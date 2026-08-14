// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { EncryptionConfig } from "./crypto/envelope";
import { secretsTables } from "./data/tables";
import { MASTER_KEY_BINDING } from "./env/bindings";
import { secretsAdminRoutes } from "./http/guards";
import { registerSecretsRoutes, SECRETS_DEFAULT_BASE_PATH } from "./http/routes";
import { secrets_0001_init } from "./migrations/0001_init";
import { MANAGER_CF_API_TOKEN_SECRET } from "./provision/provisionSecrets";
import { defineSecretRegistry, type SecretRegistry, type SecretRegistryEntry } from "./registry";
import {
  aggregateSecretRegistries,
  configureSharedSecrets,
  DEFAULT_SECRETS_CACHE_TTL_SECONDS,
} from "./sharedSecretsStore";
import { PACKAGE_VERSION } from "./version.generated";

/**
 * The secrets manager's own token profile — the standard default for its least-privilege runtime
 * credential. Declared here, next to the capability, and consumed as the single source of that scope
 * (the CLI provisioner mints the manager token from it). Secrets Store read + write, nothing else.
 *
 * `secretScope: "global"` is load-bearing, not documentation. It puts the literal `global` in the
 * environment slot of the store entry the minted value is written to, so `pithy token mint secrets`
 * lands on `<project>-global-secrets-manager-cf-api-token` — byte-identical to what
 * `managerCfApiTokenSecretName` provisions and what the manager's `CLOUDFLARE_API_TOKEN` binding
 * reads. Drop it and a mint writes a per-environment entry nothing binds, leaving the manager on a
 * credential the operator believes they just rolled.
 */
export const secretsTokenProfile = {
  permissions: ["secrets:read", "secrets:write"],
  secret: MANAGER_CF_API_TOKEN_SECRET,
  secretScope: "global",
  defaultStore: "secrets-store",
  description: "The secrets manager's runtime credential — reads and writes CF Secrets Store from its Worker.",
} as const;

/**
 * The master key, declared as what it already is: a `cf-secrets-store` secret, one value for the whole
 * project, read from the `SECRETS_ENCRYPTION_KEYS` binding (#179).
 *
 * **It was a bare `requiredBindings` entry with no backend, scope, rotatable or valueType** — so nothing
 * could route it, and local dev had to keep it in a file of its own with a special case at every reader.
 * Production has always stored it in the account's Secrets Store, under the entry `masterKeySecretName`
 * composes; this records that, and dev then materialises it from `secrets.jsonc` like every other secret
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
  notes: "The at-rest master key every other secret is encrypted under. Minted by pithy add secrets.",
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
    // The package version this capability ships at, stamped by `scripts/stampVersions.ts` — a Worker
    // cannot read its own package.json. Reported per capability by the control-plane manifest.
    version: PACKAGE_VERSION,
    secretRegistry: registry,
    tokenProfiles: { secrets: secretsTokenProfile },
    requiredBindings: [
      { type: "d1", name: "SECRETS" },
      { type: "secret", name: "SECRETS_ENCRYPTION_KEYS" },
    ],
    databases: {
      secrets: {
        binding: "SECRETS",
        tables: secretsTables,
        migrationOrder: SECRETS_MIGRATION_ORDER,
        migrations: { "0001_init": secrets_0001_init },
      },
    },
    routes: registerSecretsRoutes({ registry: () => reported.current, basePath: mountPath }),
    // Built from the resolved mount path, never the default: an adopter who mounts this at `/vault` gets
    // a manifest naming `/vault/admin/status`, which is what a management client composes its calls from.
    adminRoutes: secretsAdminRoutes(mountPath),
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
    rotationIntervalDays: config.rotationIntervalDays ?? DEFAULT_ROTATION_INTERVAL_DAYS,
    secretsCacheTtlSeconds: ttlSeconds,
  });
}

/** Whether a capability is the secrets capability — carries a registry. The CLI uses this to discover it. */
export function isSecretsCapability(capability: Capability): capability is SecretsCapability {
  return capability.name === "secrets" && "secretRegistry" in capability;
}
