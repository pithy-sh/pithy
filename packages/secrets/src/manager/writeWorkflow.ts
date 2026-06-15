import type { SecretsStoreEnv } from "../env/bindings";
import { runWriteSecret, type WriteSecretParams } from "../management/writeSecret";
import { RotationTracker } from "../store/rotationTracker";
import { SystemSecretsStore } from "../store/systemSecretsStore";

/**
 * The management write Workflow's body: build the store + tracker from the worker env and run the
 * write core. This is what the CLI's dispatch lands on. Decrypting/encrypting happens here because
 * the master key (resolved by `SystemSecretsStore.fromEnv` from the worker-only binding) never
 * leaves the worker. Tested against Miniflare with the `SECRETS_ENCRYPTION_KEYS` string binding.
 */
export async function runWriteWorkflow(env: SecretsStoreEnv, params: WriteSecretParams): Promise<void> {
  const store = await SystemSecretsStore.fromEnv(env);
  const tracker = RotationTracker.fromD1(env.SECRETS);
  await runWriteSecret({ store, tracker }, params);
}
