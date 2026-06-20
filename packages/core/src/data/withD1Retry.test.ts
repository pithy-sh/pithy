import { describe, expect, test, vi } from "vitest";
import { D1_TRANSIENT_ERRORS, D1RetryableError, type D1RetryInfo, withD1Retry } from "./withD1Retry";

/** A D1-shaped error: a plain `Error` whose message carries the fault signature D1 emits. */
function d1Error(message: string): Error {
  return new Error(message);
}

const TIMEOUT_MESSAGE = "D1_ERROR: statement exceeded timeout";
const BUSY_MESSAGE = "database is locked";
const UNIQUE_MESSAGE = "UNIQUE constraint failed: pithy_audit_events.event_id";

describe("withD1Retry", () => {
  test("returns the result without retrying when the first attempt succeeds", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withD1Retry(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries a timeout fault and succeeds on a later attempt", async () => {
    let calls = 0;
    const onRetry = vi.fn<(info: D1RetryInfo) => void>();
    const result = await withD1Retry(
      async () => {
        calls += 1;
        if (calls < 3) throw d1Error(TIMEOUT_MESSAGE);
        return calls;
      },
      { initialDelayMs: 1, onRetry },
    );
    expect(result).toBe(3);
    expect(calls).toBe(3);
    // Two failures before the success → two retry notifications, with growing backoff.
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ error: "timeout", attempt: 0, delayMs: 1 });
    expect(onRetry.mock.calls[1]?.[0]).toMatchObject({ error: "timeout", attempt: 1, delayMs: 2 });
  });

  // D1 surfaces a whole family of transient faults; by default every one is retried.
  test.each([
    ["network connection loss", "Network connection lost.", "network"],
    ["a connection reset", "D1_ERROR: connection was reset", "network"],
    ["a storage-object reset", "Durable Object reset because its code was updated", "storage-reset"],
    ["an object reset mid-flight", "storage operation caused object to be reset", "storage-reset"],
    ["an internal error", "D1_ERROR: internal error", "internal"],
    ["an unresolvable D1", "Cannot resolve D1 due to an internal error", "internal"],
    ["a busy database", "SQLITE_BUSY: database is locked", "database-busy"],
  ])("retries %s by default and reports it as %s", async (_label, message, fault) => {
    let calls = 0;
    const onRetry = vi.fn<(info: D1RetryInfo) => void>();
    const result = await withD1Retry(
      async () => {
        calls += 1;
        if (calls < 2) throw d1Error(message);
        return "recovered";
      },
      { initialDelayMs: 1, onRetry },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
    expect(onRetry.mock.calls[0]?.[0].error).toBe(fault);
  });

  test("matches fault signatures case-insensitively", async () => {
    let calls = 0;
    const result = await withD1Retry(
      async () => {
        calls += 1;
        if (calls < 2) throw d1Error("NETWORK CONNECTION LOST");
        return "ok";
      },
      { initialDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("D1_TRANSIENT_ERRORS is the default retryOn and excludes the guard-only unique-constraint", () => {
    expect(D1_TRANSIENT_ERRORS).not.toContain(D1RetryableError.UNIQUE_CONSTRAINT);
    expect(D1_TRANSIENT_ERRORS).toContain(D1RetryableError.TIMEOUT);
    expect(D1_TRANSIENT_ERRORS).toContain(D1RetryableError.NETWORK);
    expect(D1_TRANSIENT_ERRORS).toContain(D1RetryableError.INTERNAL);
  });

  test("rethrows a non-retryable error immediately, untouched", async () => {
    const boom = new Error("no such table: pithy_audit_events");
    const fn = vi.fn(async () => {
      throw boom;
    });
    await expect(withD1Retry(fn, { initialDelayMs: 1 })).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("honors a narrowed retryOn: a fault not listed is not retried", async () => {
    const fn = vi.fn(async () => {
      throw d1Error(BUSY_MESSAGE);
    });
    // retryOn narrowed to timeout only, so a busy error is not retried even though it's transient.
    await expect(withD1Retry(fn, { retryOn: [D1RetryableError.TIMEOUT], initialDelayMs: 1 })).rejects.toThrow(
      BUSY_MESSAGE,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("exhausts retries and throws the last error", async () => {
    const fn = vi.fn(async () => {
      throw d1Error(TIMEOUT_MESSAGE);
    });
    await expect(withD1Retry(fn, { maxRetries: 2, initialDelayMs: 1 })).rejects.toThrow(TIMEOUT_MESSAGE);
    // initial attempt + 2 retries.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("idempotency guard: a unique-constraint on a retry resolves instead of throwing", async () => {
    let calls = 0;
    const result = await withD1Retry(
      async () => {
        calls += 1;
        // First a timeout (the transport hiccup), then the retry hits the row the first attempt
        // actually committed — a unique-constraint that means the write already succeeded.
        if (calls === 1) throw d1Error(TIMEOUT_MESSAGE);
        throw d1Error(UNIQUE_MESSAGE);
      },
      { initialDelayMs: 1 },
    );
    expect(result).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("a unique-constraint on the FIRST attempt is a real conflict and throws", async () => {
    const fn = vi.fn(async () => {
      throw d1Error(UNIQUE_MESSAGE);
    });
    // unique-constraint is never a retry initiator, so it propagates on the first attempt.
    await expect(withD1Retry(fn, { initialDelayMs: 1 })).rejects.toThrow(UNIQUE_MESSAGE);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
