// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { queueBody } from "@pithy-sh/core/src/queue/consumer";
import { z } from "zod";
import { type AuditSinks, sinksFor } from "./sinks";

/**
 * **The shipping queue: what goes on it, and what the Worker binds for it (#824).**
 *
 * One message per event per sink that takes it. A message names the sink and the event and nothing else: the
 * consumer reads the row back at delivery, so no IP, user-agent or metadata value ever sits in a queue, and a sink
 * that fails retries on its own without redelivering to the sinks that took the event.
 *
 * Two queues, both declared only when a sink is: `AUDIT_SHIP`, which the Worker produces to and consumes, and
 * `AUDIT_SHIP_DLQ`, where a message goes once its retries are spent. Cloudflare Queues needs the Workers Paid plan,
 * so a project that ships nothing binds neither.
 */

/** As much of a queue producer binding as shipping uses: one batched send. */
export interface ShipQueue {
  sendBatch(messages: Iterable<{ body: unknown }>): Promise<unknown>;
}

/** The capability name every message body carries, so the Worker's one `queue` export routes it here. */
export const AUDIT_QUEUE_CAPABILITY = "audit";

/** The queue every shipment goes through. */
export const AUDIT_SHIP_BINDING = "AUDIT_SHIP";

/** Where a shipment goes once its retries are spent. */
export const AUDIT_SHIP_DLQ_BINDING = "AUDIT_SHIP_DLQ";

/**
 * How many times a failed shipment is retried before it is dead-lettered. With {@link retryDelaySeconds} that is
 * about five hours of a sink being unreachable before an event is given up on.
 */
export const AUDIT_SHIP_MAX_RETRIES = 10;

/** The most shipments one invocation takes. Each sink's share of a batch is one request to it. */
export const AUDIT_SHIP_MAX_BATCH = 50;

/** The first retry's delay, in seconds. Each one after doubles it. */
const FIRST_RETRY_SECONDS = 30;

/** The longest one retry waits, in seconds. */
const LONGEST_RETRY_SECONDS = 3600;

/** How long the retry after this attempt waits: doubling from 30 seconds, never past an hour. */
export function retryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(FIRST_RETRY_SECONDS * 2 ** exponent, LONGEST_RETRY_SECONDS);
}

/** Whether this was a message's last delivery: the one whose failure dead-letters it. */
export function isFinalAttempt(attempts: number, maxRetries: number = AUDIT_SHIP_MAX_RETRIES): boolean {
  return attempts > maxRetries;
}

/** One shipment: one event, to one sink. */
export const ShipMessage = z
  .object({
    capability: z.literal(AUDIT_QUEUE_CAPABILITY).describe("The capability the message belongs to."),
    sink: z.string().min(1).describe("The sink the event is shipped to, by its declared name."),
    eventId: z.string().min(1).describe("The event's stable public id — the row the consumer reads back."),
  })
  .describe("One audit event, to one sink. Names only; the row is read back at delivery.");
export type ShipMessage = z.infer<typeof ShipMessage>;

/** The queue bindings shipping needs: none without a sink, the queue and its dead-letter queue with one. */
export function shipBindings(sinks: AuditSinks): BindingSpecInput[] {
  if (Object.keys(sinks).length === 0) return [];
  return [
    {
      type: "queue",
      name: AUDIT_SHIP_BINDING,
      consumer: {
        deadLetter: AUDIT_SHIP_DLQ_BINDING,
        maxRetries: AUDIT_SHIP_MAX_RETRIES,
        maxBatchSize: AUDIT_SHIP_MAX_BATCH,
      },
    },
    // Bound as a producer only so `pithy provision` creates it and `pithy upgrade` writes it; nothing in the kit sends
    // to it or reads it, so a Worker missing it still boots. A message lands there from Cloudflare, once its retries
    // are spent, and waits for a person.
    { type: "queue", name: AUDIT_SHIP_DLQ_BINDING, optional: true },
  ];
}

/**
 * Put one event on the queue for every sink that takes it. Throws only what the queue throws; the recorder catches
 * it, because a failed enqueue never fails the write it follows.
 */
export async function enqueueShipments(
  queue: ShipQueue,
  sinks: AuditSinks,
  event: { eventId: string; action: string },
): Promise<number> {
  const targets = sinksFor(sinks, event.action);
  if (targets.length === 0) return 0;
  await queue.sendBatch(
    targets.map((sink) => ({
      body: queueBody(AUDIT_QUEUE_CAPABILITY, { sink, eventId: event.eventId }) satisfies ShipMessage,
    })),
  );
  return targets.length;
}
