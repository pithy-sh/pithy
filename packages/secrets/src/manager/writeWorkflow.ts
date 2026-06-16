import { currentValue } from "../crypto/versionedValue";
import type { SecretsStoreEnv } from "../env/bindings";
import { runWriteSecret, type WriteSecretParams } from "../management/writeSecret";
import { RotationTracker } from "../store/rotationTracker";
import { SystemSecretsStore } from "../store/systemSecretsStore";

/**
 * The write Workflow payload: the write params plus an optional **test-only** `audit` flag. With
 * `audit`, the workflow re-reads and decrypts the just-written secret and reports only whether it
 * round-trips — never the value (see {@link runWriteWorkflow}).
 */
export type WriteWorkflowPayload = WriteSecretParams & {
  /** Test-only: verify the write decrypts back to the input. Only a boolean is returned, never a value. */
  audit?: boolean;
};

/** The write Workflow's result — its instance output. `audited` is present only when `audit` was set. */
export interface WriteWorkflowResult {
  /** Whether the stored secret decrypted back to the dispatched value. The value itself never leaves the worker. */
  audited?: boolean;
}

/**
 * The management write Workflow's body: build the store + tracker from the worker env and run the
 * write core. This is what the CLI's dispatch lands on. Decrypting/encrypting happens here because
 * the master key (resolved by `SystemSecretsStore.fromEnv` from the worker-only binding) never
 * leaves the worker. Tested against Miniflare with the `SECRETS_ENCRYPTION_KEYS` string binding.
 *
 * **Audit (test-only round-trip check).** With `payload.audit` on a create/update, after the write
 * the workflow opens a *fresh* store (re-resolves the key, re-reads D1), decrypts the secret, and
 * compares it to the dispatched value — returning only `{ audited: boolean }`. The plaintext is
 * compared inside the worker and never returned or logged, so the round trip is proven without a
 * secret ever leaving. This is how the live integration test confirms encrypt → store → decrypt.
 */
export async function runWriteWorkflow(
  env: SecretsStoreEnv,
  payload: WriteWorkflowPayload,
): Promise<WriteWorkflowResult> {
  const store = await SystemSecretsStore.fromEnv(env);
  const tracker = RotationTracker.fromD1(env.SECRETS);
  await runWriteSecret({ store, tracker }, payload);

  if (payload.audit && payload.mode !== "delete") {
    const fresh = await SystemSecretsStore.fromEnv(env);
    const stored = await fresh.getValue(payload.name);
    return { audited: stored !== undefined && currentValue(stored) === payload.value };
  }
  return {};
}
