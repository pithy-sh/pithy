// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { secretsTables } from "./data/tables";
import { secrets_0001_init } from "./migrations/0001_init";
import { MANAGER_CF_API_TOKEN_SECRET_NAME } from "./provision/provisionSecrets";
import type { SecretRegistry } from "./registry";
import {
  aggregateSecretRegistries,
  configureSharedSecrets,
  DEFAULT_SECRETS_CACHE_TTL_SECONDS,
} from "./sharedSecretsStore";

/**
 * The secrets manager's own token profile — the standard default for its least-privilege runtime
 * credential. Declared here, next to the capability, and consumed as the single source of that scope
 * (the CLI provisioner mints the manager token from it). Its value lands in the CF Secrets Store entry
 * the manager binds (`GLOBAL_SECRETS_MANAGER_CF_API_TOKEN`); Secrets Store read + write, nothing else.
 */
export const secretsTokenProfile = {
  permissions: ["secrets:read", "secrets:write"],
  secret: MANAGER_CF_API_TOKEN_SECRET_NAME,
  defaultStore: "secrets-store",
  description: "The secrets manager's runtime credential — reads and writes CF Secrets Store from its Worker.",
} as const;

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
 * project's {@link SecretRegistry}.
 */
export function secrets(config: SecretsConfig): SecretsCapability {
  const ttlSeconds = config.secretsCacheTtlSeconds ?? DEFAULT_SECRETS_CACHE_TTL_SECONDS;
  const capability = defineCapability({
    name: "secrets",
    secretRegistry: config.registry,
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
    // At worker startup, merge every capability's secret-registry slice into one combined registry and
    // back the shared per-invocation accessor from it — so all secrets resolve in one batch, shared
    // across capabilities, with this capability's configured TTL.
    compose: ({ capabilities }) => {
      configureSharedSecrets({ registry: aggregateSecretRegistries(capabilities), ttlSeconds });
    },
  });
  return Object.assign(capability, {
    secretRegistry: config.registry,
    rotationIntervalDays: config.rotationIntervalDays ?? DEFAULT_ROTATION_INTERVAL_DAYS,
    secretsCacheTtlSeconds: ttlSeconds,
  });
}

/** Whether a capability is the secrets capability — carries a registry. The CLI uses this to discover it. */
export function isSecretsCapability(capability: Capability): capability is SecretsCapability {
  return capability.name === "secrets" && "secretRegistry" in capability;
}
