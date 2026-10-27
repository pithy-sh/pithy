// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test, vi } from "vitest";
import {
  AUDIT_QUEUE_CAPABILITY,
  AUDIT_SHIP_BINDING,
  AUDIT_SHIP_DLQ_BINDING,
  AUDIT_SHIP_MAX_BATCH,
  AUDIT_SHIP_MAX_RETRIES,
  enqueueShipments,
  isFinalAttempt,
  retryDelaySeconds,
  ShipMessage,
  type ShipQueue,
  shipBindings,
} from "./queue";
import { AuditSinks } from "./sinks";

/** The shipping queue (#824): what goes on it, what the Worker binds for it, and how a failed shipment backs off. */

const SINKS = AuditSinks.parse({
  everything: { profile: "webhook", url: "https://hooks.example.com/audit", secret: "hook-token" },
  auth: {
    profile: "splunk-hec",
    url: "https://splunk.example.com/services/collector",
    secret: "hec",
    actions: ["auth/"],
  },
});

const AUTH_ONLY = AuditSinks.parse({ auth: SINKS.auth });

/** A queue that records every batch it is sent. */
function fakeQueue() {
  const batches: { body: unknown }[][] = [];
  const queue: ShipQueue = {
    sendBatch: vi.fn(async (messages: Iterable<{ body: unknown }>) => {
      batches.push([...messages]);
    }),
  };
  return { queue, batches };
}

describe("enqueueShipments", () => {
  test("one message per sink that takes the event, in one batch, naming the sink and the event", async () => {
    const { queue, batches } = fakeQueue();
    const sent = await enqueueShipments(queue, SINKS, { eventId: "evt-1", action: "auth/login" });
    expect(sent).toBe(2);
    expect(batches).toEqual([
      [
        { body: { capability: AUDIT_QUEUE_CAPABILITY, sink: "everything", eventId: "evt-1" } },
        { body: { capability: AUDIT_QUEUE_CAPABILITY, sink: "auth", eventId: "evt-1" } },
      ],
    ]);
    for (const { body } of batches[0] ?? []) expect(ShipMessage.strict().parse(body)).toEqual(body);
  });

  test("a sink whose filter does not take the action gets no message", async () => {
    const { queue, batches } = fakeQueue();
    expect(await enqueueShipments(queue, SINKS, { eventId: "evt-2", action: "payments/refund" })).toBe(1);
    expect(batches).toEqual([[{ body: { capability: AUDIT_QUEUE_CAPABILITY, sink: "everything", eventId: "evt-2" } }]]);
  });

  test("an event no sink takes sends nothing at all, not an empty batch", async () => {
    const { queue } = fakeQueue();
    expect(await enqueueShipments(queue, AUTH_ONLY, { eventId: "evt-3", action: "payments/refund" })).toBe(0);
    expect(await enqueueShipments(queue, {}, { eventId: "evt-4", action: "auth/login" })).toBe(0);
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  test("a queue that throws throws to the caller, which is the recorder's to catch", async () => {
    const queue: ShipQueue = {
      sendBatch: async () => {
        throw new Error("queue unavailable");
      },
    };
    await expect(enqueueShipments(queue, SINKS, { eventId: "evt-5", action: "auth/login" })).rejects.toThrow(
      "queue unavailable",
    );
  });
});

describe("shipBindings", () => {
  test("no sink, no queue: a project that ships nothing binds neither", () => {
    expect(shipBindings({})).toEqual([]);
  });

  test("a sink binds the queue it produces to and consumes, and an optional dead-letter queue", () => {
    expect(shipBindings(AUTH_ONLY)).toEqual([
      {
        type: "queue",
        name: AUDIT_SHIP_BINDING,
        consumer: {
          deadLetter: AUDIT_SHIP_DLQ_BINDING,
          maxRetries: AUDIT_SHIP_MAX_RETRIES,
          maxBatchSize: AUDIT_SHIP_MAX_BATCH,
        },
      },
      { type: "queue", name: AUDIT_SHIP_DLQ_BINDING, optional: true },
    ]);
  });

  test("the bindings are the same however many sinks there are", () => {
    expect(shipBindings(SINKS)).toEqual(shipBindings(AUTH_ONLY));
  });
});

describe("retryDelaySeconds", () => {
  test("doubles from 30 seconds", () => {
    expect([1, 2, 3, 4, 5].map(retryDelaySeconds)).toEqual([30, 60, 120, 240, 480]);
  });

  test("never waits past an hour", () => {
    expect(retryDelaySeconds(7)).toBe(1920);
    expect(retryDelaySeconds(8)).toBe(3600);
    expect(retryDelaySeconds(AUDIT_SHIP_MAX_RETRIES)).toBe(3600);
    expect(retryDelaySeconds(1_000)).toBe(3600);
  });

  test("an attempt count of zero or less waits the first delay, never a fraction of it", () => {
    expect(retryDelaySeconds(0)).toBe(30);
    expect(retryDelaySeconds(-5)).toBe(30);
  });
});

describe("isFinalAttempt", () => {
  test("the attempt after the last retry is final; the last retry itself is not", () => {
    expect(isFinalAttempt(1)).toBe(false);
    expect(isFinalAttempt(AUDIT_SHIP_MAX_RETRIES)).toBe(false);
    expect(isFinalAttempt(AUDIT_SHIP_MAX_RETRIES + 1)).toBe(true);
  });

  test("honors a retry limit it is given", () => {
    expect(isFinalAttempt(3, 3)).toBe(false);
    expect(isFinalAttempt(4, 3)).toBe(true);
    expect(isFinalAttempt(1, 0)).toBe(true);
  });
});
