// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { RotationTrigger } from "../data/secretRotations";
import type { OpenRotation, RotationLedger } from "../rotation/rotationLedger";
import { rotationClosure } from "../rotation/rotationLedger";
import type { ManagedEnvironment } from "../scope";
import type { SecretRotationRecorder } from "./dispatch";

/**
 * **The out-of-process {@link RotationLedger}: the same rows, written the only way the CLI can write them.**
 *
 * A rotation's history belongs in the environment's own secrets D1, and the CLI holds no handle to one —
 * the master key is worker-only, which is why every value-touching command is a dispatch. So the ledger is
 * dispatched too, through {@link SecretRotationRecorder}, and lands on the same `RotationTracker` the
 * in-Worker ledger uses. That is the whole of `#379`'s fix: not a second mechanism for the command line,
 * the same mechanism reached over a different wire.
 *
 * ## One row per target environment
 *
 * A `global` secret rotates in every declared environment at once, and each has its own ledger. A single
 * aggregate row would have to live somewhere, and wherever it lived it would answer *is this environment's
 * credential fresh* for environments it was not about. So this opens one row per target and closes each
 * with {@link rotationClosure} against that environment — a fan-out that reached staging and stranded prod
 * closes `success` in one ledger and `failed` in the other, which is what actually happened.
 *
 * ## A manager that cannot be reached costs a row, never the rotation
 *
 * Each open and each close is attempted independently and a failure is dropped. The rotation is the act;
 * the row is the record of it. Refusing to roll a credential during the incident that demanded it, because
 * one environment's manager would not answer, is the wrong trade in both directions — and the missing row
 * is itself visible, as a gap in the history and a `lastRotatedAt` that did not move.
 */

/**
 * Who a command-line rotation is recorded as.
 *
 * **It names the path, not the person, and that is deliberate rather than a shortcut.** `createCliAudit`
 * resolves an operator from the Cloudflare API token and falls back to `system, actorResolutionFailed`
 * when there is none — so the honest answer to *who* is on the `secrets/rotated` audit event, where the
 * resolver already runs. Writing a guessed name into the rotation row would put a second, weaker answer to
 * the same question in a second place, and an incident review comparing them would have no way to tell
 * which one was resolved. What this row does say — and what the audit trail cannot — is which of the two
 * paths performed the act.
 */
export const CLI_ROTATED_BY = "pithy secrets rotate";

/** What a dispatched ledger needs: where the rotation lands, and how the rows are labelled. */
export interface DispatchedRotationLedgerOptions {
  /** Every environment this rotation writes to. One row is opened in each. */
  targets: readonly ManagedEnvironment[];
  /** What caused it. Defaults to `manual` — a person at a terminal. */
  trigger?: Exclude<RotationTrigger, "baseline">;
  /** Who to record. Defaults to {@link CLI_ROTATED_BY}. */
  rotatedBy?: string;
}

/** A row this ledger managed to open, and where. */
interface OpenedRow {
  env: ManagedEnvironment;
  rotationId: number;
}

/** The CLI's {@link RotationLedger}, over the manager write-Workflow. */
export function dispatchedRotationLedger(
  recorder: SecretRotationRecorder,
  options: DispatchedRotationLedgerOptions,
): RotationLedger {
  const trigger = options.trigger ?? "manual";
  const rotatedBy = options.rotatedBy ?? CLI_ROTATED_BY;
  return {
    async open(name: string): Promise<OpenRotation> {
      const opened: OpenedRow[] = [];
      for (const env of options.targets) {
        try {
          opened.push({ env, rotationId: await recorder.openRotation({ env, name, trigger, rotatedBy }) });
        } catch {
          // One manager short of a full history is a gap. It is not a reason to leave the credential alone.
        }
      }
      return {
        async close(outcome): Promise<void> {
          for (const row of opened) {
            try {
              await recorder.closeRotation({
                env: row.env,
                rotationId: row.rotationId,
                closure: rotationClosure(outcome, row.env),
              });
            } catch {
              // The row stays `in_progress`, which reads as an attempt whose end is unknown — true.
            }
          }
        },
      };
    },
  };
}
