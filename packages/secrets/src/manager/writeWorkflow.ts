// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { currentValue } from "../crypto/versionedValue";
import { RotationTrigger } from "../data/secretRotations";
import type { SecretsStoreEnv } from "../env/bindings";
import { runWriteSecret, WriteSecretOutcome, type WriteSecretParams } from "../management/writeSecret";
import { RotationClosure, type RotationFailureCode } from "../rotation/rotationLedger";
import { RotationTracker } from "../store/rotationTracker";
import { SystemSecretsStore } from "../store/systemSecretsStore";

/**
 * The write Workflow payload: the write params plus an optional **test-only** `audit` flag. With
 * `audit`, the workflow re-reads and decrypts the just-written secret and reports only whether it
 * round-trips — never the value (see {@link runWriteWorkflow}).
 */
export type WriteWorkflowPayload =
  | (WriteSecretParams & {
      /** Test-only: verify the write decrypts back to the input. Only a boolean is returned, never a value. */
      audit?: boolean;
    })
  | RotationLedgerCommand;

/**
 * **The rotation ledger, dispatched.** A `pithy secrets rotate` opens a row before it rolls and closes it
 * after, and `pithy_secrets_rotations` lives in this database — so the two calls arrive here, on the same
 * Workflow the value itself is written through. `#379`: without them a successful command-line rotation
 * recorded nothing and the secret reported overdue forever.
 *
 * Parsed rather than trusted. The payload crosses the Workflows REST API from another process, which is a
 * boundary like any other — and `rotationId` addresses a row, so an unvalidated one closes somebody else's.
 * The closure carries a **code**, never the failure text: free text is where a value gets pasted by
 * accident, so the sentence is composed further in, by `RotationTracker.markFailure`.
 */
export const RotationLedgerCommand = z
  .discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("rotation-open").describe("Open an `in_progress` rotation row and return its id."),
        name: z.string().min(1).describe("The secret being rotated, by registry name."),
        trigger: RotationTrigger.describe("What caused the rotation. `baseline` is a first write, not a rotation."),
        rotatedBy: z.string().min(1).describe("Who or what asked, recorded verbatim in the row."),
      })
      .describe("Open a rotation row before anything is rolled, so a rotator that never returns leaves a trace."),
    z
      .object({
        mode: z.literal("rotation-close").describe("Close a row this environment's manager previously opened."),
        rotationId: z.number().int().positive().describe("The row id returned by the matching `rotation-open`."),
        closure: RotationClosure.describe("How the row closes here: success, or failed with a reason code."),
      })
      .describe("Close a rotation row with what the run actually did in this environment."),
  ])
  .describe("One rotation-ledger call dispatched to an environment's manager: open a row, or close one.");
export type RotationLedgerCommand = z.output<typeof RotationLedgerCommand>;

/** Whether a dispatched payload is a ledger call rather than a write. */
function isRotationLedgerCommand(payload: WriteWorkflowPayload): payload is RotationLedgerCommand {
  return payload.mode === "rotation-open" || payload.mode === "rotation-close";
}

/**
 * Everything one instance of this Workflow can report.
 *
 * Wider than {@link WriteSecretOutcome} because the Workflow does more than the write core does: it also
 * carries the rotation ledger, which writes no secret and reports opening and closing rows. Derived from
 * the write core's own enum rather than restated, so a member added there cannot go missing here.
 */
export const WriteWorkflowOutcome = z
  .enum([...WriteSecretOutcome.options, "opened", "closed"])
  .describe(
    "What one management Workflow instance did: a write outcome, or a rotation row `opened` or `closed`. Never a value.",
  );
export type WriteWorkflowOutcome = z.output<typeof WriteWorkflowOutcome>;

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
    outcome: WriteWorkflowOutcome.describe("What the instance did — the manager's answer, never a value."),
    rotationId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "The rotation row just opened, present only on a `rotation-open`. A surrogate row id in this environment's ledger — it addresses a record and describes nothing about a secret.",
      ),
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
 * Open or close a rotation row in this environment's ledger.
 *
 * The failure sentence is composed by the tracker, from the closure's own code, and never from anything
 * the caller wrote. `admin/status.ts` refuses to publish `error_message` precisely because it is free text
 * written at a failure site — accepting one over the wire would be that hazard arranged in advance.
 *
 * Since `#386` this path could not do otherwise: `markFailure` takes a {@link RotationFailureCode}, so the
 * dispatched closure hands over the code it already carries and there is no argument a sentence would fit.
 */
async function runRotationLedgerCommand(
  env: SecretsStoreEnv,
  command: RotationLedgerCommand,
): Promise<WriteWorkflowResult> {
  const tracker = RotationTracker.fromD1(env.SECRETS);
  if (command.mode === "rotation-open") {
    const rotationId = await tracker.startRotation(command.name, command.trigger, command.rotatedBy);
    return { outcome: "opened", rotationId };
  }
  if (command.closure.status === "success") await tracker.markSuccess(command.rotationId);
  else await tracker.markFailure(command.rotationId, command.closure.reason);
  return { outcome: "closed" };
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
  // The ledger calls touch no value and need no master key, so they are answered before the store is even
  // opened — which is also what lets a rotation record itself in an environment whose store is refusing.
  if (isRotationLedgerCommand(payload))
    return await runRotationLedgerCommand(env, RotationLedgerCommand.parse(payload));

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
