// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { CapabilityQueueHandler, QueueMessage } from "@pithy-sh/core/src/queue/consumer";
import { readRowsByEventId } from "../chain/rows";
import type { AuditDatabase } from "../data/tables";
import { shippedEventOf } from "./event";
import { sinkDelivery } from "./profiles";
import { AUDIT_SHIP_MAX_RETRIES, isFinalAttempt, retryDelaySeconds, ShipMessage } from "./queue";
import type { AuditSinks } from "./sinks";
import { recordSinkOutcome } from "./state";

/**
 * **The shipping consumer (#824): one request per sink per batch, at least once.**
 *
 * Each sink's share of a batch is read back from the trail, built into the sink's own format, and posted once. A 2xx
 * acknowledges every message in it; anything else — a refusal, a timeout, a token that will not resolve — retries
 * every one of them after a delay that doubles from 30 seconds to an hour, so a failing sink backs off instead of
 * being hammered. A message whose last retry fails goes to the dead-letter queue, and the sink's state counts it.
 *
 * A sink fails on its own. One sink down costs that sink's messages a retry and leaves every other sink's delivered:
 * a message names one sink, so nothing a healthy sink took is ever sent to it again.
 *
 * **Two messages are acknowledged without a delivery**, because no retry could ever deliver them: one naming a sink
 * the config no longer declares, and one naming an event with no row. Both are logged.
 *
 * **What the log never carries:** a token, a response body, or any value from the event. The sink's name, the
 * status and the count are enough to act on, and the receiver's response is the receiver's.
 */

/** How long one delivery may take before it counts as a failure, in ms. */
export const SHIP_TIMEOUT_MS = 10_000;

/** What the consumer needs, every piece injectable so a test runs it against recorded requests. */
export interface ShipConsumerOptions {
  /** The declared sinks. */
  sinks: AuditSinks;
  /** The audit database for this invocation's env. Throws when the binding is absent. */
  database: (env: Record<string, unknown>) => AuditDatabase;
  /** A sink's token, read through `@pithy-sh/secrets`. Throws when it is not set. */
  token: (env: Record<string, unknown>, secret: string) => Promise<string>;
  /** The network. Defaults to the global `fetch`. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The clock. */
  now?: () => Date;
  /** The retries the queue's consumer entry declares. Defaults to {@link AUDIT_SHIP_MAX_RETRIES}. */
  maxRetries?: number;
  /** Where a skipped message or a failed delivery is said. */
  log?: Pick<Logger, "warn">;
}

/** Why a delivery failed, as one line with nothing from the receiver's body in it. */
function failureOf(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "timed out" : error.message;
  return String(error);
}

/** Deliver one sink's messages, and settle every one of them. */
async function deliver(
  options: ShipConsumerOptions,
  env: Record<string, unknown>,
  db: AuditDatabase,
  sinkName: string,
  messages: readonly { message: QueueMessage; eventId: string }[],
): Promise<void> {
  const sink = options.sinks[sinkName];
  const log = options.log;
  if (sink === undefined) {
    log?.warn("audit shipment dropped", { reason: "sink no longer declared", sink: sinkName, count: messages.length });
    for (const { message } of messages) message.ack();
    return;
  }

  const rows = new Map(
    (await readRowsByEventId(db, [...new Set(messages.map((m) => m.eventId))])).map((r) => [r.eventId, r]),
  );
  const deliverable: { message: QueueMessage; eventId: string }[] = [];
  for (const entry of messages) {
    if (rows.has(entry.eventId)) deliverable.push(entry);
    else {
      log?.warn("audit shipment dropped", { reason: "event not in the trail", sink: sinkName, eventId: entry.eventId });
      entry.message.ack();
    }
  }
  if (deliverable.length === 0) return;

  // One event per row, however many messages named it: a redelivery beside its original ships it once.
  const unique = [...new Set(deliverable.map((entry) => entry.eventId))];
  const now = options.now ?? (() => new Date());
  const maxRetries = options.maxRetries ?? AUDIT_SHIP_MAX_RETRIES;
  let failure: string | null = null;
  try {
    const events = await Promise.all(
      unique.map((eventId) => shippedEventOf(rows.get(eventId) as NonNullable<ReturnType<typeof rows.get>>, sink)),
    );
    const token = await options.token(env, sink.secret);
    const request = sinkDelivery(sink, token, events);
    const response = await (options.fetch ?? fetch)(request.url, {
      ...request.init,
      // Never followed: a redirect would carry the token and the batch to a host nobody declared, or down to plain
      // HTTP, past the https-only check the sink's URL passed at config load. A 3xx is a refusal, retried like one.
      redirect: "manual",
      signal: AbortSignal.timeout(SHIP_TIMEOUT_MS),
    });
    // The body is the receiver's and is never read; canceling it frees the connection.
    await response.body?.cancel().catch(() => {});
    if (!response.ok) failure = `answered ${response.status}`;
  } catch (error) {
    failure = failureOf(error);
  }

  if (failure === null) {
    for (const { message } of deliverable) message.ack();
    await recordSinkOutcome(db, sinkName, {
      delivered: true,
      at: now(),
      retryingDelta: -deliverable.filter(({ message }) => message.attempts > 1).length,
      deadLettered: 0,
    });
    return;
  }

  let retryingDelta = 0;
  let deadLettered = 0;
  for (const { message } of deliverable) {
    const final = isFinalAttempt(message.attempts, maxRetries);
    if (final) {
      deadLettered += 1;
      if (message.attempts > 1) retryingDelta -= 1;
    } else if (message.attempts === 1) {
      retryingDelta += 1;
    }
    // A final attempt is retried too: that is what sends it to the dead-letter queue.
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  }
  log?.warn("audit shipment failed", { sink: sinkName, failure, count: deliverable.length, deadLettered });
  await recordSinkOutcome(db, sinkName, { delivered: false, at: now(), retryingDelta, deadLettered });
}

/** The capability's queue handler: every message of a batch that names audit, by sink. */
export function auditShipConsumer(options: ShipConsumerOptions): CapabilityQueueHandler {
  return async (messages, env) => {
    const bySink = new Map<string, { message: QueueMessage; eventId: string }[]>();
    for (const message of messages) {
      const parsed = ShipMessage.safeParse(message.body);
      if (!parsed.success) {
        options.log?.warn("audit shipment dropped", { reason: "not a shipment", messageId: message.id });
        message.ack();
        continue;
      }
      const list = bySink.get(parsed.data.sink) ?? [];
      list.push({ message, eventId: parsed.data.eventId });
      bySink.set(parsed.data.sink, list);
    }
    if (bySink.size === 0) return;
    const db = options.database(env);
    // Each sink settles its own messages; one that throws while recording leaves the others delivered.
    const failures: unknown[] = [];
    for (const [sink, list] of bySink) {
      try {
        await deliver(options, env, db, sink, list);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures[0] !== undefined) throw failures[0];
  };
}
