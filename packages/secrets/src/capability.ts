import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { secretsTables } from "./data/tables";
import { secrets_0001_init } from "./migrations/0001_init";
import type { SecretRegistry } from "./registry";

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
}

/**
 * The secrets capability, with its registry attached. The attachment is what lets the
 * `pithy secrets` CLI discover the registry by loading `pithy.config.ts` and finding this
 * capability — no separate registry-loading convention needed.
 */
export interface SecretsCapability extends Capability {
  secretRegistry: SecretRegistry;
  rotationIntervalDays: number;
}

/**
 * The secrets capability. It contributes a **dedicated** `SECRETS` D1 database — distinct from the
 * app `DB`, because the app database is provisioned ephemerally per feature branch and secrets are
 * durable and shared, so they cannot be the same database. It requires the `SECRETS` D1 binding and
 * the `SECRETS_ENCRYPTION_KEYS` master-key binding (CF Secrets Store, worker-only), and carries the
 * project's {@link SecretRegistry}.
 */
export function secrets(config: SecretsConfig): SecretsCapability {
  const capability = defineCapability({
    name: "secrets",
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
  });
  return Object.assign(capability, {
    secretRegistry: config.registry,
    rotationIntervalDays: config.rotationIntervalDays ?? DEFAULT_ROTATION_INTERVAL_DAYS,
  });
}

/** Whether a capability is the secrets capability — carries a registry. The CLI uses this to discover it. */
export function isSecretsCapability(capability: Capability): capability is SecretsCapability {
  return capability.name === "secrets" && "secretRegistry" in capability;
}
