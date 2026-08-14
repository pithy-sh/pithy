// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Batch identity — the one rule every dispatcher of a send Workflow keeps (pithy-sh/pithy#342).
 *
 * **A job's `batchId` names the send Workflow instance that is coming for it, and nothing else.** Null
 * means no instance is. There is no third meaning, and in particular it is not a history of which batch
 * touched the row last.
 *
 * It binds over every row in a status `runScheduler` queries — `scheduled`, `pending`, `sending` — which
 * is every row the id can be read from. A terminal row (`sent`, `failed`, `suppressed`, `bounced`,
 * `cancelled`) keeps whatever it last carried, because no tick will ever look at it and clearing it
 * would be a write bought for nobody. What that costs is exactly one obligation, and it is `retryJob`'s:
 * the write that brings a terminal row back into the queried set must set this in the same statement.
 *
 * So the rule for a future writer is short. **If you move a job into `scheduled`, `pending` or
 * `sending`, you own this column in that statement.** Three places do today.
 *
 * That is the whole basis of the scheduler's veto. `runScheduler` leaves a stale-looking row alone when
 * the runtime says the instance it names is alive, so a row naming an instance that is *not* the one
 * working it turns the veto into a lie in one of two directions:
 *
 * - It names a **dead** instance and a live one is working the row anyway — the tick re-drives, a second
 *   Workflow renders and sends, and one person gets two copies.
 * - It names a **live** instance that is not working the row — the tick holds a genuinely stranded job
 *   for as long as some unrelated batch keeps running, and the mail does not go out.
 *
 * Three places set a job to a status the scheduler queries, so three places must uphold it: `enqueueEmail`
 * (immediate dispatch), `retryJob` (an operator re-queueing a failure), and `runScheduler` itself (the
 * claim). Each mints the id *before* the write that makes the row queryable and creates the instance
 * under it afterwards, so the worst an interrupted dispatch can leave behind is a row naming an instance
 * that does not exist — which the runtime disowns, which reads as dead, which is recovered. The failure
 * mode of this design is a duplicate render that `runSend` short-circuits, never a duplicate send.
 */

/**
 * Mint a batch id. A UUID, and deliberately nothing more.
 *
 * It becomes a Workflow instance id, so uniqueness is the only property it needs and the only one
 * anything may read from it: a batch id is not a timestamp, not a shard key, and not sortable. It is
 * here rather than inline at each dispatcher so that the three of them cannot drift into three id
 * schemes, one of which collides and rejects a `create` nobody sees fail.
 */
export function mintBatchId(): string {
  return crypto.randomUUID();
}
