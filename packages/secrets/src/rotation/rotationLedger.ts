// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { ManagedEnvironment } from "../scope";
import type { SecretRotationOutcome } from "./rotateValue";

/**
 * **Where a rotation is recorded — stated once, so a third caller inherits it.**
 *
 * `#379` is what happens when it is not. `runWriteSecret` seeded a rotation row only on a *first* write,
 * a rotation dispatches `mode: "update"`, and so a `pithy secrets rotate` that fully succeeded left
 * `lastRotatedAt` untouched and the secret reporting **overdue forever** — while a rotation from the
 * control-plane route recorded correctly. Two paths to one act, disagreeing about whether the act
 * happened, and an operator rotating on the command line during an incident told by the product that they
 * did not.
 *
 * The fix is not a second recorder beside the first. It is that {@link RotationLedger} is an argument to
 * `rotateSecretValue`, and **required**: the one function that performs a rotation is the one that records
 * it, and a caller that would rather not cannot express that.
 *
 * ## Two implementations, because there are two kinds of caller and only one of them holds the database
 *
 * The ledger is `pithy_secrets_rotations`, in the **per-environment secrets D1**. A Worker holds one
 * directly (`trackerRotationLedger`, over `RotationTracker`). The CLI holds none — the master key is
 * worker-only and every value-touching command is a dispatch to that environment's manager Workflow — so
 * it records the same way it writes (`dispatchedRotationLedger`, in `../cli/rotationLedger.ts`). Same
 * rows, same columns, same sentence on a failure, because both close through {@link rotationClosure}.
 *
 * ## Opened before the roll, closed after it
 *
 * A rotator that never returns still leaves a trace: an `in_progress` row naming the secret and who asked.
 * That is the difference between an incident review that can see the attempt and one that reads a gap.
 * It is opened only after every refusal, so a rotation that never started writes no history at all.
 *
 * ## A first write is not a rotation, and the ledger says which it was
 *
 * `RotationTracker.recordBaseline` still writes the `baseline` row a brand-new secret gets, and it stays
 * exactly where it is — on the *create* branch of `runWriteSecret`. A first write and a rotation are
 * different events: one establishes a value, the other replaces one. Conflating them to make a count come
 * out would mean `pithy secrets update` — a typo fix, a value pasted from a console — silently advancing
 * a freshness clock nobody rotated. So the writer never infers, the rotator declares, and the row's
 * `trigger` column (`baseline` / `manual` / `cron`) is what tells a reader which of the two it is reading.
 */

/**
 * Why a rotation row closed `failed`, as a code rather than as free text.
 *
 * **Free text is what a value gets pasted into.** `admin/status.ts` refuses to publish `error_message`
 * for exactly that reason, and the CLI's closure crosses a process boundary before it reaches the column
 * — so what crosses is one of these three, and the sentence is composed inside the Worker by
 * {@link rotationFailureText}. There is no shape of close request that could carry a credential.
 */
export const RotationFailureReason = z
  .enum(["roll-failed", "not-recorded", "not-rotated"])
  .describe(
    "Why a rotation row closed failed. `roll-failed` — the rotator never answered, so whether the issuer rolled is unknown. `not-recorded` — the issuer rolled and this environment's store did not take the value, which is the incident that needs a human now. `not-rotated` — nothing was rolled and nothing was written, so the previous value is still live.",
  );
export type RotationFailureReason = z.output<typeof RotationFailureReason>;

/**
 * How one rotation row closes, in one environment.
 *
 * The two members of `RotationStatus` a finished attempt can hold — `in_progress` is what the row already
 * says, and closing to it would be closing nothing. A discriminated union rather than an optional reason
 * so a `failed` closure cannot be constructed without one.
 */
export const RotationClosure = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z
          .literal("success")
          .describe("The new value reached this environment's store, so the row closes success."),
      })
      .describe("A rotation that landed here."),
    z
      .object({
        status: z.literal("failed").describe("The new value never reached this environment's store."),
        reason: RotationFailureReason.describe("Which failure it was, as a code the Worker renders."),
      })
      .describe("A rotation that did not land here, and why."),
  ])
  .describe("How one rotation row closes in one environment: success, or failed with a reason.");
export type RotationClosure = z.output<typeof RotationClosure>;

/** The sentence written into a failed row's `error_message`. Fixed text, chosen by a code, never composed from an exception. */
const FAILURE_TEXT: Record<RotationFailureReason, string> = {
  "roll-failed": "the rotator did not answer, so nothing was recorded here",
  "not-recorded": "rolled at the issuer, and not recorded here",
  "not-rotated": "not rotated: nothing was rolled and nothing was written",
};

/**
 * The failure sentence for a reason.
 *
 * It names no environment, because it does not have to: the row lives in that environment's own D1, so
 * *here* is unambiguous and a name copied into the text is a name that can be wrong.
 */
export function rotationFailureText(reason: RotationFailureReason): string {
  return FAILURE_TEXT[reason];
}

/**
 * How the row in `environment` closes, given what the whole run did.
 *
 * **Per environment, and that is the point.** A fan-out that reached staging and stranded prod is a
 * success in one ledger and an incident in the other, and one verdict written to both would either
 * advance a freshness clock over a dead credential or report a landed value as lost. `recorded` is the
 * list of environments the value actually reached, grown as each write landed, so it is the only thing
 * here that can answer the question.
 */
export function rotationClosure(outcome: SecretRotationOutcome, environment: ManagedEnvironment): RotationClosure {
  if (outcome.recorded.includes(environment)) return { status: "success" };
  if (outcome.rollFailed === true) return { status: "failed", reason: "roll-failed" };
  if (outcome.rolled) return { status: "failed", reason: "not-recorded" };
  return { status: "failed", reason: "not-rotated" };
}

/** A rotation row that has been opened and is waiting to be closed. */
export interface OpenRotation {
  /**
   * Close what was opened, with what the run actually did. Called once, on every path below the open —
   * including the failing ones, which are the paths whose record matters most.
   */
  close(outcome: SecretRotationOutcome): Promise<void>;
}

/**
 * The rotation ledger, from the two sides that can reach one.
 *
 * `open` takes the secret's name and nothing else: *who* asked and *what triggered it* belong to the
 * implementation, which is the thing that knows — a Worker has a verified control-plane subject, the CLI
 * has a command. Passing them per call would let one caller record a rotation as somebody else.
 */
export interface RotationLedger {
  /** Open an `in_progress` row for `name`, before anything is rolled. */
  open(name: string): Promise<OpenRotation>;
}
