// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { currentValue } from "../crypto/versionedValue";
import type { SecretsStoreEnv } from "../env/bindings";
import { runWriteSecret, WriteSecretOutcome, type WriteSecretParams } from "../management/writeSecret";
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

/**
 * The write Workflow's result — its instance output, and the whole of what leaves this worker.
 *
 * A Zod object rather than an interface because it is read back **outside** the Worker, off the
 * Workflows REST API, by a CLI that must validate it like any other external input: a `PithyError`
 * raised on a shape nobody expected is a run that stops, and a silently-`undefined` `outcome` is a
 * provisioning gate that passes because it could not read its own subject.
 */
export const WriteWorkflowResult = z
  .object({
    outcome: WriteSecretOutcome.describe("What the write did — the manager's answer, never a value."),
    audited: z
      .boolean()
      .optional()
      .describe(
        "Test-only: whether the stored secret decrypted back to the dispatched value. The value itself never leaves the worker.",
      ),
  })
  .describe(
    "One management write Workflow instance's output: what it did, and nothing that could reconstruct a value.",
  );
export type WriteWorkflowResult = z.output<typeof WriteWorkflowResult>;

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
  const outcome = await runWriteSecret({ store, tracker }, payload);

  if (payload.audit && payload.mode !== "delete" && payload.mode !== "probe") {
    const fresh = await SystemSecretsStore.fromEnv(env);
    const stored = await fresh.getValue(payload.name);
    return { outcome, audited: stored !== undefined && currentValue(stored) === payload.value };
  }
  return { outcome };
}
