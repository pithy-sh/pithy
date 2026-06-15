import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { CloudflareSecretsStoreManager } from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";
import { resolveEncryptionConfig, type SecretsStoreEnv } from "../env/bindings";
import type { WriteSecretParams } from "../management/writeSecret";
import { isRotationDue } from "../rotation/keyRotation";
import { runRotationWorkflow } from "./rotationWorkflow";
import { SecretsStoreConfigWriter } from "./secretsConfigWriter";
import { runWriteWorkflow } from "./writeWorkflow";

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

/** The manager worker's env: the secrets D1 + key binding, the rotation Workflow binding, CF creds for the write-back. */
export interface SecretsManagerEnv extends SecretsStoreEnv {
  /** The at-rest rotation Workflow binding, triggered by the cron. */
  AT_REST_ROTATION: { create(): Promise<unknown> };
  /** CF creds + Secrets Store id for the at-rest config write-back — the only live-CF write. */
  CF_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  SECRETS_STORE_ID: string;
  /** Rotation cadence in days; defaults to 30. Sourced from the `rotationIntervalDays` config option. */
  ROTATION_INTERVAL_DAYS?: string;
}

/** The management write Workflow — the CLI dispatches create/update/remove here. */
export class SecretsWriteWorkflow extends WorkflowEntrypoint<SecretsManagerEnv, WriteSecretParams> {
  override async run(event: WorkflowEvent<WriteSecretParams>, step: WorkflowStep): Promise<void> {
    await step.do("write-secret", () => runWriteWorkflow(this.env, event.payload));
  }
}

/** The at-rest key-rotation Workflow — re-encrypts the store under a fresh master key. */
export class AtRestKeyRotationWorkflow extends WorkflowEntrypoint<SecretsManagerEnv, unknown> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    const manager = new CloudflareSecretsStoreManager({
      accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: this.env.CF_API_TOKEN,
      storeId: this.env.SECRETS_STORE_ID,
    });
    await runRotationWorkflow(this.env, new SecretsStoreConfigWriter(manager), step);
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
