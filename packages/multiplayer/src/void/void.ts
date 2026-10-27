// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { ConflictError, InternalError, NotFoundError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { MultiplayerResult, VoidConsumerStatus } from "../data/result";
import { isUniqueViolation, type ResultStore, resultStore } from "../data/store";
import type { VoidConsumerOutcome } from "../http/responses";
import type { VoidConsumer } from "../session/peers";

/**
 * Voiding a result, and the cascade that follows it (#820).
 *
 * ## The result first, then every consumer
 *
 * A void marks the result void — under its idempotency key, with every composed consumer `pending` — and then
 * calls each consumer with the result's id: the leaderboard takes back the entries the result put on its boards,
 * and rating recalculates every player its outcomes touched. What each did is recorded on the result as it
 * answers, and the response lists them consumer by consumer. **A consumer that fails is named**, with its error,
 * and never folded into success; the result stays void, because the void is the operator's decision about the
 * result, and a consumer's failure does not unmake it.
 *
 * ## What changes nothing
 *
 * The same key again is the same act: it answers `replayed: true` with what was recorded, calls nothing and emits
 * nothing — even while the first request is still running, so a double-click cannot run a consumer twice at once.
 * A new key on a result whose consumers all finished is a void of a voided result: it changes nothing and emits
 * nothing too. A new key on a result with a consumer still `failed` or `pending` runs **those consumers only**,
 * again — each is idempotent, so what already came back stays back — and that retry is an act, audited like the
 * first. The retry's key takes the void over, so a double-click on the retry runs it once, and the key before it
 * stays spent: sent again, it is still a replay. A key already spent on a different result is refused.
 *
 * ## A void still running is never run twice
 *
 * The same key cannot overlap itself, but a new key could — a second operator, or a client that mints a key per
 * click — and a consumer is not safe run twice at once: two leaderboard runs that both read a contribution before
 * either removes it take the score off twice. So `pending` is not taken for "stopped" while the void that wrote it
 * may still be running. A void marks every consumer `pending`, and a retry marks the ones it re-runs `pending` in the
 * same write that hands it the key. While any consumer is `pending` and the key holding the void was spent less
 * than {@link VOID_LEASE_MS} ago, a new key is refused with `core/conflict`, changes nothing, spends nothing, and
 * emits nothing. Past the lease, the void or retry is taken to have stopped, and its `pending` consumers run again
 * with its `failed` ones. The leaderboard's consumer is also safe run twice at once, which covers a void that
 * outlives its lease.
 */

/**
 * How long a void, or a retry of one, holds its result's `pending` consumers: a new key inside it is refused rather
 * than run beside it. Longer than any one request runs, so a void past it has stopped, not slowed down.
 */
export const VOID_LEASE_MS = 15 * 60 * 1000;

/** What one void request asks for. */
export interface VoidRequest {
  /** The session whose result is voided. */
  sessionId: string;
  /** The client's idempotency key. */
  idempotencyKey: string;
}

/** What a void did. */
export interface VoidOutcome {
  /** The result as it now stands. */
  result: MultiplayerResult;
  /** True when this request changed nothing. */
  replayed: boolean;
  /** Each consumer this request called, with its report — or, on a replay, each one as recorded. */
  consumers: VoidConsumerOutcome[];
}

/** The recorded statuses, as a response lists them on a replay: no report, because none was kept. */
function recorded(result: MultiplayerResult): VoidConsumerOutcome[] {
  return (result.voidConsumers ?? []).map(({ consumer, status, error }) => ({ consumer, status, error }));
}

/** An outcome, as the result row keeps it. */
function statusOf(outcome: VoidConsumerOutcome): VoidConsumerStatus {
  return { consumer: outcome.consumer, status: outcome.status, error: outcome.error };
}

/** The answer for a request that changed nothing. */
function replay(result: MultiplayerResult): VoidOutcome {
  return { result, replayed: true, consumers: recorded(result) };
}

/** Call one consumer, and say what it did — a failure is an outcome, never a throw. */
export async function runVoidConsumer(
  d1: D1Database,
  consumer: VoidConsumer | undefined,
  name: string,
  resultId: string,
  now: Date,
  log?: Logger,
): Promise<VoidConsumerOutcome> {
  if (consumer === undefined) {
    return {
      consumer: name,
      status: "failed",
      error: { code: "core/precondition_failed", message: `No ${name} is composed in this Worker any more.` },
    };
  }
  const run = consumer.voidResult;
  if (run === undefined) {
    return {
      consumer: name,
      status: "failed",
      error: {
        code: "core/precondition_failed",
        message: `The composed ${name} is too old to void a result. Upgrade @pithy-sh/${name}.`,
      },
    };
  }
  try {
    return { consumer: name, status: "done", error: null, report: await run(d1, resultId, now) };
  } catch (error) {
    const failure =
      error instanceof PithyError
        ? error
        : new InternalError({ message: `The ${name} consumer failed.`, detail: String(error) }, { cause: error });
    log?.error("void consumer failed", { session: resultId, consumer: name, error: failure });
    return {
      consumer: name,
      status: "failed",
      error: { code: failure.payload.code, message: failure.payload.message },
    };
  }
}

/** Run `names` against the composed consumers, in order, recording each answer on the result as it comes. */
async function cascade(
  d1: D1Database,
  store: ResultStore,
  consumers: readonly VoidConsumer[],
  names: readonly string[],
  statuses: VoidConsumerStatus[],
  sessionId: string,
  now: Date,
  log?: Logger,
): Promise<VoidConsumerOutcome[]> {
  const outcomes: VoidConsumerOutcome[] = [];
  for (const name of names) {
    const outcome = await runVoidConsumer(
      d1,
      consumers.find((consumer) => consumer.name === name),
      name,
      sessionId,
      now,
      log,
    );
    outcomes.push(outcome);
    const at = statuses.findIndex((status) => status.consumer === name);
    if (at === -1) statuses.push(statusOf(outcome));
    else statuses[at] = statusOf(outcome);
    await store.recordConsumers(sessionId, statuses);
  }
  return outcomes;
}

export async function voidMultiplayerResult(
  d1: D1Database,
  consumers: readonly VoidConsumer[],
  request: VoidRequest,
  now: Date,
  log?: Logger,
): Promise<VoidOutcome> {
  const store = resultStore(d1);
  const { sessionId, idempotencyKey } = request;

  const spent = await store.byVoidKey(idempotencyKey);
  if (spent) return replay(matching(spent, request));

  const result = await store.get(sessionId);
  if (!result) {
    throw new NotFoundError({
      message: "That session has no result.",
      detail: `No pithy_multiplayer_results row for session "${sessionId}".`,
    });
  }

  if (result.voidedAt !== null) {
    const statuses = [...(result.voidConsumers ?? [])];
    const unfinished = statuses.filter((status) => status.status !== "done").map((status) => status.consumer);
    if (unfinished.length === 0) return replay(result);
    if (statuses.some((status) => status.status === "pending")) await stillRunning(store, result, now);
    // The new key takes the void over, so a second request under it is a replay rather than a second run, and it
    // marks what it is about to run `pending`, so a third key meets the lease rather than running beside it.
    const claimed = statuses.map((status) =>
      status.status === "done" ? status : { consumer: status.consumer, status: "pending" as const, error: null },
    );
    if (!(await claim(store, result, idempotencyKey, request, now, claimed)))
      return replay((await store.get(sessionId)) ?? result);
    statuses.splice(0, statuses.length, ...claimed);
    const outcomes = await cascade(d1, store, consumers, unfinished, statuses, sessionId, now, log);
    return { result: (await store.get(sessionId)) ?? result, replayed: false, consumers: outcomes };
  }

  const pending: VoidConsumerStatus[] = consumers.map((consumer) => ({
    consumer: consumer.name,
    status: "pending",
    error: null,
  }));
  let marked: boolean;
  try {
    marked = await store.markVoided(sessionId, idempotencyKey, pending, now);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another request spent this key first. Its result is the answer — or the refusal, if it was another result.
    const winner = await store.byVoidKey(idempotencyKey);
    if (!winner) throw error;
    return replay(matching(winner, request));
  }
  if (!marked) {
    // Another void, under another key, marked it between the read and the write. Its record is the answer.
    return replay((await store.get(sessionId)) ?? result);
  }

  const outcomes = await cascade(
    d1,
    store,
    consumers,
    consumers.map((consumer) => consumer.name),
    pending,
    sessionId,
    now,
    log,
  );
  return { result: (await store.get(sessionId)) ?? result, replayed: false, consumers: outcomes };
}

/**
 * Refuse a new key while the void holding `result` may still be running its `pending` consumers — inside the lease
 * from when its key was spent. A void with no key to time it by predates the key table, and has long stopped.
 */
async function stillRunning(store: ResultStore, result: MultiplayerResult, now: Date): Promise<void> {
  if (result.voidKey === null) return;
  const since = await store.spentAt(result.voidKey);
  if (since === undefined || now.getTime() - since.getTime() >= VOID_LEASE_MS) return;
  throw new ConflictError({
    message: "A void of this result is still running.",
    action:
      "Wait for it to finish, then read the result. Void again with a new key only if a consumer is still failed or pending.",
    detail: `Session "${result.sessionId}" is held by void key "${result.voidKey}", spent ${since.toISOString()}; a void holds its pending consumers for ${VOID_LEASE_MS / 60_000} minutes.`,
  });
}

/** Claim a voided result's retry under a new key: false when another request under it got there first. */
async function claim(
  store: ResultStore,
  result: MultiplayerResult,
  idempotencyKey: string,
  request: VoidRequest,
  now: Date,
  consumers: VoidConsumerStatus[],
): Promise<boolean> {
  try {
    return await store.claimRetry(result.sessionId, result.voidKey, idempotencyKey, now, consumers);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await store.byVoidKey(idempotencyKey);
    if (!winner) throw error;
    matching(winner, request);
    return false;
  }
}

/** The spent key's result, when it was spent voiding this same result — otherwise the refusal. */
function matching(spent: MultiplayerResult, request: VoidRequest): MultiplayerResult {
  if (spent.sessionId === request.sessionId) return spent;
  throw new ConflictError({
    message: "That idempotency key was already used to void a different result.",
    action: "Send a new key for a new void. Reuse a key only to retry the request it was made for.",
    detail: `Key "${request.idempotencyKey}" was spent voiding session "${spent.sessionId}".`,
  });
}
