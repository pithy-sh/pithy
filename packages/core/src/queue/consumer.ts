// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Logger } from "../logger/logger";

/**
 * **A capability's queue consumer, and how one Worker's `queue` export finds it (#824).**
 *
 * A Worker has one `queue` handler for every queue it consumes, the way it has one `email` and one `scheduled`.
 * Which capability a message belongs to cannot be read off the batch: `batch.queue` is the provisioned name,
 * `<project>-<env>-<thing>`, which no capability knows at runtime and which a long name truncates. So the message
 * says it: every body a capability sends carries its own name under {@link QUEUE_CAPABILITY_FIELD}, built with
 * {@link queueBody}, and the dispatcher hands each capability exactly the messages that name it.
 *
 * **A message no composed capability claims is acknowledged and logged**, never retried. Retrying cannot make a
 * capability appear, so a retry would only walk the message to its dead-letter queue and count it as a delivery
 * failure it never was.
 *
 * **A handler that throws costs its own messages, and nothing else.** Every other capability's messages are still
 * handed over; the first failure is rethrown after the pass, so the invocation is recorded as failed and the runtime
 * retries what was neither acknowledged nor retried.
 */

/**
 * One delivered message, as much of the runtime's as a consumer touches. Stated here rather than imported, so the
 * Workers types' `Message` — a word half the kit uses for other things — never becomes a name the kit reaches for.
 */
export interface QueueMessage {
  /** The runtime's id for this delivery. */
  readonly id: string;
  /** The body as sent. */
  readonly body: unknown;
  /** How many times this message has been delivered, this one included. Starts at 1. */
  readonly attempts: number;
  /** Settle it: delivered, never to be seen again. */
  ack(): void;
  /** Settle it: deliver it again after the delay, or to the dead-letter queue once retries are spent. */
  retry(options?: { delaySeconds?: number }): void;
}

/** One batch the runtime hands a Worker's `queue` export. */
export interface QueueBatch {
  /** The provisioned queue's name. */
  readonly queue: string;
  /** Its messages. */
  readonly messages: readonly QueueMessage[];
}

/** The body field that names the capability a queue message belongs to. */
export const QUEUE_CAPABILITY_FIELD = "capability";

/** A capability's queue handler: the messages that name it, from one batch. */
export type CapabilityQueueHandler = (
  messages: readonly QueueMessage[],
  env: Record<string, unknown>,
  ctx: ExecutionContext,
) => Promise<void>;

/** A message body, stamped with the capability it belongs to so the Worker's one `queue` export can route it. */
export function queueBody<const Capability extends string, const Body extends Record<string, unknown>>(
  capability: Capability,
  body: Body,
): Body & { capability: Capability } {
  return { ...body, capability };
}

/** The capability a message body names, or null when it names none. */
export function queueMessageCapability(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[QUEUE_CAPABILITY_FIELD];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Hand each composed capability the messages of one batch that name it. */
export async function dispatchQueueBatch(
  batch: QueueBatch,
  handlers: ReadonlyMap<string, CapabilityQueueHandler>,
  env: Record<string, unknown>,
  ctx: ExecutionContext,
  log?: Pick<Logger, "warn">,
): Promise<void> {
  const claimed = new Map<string, QueueMessage[]>();
  for (const message of batch.messages) {
    const capability = queueMessageCapability(message.body);
    if (capability === null || !handlers.has(capability)) {
      log?.warn("queue message unclaimed", { queue: batch.queue, messageId: message.id, capability });
      message.ack();
      continue;
    }
    const list = claimed.get(capability) ?? [];
    list.push(message);
    claimed.set(capability, list);
  }
  const failures: unknown[] = [];
  for (const [capability, messages] of claimed) {
    try {
      await handlers.get(capability)?.(messages, env, ctx);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures[0] !== undefined) throw failures[0];
}
