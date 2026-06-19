import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { CloudflareSecretsStoreManager } from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";
import { resolveEncryptionConfig, type SecretBinding, type SecretsStoreEnv } from "../env/bindings";
import { isRotationDue } from "../rotation/keyRotation";
import type { ManagedEnvironment } from "../scope";
import { configureSharedSecrets, sharedSecretsStore } from "../sharedSecretsStore";
import { managerRegistry } from "./managerRegistry";
import { runRotationWorkflow } from "./rotationWorkflow";
import { rotationConfigWriter } from "./secretsConfigWriter";
import { runWriteWorkflow, type WriteWorkflowPayload, type WriteWorkflowResult } from "./writeWorkflow";

/**
 * The prebuilt per-environment secrets manager worker. `pithy add secrets` deploys one per managed
 * environment (`pithy-secrets-staging`, `pithy-secrets-production`); the user authors no code for it.
 * It hosts two Workflows and a cron:
 *
 *   - `SecretsWriteWorkflow` — the CLI's dispatch target for create/update/remove.
 *   - `AtRestKeyRotationWorkflow` — re-encrypts the store under a fresh master key.
 *   - `scheduled()` — fires the rotation Workflow when the configured interval has elapsed.
 *
 * The Workflow bodies (`runWriteWorkflow`, `runRotationWorkflow`) are tested against Miniflare; these
 * classes are the thin durable-execution shells over them. This module imports `cloudflare:workers`,
 * so it runs only in the Workers runtime (excluded from the node meta-test).
 */

const DEFAULT_ROTATION_INTERVAL_DAYS = 30;

// This is a standalone worker, not assembled by `createBackend`, so its `compose` hook never runs.
// Configure the shared per-invocation accessor directly from the manager's own registry, so reads go
// through the one cached path (a rotation run reads `CLOUDFLARE_API_TOKEN` once) like every other worker.
configureSharedSecrets({ registry: managerRegistry });

/** The manager worker's env: the secrets D1 + key binding, the rotation Workflow binding, CF creds for the write-back. */
export interface SecretsManagerEnv extends SecretsStoreEnv {
  /** The at-rest rotation Workflow binding, triggered by the cron. */
  AT_REST_ROTATION: { create(): Promise<unknown> };
  /**
   * The scoped CF API token for the at-rest config write-back — the only live-CF write. A
   * `cf-secrets-store` binding read via `sharedSecretsStore(env, managerRegistry).get("CLOUDFLARE_API_TOKEN")`,
   * a string from `.dev.vars` in local dev. Never a plaintext env var.
   */
  CLOUDFLARE_API_TOKEN: SecretBinding | string;
  CLOUDFLARE_ACCOUNT_ID: string;
  SECRETS_STORE_ID: string;
  /**
   * This manager's environment. The rotation write-back uses it to target the env-prefixed master-key
   * store entry — the same entry the `SECRETS_ENCRYPTION_KEYS` binding reads — so a rotation persists
   * to the entry the worker actually binds. Filled at provision from `managedEnvironments()`; still
   * `ManagedEnvironment.parse`d at the read site, since a wrangler var is external config.
   */
  ENVIRONMENT: ManagedEnvironment;
  /** Rotation cadence in days; defaults to 30. Sourced from the `rotationIntervalDays` config option. */
  ROTATION_INTERVAL_DAYS?: string;
}

/** The management write Workflow — the CLI dispatches create/update/remove here. */
export class SecretsWriteWorkflow extends WorkflowEntrypoint<SecretsManagerEnv, WriteWorkflowPayload> {
  override async run(event: WorkflowEvent<WriteWorkflowPayload>, step: WorkflowStep): Promise<WriteWorkflowResult> {
    return await step.do("write-secret", () => runWriteWorkflow(this.env, event.payload));
  }
}

/** The at-rest key-rotation Workflow — re-encrypts the store under a fresh master key. */
export class AtRestKeyRotationWorkflow extends WorkflowEntrypoint<SecretsManagerEnv, unknown> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    // Build the manager's secret accessor once; read the CF API token at the point of need. Every
    // place a secret is consumed is a visible `secrets.get(...)` call site (grep-able), never hidden
    // behind a wrapper.
    const secrets = await sharedSecretsStore(this.env, managerRegistry);
    const manager = new CloudflareSecretsStoreManager({
      accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: secrets.get("CLOUDFLARE_API_TOKEN"),
      storeId: this.env.SECRETS_STORE_ID,
    });
    // The writer targets the env-prefixed master-key entry this worker actually binds (see
    // rotationConfigWriter) — not the unprefixed default — so the rotation persists where it's read.
    await runRotationWorkflow(this.env, rotationConfigWriter(manager, this.env.ENVIRONMENT), step);
  }
}

export default {
  /** Cron entry: trigger the at-rest rotation Workflow only when the interval has elapsed. */
  async scheduled(_controller: unknown, env: SecretsManagerEnv): Promise<void> {
    const config = await resolveEncryptionConfig(env);
    const intervalDays = Number(env.ROTATION_INTERVAL_DAYS ?? DEFAULT_ROTATION_INTERVAL_DAYS);
    if (isRotationDue(config.lastRotatedAt, intervalDays)) {
      await env.AT_REST_ROTATION.create();
    }
  },
};
