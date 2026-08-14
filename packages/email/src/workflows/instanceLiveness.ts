// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a Workflow instance's status means to the scheduler (pithy-sh/pithy#342).
 *
 * The scheduler re-drives a `sending` job only when the batch holding it is not alive, and "alive" is a
 * question about a Workflow instance rather than about a row. This is the one statement of which answers
 * count as alive — kept out of `worker.ts` because that module imports `cloudflare:workers` and can
 * therefore only be exercised by deploying it, and this is a rule worth driving.
 */

/**
 * The statuses that mean "this batch is still coming".
 *
 * Named as the live set rather than the dead one, deliberately. A status the platform adds tomorrow then
 * reads as dead and its jobs are re-driven — the safety net erring towards recovery, which costs a
 * duplicate render that `runSend` short-circuits for anything already `sent` — instead of this code
 * silently vouching for an instance state it has never heard of.
 *
 * `queued` is live because the instance exists and will start. `paused` is live because a paused
 * instance is resumable and still owns its rows; re-driving one would put a second Workflow behind the
 * same jobs and make pausing a batch a way to send everyone in it twice.
 *
 * Outside it today: `errored`, `terminated`, `complete`, and anything unrecognised. None of those will
 * touch another job, so whatever they left in `sending` is genuinely stranded.
 */
const LIVE_INSTANCE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
]);

/** Does this instance status mean the batch is still coming? */
export function isLiveInstanceStatus(status: string): boolean {
  return LIVE_INSTANCE_STATUSES.has(status);
}
