// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { SupportConfig, type SupportGuardConfig } from "../config/config";
import { supportDatabase } from "../data/tables";
import { support_0001_threads } from "../migrations/0001_threads";
import { checkRates, checkSize, GUARD_WINDOW_MS } from "./guard";

/**
 * The guard against real D1, counting real rows.
 *
 * The window and the direction filter are both SQL predicates, so a fake database would prove nothing
 * about either — and the direction filter is the one that decides whether a busy support day locks the
 * adopter out of their own inbox.
 */

/** The support migrations as an app-database provider. */
function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "support",
      order: SUPPORT_MIGRATION_ORDER,
      migrations: { "0001_threads": support_0001_threads },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

/** The clock every window in this file is measured back from. */
const NOW = new Date("2026-07-01T12:00:00.000Z");

/** A moment `minutes` before {@link NOW}, as a millisecond epoch. */
function minutesAgo(minutes: number): number {
  return NOW.getTime() - minutes * 60_000;
}

/** Guard bounds, with the defaults filled in around whatever the test cares about. */
function guard(overrides: Partial<SupportGuardConfig> = {}): SupportGuardConfig {
  return SupportConfig.parse({ inboundAddresses: ["support@help.acme.test"], guard: overrides }).guard;
}

let rows = 0;

/**
 * Insert one message row directly. The guard reads what is stored, so writing the rows by hand is what
 * keeps these tests about the counting rather than about ingest.
 */
async function insertMessage(options: {
  direction: "inbound" | "outbound";
  fromAddress: string;
  receivedAt: number;
}): Promise<void> {
  rows += 1;
  await env.DB.prepare(
    `INSERT INTO pithy_support_messages
       (id, thread_id, direction, from_address, to_address, subject, text_body, received_at, created_at)
     VALUES (?, 't1', ?, ?, 'support@help.acme.test', 'Card declined', 'help', ?, ?)`,
  )
    .bind(`m${rows}`, options.direction, options.fromAddress, options.receivedAt, options.receivedAt)
    .run();
}

/** Insert `count` inbound messages from one address, all inside the window. */
async function inbound(count: number, fromAddress: string): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await insertMessage({ direction: "inbound", fromAddress, receivedAt: minutesAgo(index + 1) });
  }
}

/** Ask the guard about a message arriving now from `fromAddress`. */
function rate(config: SupportGuardConfig, fromAddress = "ada@example.com") {
  return checkRates(supportDatabase(env.DB), config, { rawBytes: 1000, fromAddress, now: NOW });
}

beforeEach(async () => {
  for (const table of [
    "pithy_support_thread_flags",
    "pithy_support_classifications",
    "pithy_support_attachments",
    "pithy_support_messages",
    "pithy_support_threads",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await runMigrations(env.DB, provider());
});

describe("checkSize", () => {
  test("refuses a message over the bound", () => {
    const config = guard({ maxRawBytes: 1024 });
    expect(checkSize(config, 1025)).toMatchObject({ accepted: false, reason: "too_large" });
  });

  test("accepts a message exactly at the bound", () => {
    // The bound is inclusive. Off by one here and every adopter's configured limit is silently one
    // byte tighter than the number they wrote.
    expect(checkSize(guard({ maxRawBytes: 1024 }), 1024)).toEqual({ accepted: true });
  });

  test("names the observed size and the bound in the detail, not in the reason", () => {
    // `reason` lands in the audit trail and `detail` only in the log — so the numbers belong here.
    const verdict = checkSize(guard({ maxRawBytes: 1024 }), 5000);
    expect(verdict.accepted).toBe(false);
    if (verdict.accepted) return;
    expect(verdict.detail).toContain("5000");
    expect(verdict.detail).toContain("1024");
  });
});

describe("checkRates, the per-sender bound", () => {
  test("accepts a sender still under the bound", async () => {
    await inbound(2, "ada@example.com");
    expect(await rate(guard({ maxPerSenderPerHour: 3 }))).toEqual({ accepted: true });
  });

  test("refuses at the bound, because the message being weighed would be one past it", async () => {
    await inbound(3, "ada@example.com");
    expect(await rate(guard({ maxPerSenderPerHour: 3 }))).toMatchObject({ accepted: false, reason: "sender_rate" });
  });

  test("counts one sender's messages, never another's", async () => {
    // The bound is per address. Counting every row would make one loud sender refuse everybody.
    await inbound(5, "grace@example.com");
    expect(await rate(guard({ maxPerSenderPerHour: 3 }), "ada@example.com")).toEqual({ accepted: true });
  });
});

describe("checkRates, the global bound", () => {
  test("refuses once the whole inbox is at the bound, with no single sender near theirs", async () => {
    // The distributed case: four addresses, one message each, none of them anywhere near the
    // per-sender bound of 20. Without the global count this flood is invisible.
    for (const sender of ["a@x.test", "b@x.test", "c@x.test", "d@x.test"]) await inbound(1, sender);
    expect(await rate(guard({ maxPerSenderPerHour: 20, maxPerHour: 4 }))).toMatchObject({
      accepted: false,
      reason: "global_rate",
    });
  });

  test("accepts while the inbox is still under it", async () => {
    for (const sender of ["a@x.test", "b@x.test"]) await inbound(1, sender);
    expect(await rate(guard({ maxPerSenderPerHour: 20, maxPerHour: 4 }))).toEqual({ accepted: true });
  });
});

describe("checkRates, outbound replies", () => {
  test("a burst of the adopter's own replies never locks them out of their own inbox", async () => {
    // Ten replies sent in the last hour, against a global bound of three. A guard that counted every
    // row in the table would refuse the next customer because support answered a lot of mail today,
    // which is the exact opposite of what the bound is for.
    for (let index = 0; index < 10; index += 1) {
      await insertMessage({
        direction: "outbound",
        fromAddress: "support@help.acme.test",
        receivedAt: minutesAgo(index + 1),
      });
    }
    expect(await rate(guard({ maxPerSenderPerHour: 3, maxPerHour: 3 }))).toEqual({ accepted: true });
  });

  test("a reply sent to a sender does not count against that sender's own bound", async () => {
    await inbound(2, "ada@example.com");
    for (let index = 0; index < 5; index += 1) {
      await insertMessage({ direction: "outbound", fromAddress: "ada@example.com", receivedAt: minutesAgo(index + 1) });
    }
    // Two inbound, five outbound, a bound of three: only the direction filter makes this accept.
    expect(await rate(guard({ maxPerSenderPerHour: 3 }))).toEqual({ accepted: true });
  });
});

describe("checkRates, the sliding window", () => {
  test("a message 61 minutes old has slid out and no longer counts", async () => {
    for (const minutes of [61, 62, 63]) {
      await insertMessage({ direction: "inbound", fromAddress: "ada@example.com", receivedAt: minutesAgo(minutes) });
    }
    expect(await rate(guard({ maxPerSenderPerHour: 3 }))).toEqual({ accepted: true });
  });

  test("a message 59 minutes old is still inside it", async () => {
    for (const minutes of [59, 30, 1]) {
      await insertMessage({ direction: "inbound", fromAddress: "ada@example.com", receivedAt: minutesAgo(minutes) });
    }
    expect(await rate(guard({ maxPerSenderPerHour: 3 }))).toMatchObject({ accepted: false, reason: "sender_rate" });
  });

  test("the window edge itself counts, so it slides rather than stepping", async () => {
    // Exactly one hour old, to the millisecond. The predicate is `>= now - window`, and a fixed
    // hourly bucket instead of this sliding one would let twice the bound through at the boundary —
    // which is precisely when a retry storm arrives.
    for (let index = 0; index < 3; index += 1) {
      await insertMessage({
        direction: "inbound",
        fromAddress: "ada@example.com",
        receivedAt: NOW.getTime() - GUARD_WINDOW_MS,
      });
    }
    expect(await rate(guard({ maxPerSenderPerHour: 3 }))).toMatchObject({ accepted: false, reason: "sender_rate" });
  });

  test("an empty inbox accepts", async () => {
    expect(await rate(guard({ maxPerSenderPerHour: 1, maxPerHour: 1 }))).toEqual({ accepted: true });
  });
});
