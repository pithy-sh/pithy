// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * **What the rank refresh retries, and what it refuses to.**
 *
 * The answer is short because the refresh's world is: every step it runs — the journalled context, the
 * prune, and one keyset page of ranking per step — talks to D1 and to nothing else. There is no
 * provider, no bucket, no model, no second account. So there is no `leaderboard/*` code this pass can
 * usefully re-drive, and the record is empty on purpose (pithy-sh/pithy#348).
 *
 * **An empty record is a statement, not an omission.** Core still answers for D1 through `withD1Retry`'s
 * vocabulary — busy, timed out, connection lost, storage reset, internal — so a database under
 * contention is re-driven with the step's much longer backoff, and nothing about that is restated here:
 * one D1 vocabulary, in core, or the two drift. What the empty record adds is the other half — that
 * leaderboard has looked at its own codes and retries none of them.
 *
 * ## Terminal, and why
 *
 * - **`leaderboard/invalid_schedule`** — a board's window CRON will not parse. It is config, it is
 *   identical on the next attempt, and it wants the adopter to edit `pithy.config.ts`.
 * - **`validation/invalid_input`** — a board whose keyset cursor or rank shape the materializer refuses.
 *   Deterministic in the row it read.
 * - **`leaderboard/board_not_found`, `leaderboard/board_immutable`** and the rest of the submit-path
 *   codes. They belong to a request; a refresh that somehow raised one has found a bug, and a bug
 *   surfaces faster than it backs off.
 *
 * **The cron is the outer retry, and that is why terminal is cheap here.** A refresh fires on a
 * schedule, takes an advisory lock, and re-ranks from the top; a run that fails releases its lock in a
 * `finally` and the next fire does the whole job again. So a fault that stops one run costs one
 * interval, where five platform attempts against an answer that cannot change cost the interval *and*
 * hold the lock through it — which is the one thing that makes the next fire skip too.
 */
export const leaderboardWorkflowRetry: WorkflowRetryPolicy = {
  capability: "leaderboard",
  retryable: {},
};
