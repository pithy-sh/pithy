// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ExecutionContext } from "@cloudflare/workers-types";
import { describe, expect, test, vi } from "vitest";
import {
  type CapabilityQueueHandler,
  dispatchQueueBatch,
  type QueueBatch,
  queueBody,
  queueMessageCapability,
} from "./consumer";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function message(id: string, body: unknown) {
  return { id, body, attempts: 1, timestamp: new Date(), ack: vi.fn(), retry: vi.fn() };
}

function batch(messages: ReturnType<typeof message>[]): QueueBatch {
  return { queue: "acme-prod-audit-ship", messages };
}

describe("queueBody", () => {
  test("stamps the capability onto the body, and the stamp reads back", () => {
    const body = queueBody("audit", { sink: "siem", eventId: "e1" });
    expect(body).toEqual({ sink: "siem", eventId: "e1", capability: "audit" });
    expect(queueMessageCapability(body)).toBe("audit");
  });

  test("a body that names nothing, or is not an object, names no capability", () => {
    for (const body of [null, "text", 3, {}, { capability: "" }, { capability: 7 }]) {
      expect(queueMessageCapability(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe("dispatchQueueBatch", () => {
  test("hands each capability only the messages that name it", async () => {
    const audit = vi.fn<CapabilityQueueHandler>(async () => {});
    const other = vi.fn<CapabilityQueueHandler>(async () => {});
    const a = message("a", { capability: "audit" });
    const b = message("b", { capability: "other" });
    const c = message("c", { capability: "audit" });
    await dispatchQueueBatch(
      batch([a, b, c]),
      new Map([
        ["audit", audit],
        ["other", other],
      ]),
      {},
      ctx,
    );
    expect(audit.mock.calls[0]?.[0].map((m) => m.id)).toEqual(["a", "c"]);
    expect(other.mock.calls[0]?.[0].map((m) => m.id)).toEqual(["b"]);
  });

  test("acknowledges and logs a message no composed capability claims, rather than retrying it", async () => {
    const log = { warn: vi.fn() };
    const stray = message("s", { capability: "gone" });
    const bare = message("n", "not an object");
    await dispatchQueueBatch(batch([stray, bare]), new Map(), {}, ctx, log);
    expect(stray.ack).toHaveBeenCalled();
    expect(bare.ack).toHaveBeenCalled();
    expect(stray.retry).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  test("a handler that throws costs its own messages only, and the failure is rethrown after the pass", async () => {
    const boom = new Error("sink down");
    const failing = vi.fn<CapabilityQueueHandler>(async () => {
      throw boom;
    });
    const healthy = vi.fn<CapabilityQueueHandler>(async () => {});
    await expect(
      dispatchQueueBatch(
        batch([message("a", { capability: "failing" }), message("b", { capability: "healthy" })]),
        new Map([
          ["failing", failing],
          ["healthy", healthy],
        ]),
        {},
        ctx,
      ),
    ).rejects.toBe(boom);
    expect(healthy).toHaveBeenCalled();
  });
});
