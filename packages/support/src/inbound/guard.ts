// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SupportGuardConfig } from "../config/config";
import { SUPPORT_MESSAGES_TABLE, type SupportDatabase } from "../data/tables";

/**
 * The inbound guard — the bound between "a public support address" and "a public write endpoint into
 * the adopter's D1", which is what one is without this file.
 *
 * Three checks, deliberately ordered by what they cost:
 *
 * 1. **Size**, from the message's declared length, before a byte is parsed. Parsing is the expensive
 *    step and the size is known first, so refusing here is the difference between a flood costing
 *    CPU and costing nothing.
 * 2. **Per sender**, which catches the overwhelmingly common case: one misconfigured auto-responder
 *    in a loop with the inbox. It is not an attack and it will still fill a database.
 * 3. **Globally**, which is the only one that helps under a distributed flood, where every
 *    individual address stays comfortably under the per-sender bound.
 *
 * ## Counted from the messages table, not from a counter table
 *
 * A dedicated counter row would be one write per message and a second thing to reconcile — and it
 * would be **wrong**, because a counter incremented before the insert overcounts a failed store and
 * one incremented after undercounts a flood. The messages table already holds the exact fact, and
 * `(from_address, received_at)` is already indexed for the sender history the dashboard shows. So
 * the guard is a covered index scan over data that must exist anyway, and it cannot drift from what
 * it is counting.
 *
 * The window is a sliding hour rather than a fixed bucket, because a fixed bucket lets twice the
 * limit through across a boundary — which is exactly when a retry storm arrives.
 */

/** One hour, in milliseconds — the window every rate bound is measured over. */
export const GUARD_WINDOW_MS = 60 * 60 * 1000;

/** Why a message was refused. The value lands in the audit event's `metadata.reason`. */
export type SupportRejectionReason = "too_large" | "sender_rate" | "global_rate";

/** The guard's answer: accept, or refuse with a reason. */
export type GuardVerdict = { accepted: true } | { accepted: false; reason: SupportRejectionReason; detail: string };

/** What the guard needs to decide. */
export interface GuardInput {
  /** The raw message size in bytes, as received. */
  rawBytes: number;
  /** The sender's normalized address. */
  fromAddress: string;
  /** Now. Injected so the window is testable without waiting an hour. */
  now: Date;
}

/**
 * Check the size bound alone — the half that needs no database and can therefore run before the
 * message is parsed. Split out because the ordering is the point: this is the only check available
 * while the decision is still free.
 */
export function checkSize(config: SupportGuardConfig, rawBytes: number): GuardVerdict {
  if (rawBytes > config.maxRawBytes) {
    return {
      accepted: false,
      reason: "too_large",
      detail: `raw message is ${rawBytes} bytes, over the ${config.maxRawBytes} byte bound`,
    };
  }
  return { accepted: true };
}

/**
 * Check the two rate bounds against what is already stored.
 *
 * Both counts run against the sliding window ending now. Inbound only: a burst of *replies* is the
 * adopter's own doing and must never lock them out of their own inbox, which is a real failure mode
 * for a guard that counts every row in the table.
 */
export async function checkRates(
  db: SupportDatabase,
  config: SupportGuardConfig,
  input: GuardInput,
): Promise<GuardVerdict> {
  const since = new Date(input.now.getTime() - GUARD_WINDOW_MS);

  const fromSender = await db
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("direction", "=", "inbound")
    .where("fromAddress", "=", input.fromAddress)
    .where("receivedAt", ">=", since.getTime())
    .executeTakeFirst();

  if ((fromSender?.count ?? 0) >= config.maxPerSenderPerHour) {
    return {
      accepted: false,
      reason: "sender_rate",
      detail: `sender has landed ${fromSender?.count} messages in the last hour, at or over the ${config.maxPerSenderPerHour} bound`,
    };
  }

  const total = await db
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("direction", "=", "inbound")
    .where("receivedAt", ">=", since.getTime())
    .executeTakeFirst();

  if ((total?.count ?? 0) >= config.maxPerHour) {
    return {
      accepted: false,
      reason: "global_rate",
      detail: `inbox has accepted ${total?.count} messages in the last hour, at or over the ${config.maxPerHour} bound`,
    };
  }

  return { accepted: true };
}
