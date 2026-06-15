import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { SecretRotation } from "./data/secretRotations";
import { SystemSecret } from "./data/systemSecrets";
import { secrets_0001_init } from "./migrations/0001_init";

/** Sort order of the secrets migrations within the `SECRETS` database. */
const SECRETS_MIGRATION_ORDER = 100;

/**
 * The secrets capability. It contributes a **dedicated** `SECRETS` D1 database — distinct
 * from the app `DB`, because the app database is provisioned ephemerally per feature branch
 * and secrets are durable and shared, so they cannot be the same database. The capability
 * requires the `SECRETS` D1 binding and the `SECRETS_ENCRYPTION_KEYS` master-key binding
 * (from CF Secrets Store, worker-only).
 *
 * The management Workflow, the at-rest rotation cron, and the per-environment manager worker
 * land in later slices; this is the data-model foundation.
 */
export function secrets() {
  return defineCapability({
    name: "secrets",
    requiredBindings: [
      { type: "d1", name: "SECRETS" },
      { type: "secret", name: "SECRETS_ENCRYPTION_KEYS" },
    ],
    databases: {
      secrets: {
        binding: "SECRETS",
        tables: {
          pithySecretsSystemSecrets: SystemSecret,
          pithySecretsRotations: SecretRotation,
        },
        migrationOrder: SECRETS_MIGRATION_ORDER,
        migrations: {
          "0001_init": secrets_0001_init,
        },
      },
    },
  });
}
