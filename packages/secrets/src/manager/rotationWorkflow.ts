import { createDatabase } from "@pithy-sh/core/src/data/db";
import { secretsTables } from "../data/tables";
import { resolveEncryptionConfig, type SecretsStoreEnv } from "../env/bindings";
import { type AtRestRotationResult, runAtRestKeyRotation, type StepRunner } from "../rotation/atRestKeyRotation";
import { RotationTracker } from "../store/rotationTracker";
import type { ConfigWriter } from "./configWriter";

/**
 * The at-rest key-rotation Workflow's body: build the store, config, and tracker from the worker
 * env and run the rotation core in durable steps. The `configWriter` is injected so this is testable
 * against Miniflare with a stub (the only thing that needs a live CF Secrets Store is the write-back
 * itself); the deployed worker passes the real `SecretsStoreConfigWriter`.
 */
export async function runRotationWorkflow(
  env: SecretsStoreEnv,
  configWriter: ConfigWriter,
  step: StepRunner,
): Promise<AtRestRotationResult> {
  const config = await resolveEncryptionConfig(env);
  const db = createDatabase(env.SECRETS, secretsTables);
  const tracker = RotationTracker.fromD1(env.SECRETS);
  return runAtRestKeyRotation({ db, config, configWriter, tracker }, step);
}
