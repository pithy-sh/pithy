// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  METADATA_INDEX_SETTLE_MS,
  metadataIndexesSettled,
  SETTLE_TIMEOUT_MS,
  STABLE_READS,
  UPSERT_SETTLE_MS,
  waitFor,
  waitForStable,
} from "./settle";

/** A read that answers each value in turn, then repeats the last one. Counts its calls. */
function sequence<T>(values: readonly T[]): { read: () => Promise<T>; calls: () => number } {
  let index = 0;
  return {
    read: async () => {
      const value = values[Math.min(index, values.length - 1)] as T;
      index += 1;
      return value;
    },
    calls: () => index,
  };
}

const fast = { intervalMs: 1 } as const;

describe("the settle budget", () => {
  // The numbers the live Vectorize suites share. Measured at 25-50s for a control-plane change, and the
  // metadata-index list was watched flapping for 18s after it first agreed, so 60s and one read are not
  // enough.
  it("is 120s and three agreeing reads", () => {
    expect(SETTLE_TIMEOUT_MS).toBe(120_000);
    expect(STABLE_READS).toBe(3);
  });
});

describe("the metadata-index budget", () => {
  // Measured live: a metadata index settled in about 97s on one run and was still unsettled at 120s on the
  // next, so the shared 120s budget undercuts exactly this wait.
  it("is 300s, and longer than every other wait's", () => {
    expect(METADATA_INDEX_SETTLE_MS).toBe(300_000);
    expect(METADATA_INDEX_SETTLE_MS).toBeGreaterThan(SETTLE_TIMEOUT_MS);
  });
});

describe("the upsert budget", () => {
  // An upsert written right after a metadata index was still missing from the query at 121s, with the vectors
  // before it visible. The wait is on the query, not on `processedUpToMutation`: the watermark steps through
  // mutation ids nobody issued, and an unordered UUID cannot say whether it has passed ours.
  it("is 300s, longer than the shared budget and no shorter than a metadata index's", () => {
    expect(UPSERT_SETTLE_MS).toBe(300_000);
    expect(UPSERT_SETTLE_MS).toBeGreaterThan(SETTLE_TIMEOUT_MS);
    expect(UPSERT_SETTLE_MS).toBeGreaterThanOrEqual(METADATA_INDEX_SETTLE_MS);
  });
});

describe("metadataIndexesSettled", () => {
  const declared = [
    { propertyName: "tenantId", indexType: "string" },
    { propertyName: "rank", indexType: "number" },
  ] as const;
  const settled = metadataIndexesSettled(declared);

  it("holds when every declared index is live under its own name and type", () => {
    expect(
      settled([
        { propertyName: "rank", indexType: "number" },
        { propertyName: "tenantId", indexType: "string" },
      ]),
    ).toBe(true);
  });

  it("does not hold on a list of the right length with the wrong names", () => {
    // What the length-only predicate it replaced passed: two entries, neither of them `rank`.
    expect(
      settled([
        { propertyName: "tenantId", indexType: "string" },
        { propertyName: "stage", indexType: "string" },
      ]),
    ).toBe(false);
  });

  it("does not hold when a declared index is live as another type", () => {
    expect(
      settled([
        { propertyName: "tenantId", indexType: "string" },
        { propertyName: "rank", indexType: "string" },
      ]),
    ).toBe(false);
  });

  it("does not hold on a partial list, and is not upset by an undeclared extra", () => {
    expect(settled([{ propertyName: "tenantId", indexType: "string" }])).toBe(false);
    expect(settled([...declared, { propertyName: "stage", indexType: "string" }])).toBe(true);
  });
});

describe("waitFor", () => {
  it("returns as soon as the condition holds", async () => {
    const reads = sequence([false, false, true]);
    await waitFor("the thing", reads.read, { ...fast, timeoutMs: 1_000 });
    expect(reads.calls()).toBe(3);
  });

  it("names what it waited for when the budget runs out", async () => {
    await expect(waitFor("index x to be addressable", async () => false, { ...fast, timeoutMs: 5 })).rejects.toThrow(
      /Timed out after \d+s waiting for index x to be addressable/,
    );
  });
});

describe("waitForStable", () => {
  it("returns the last value once it has settled across the required reads", async () => {
    const reads = sequence([[], ["a"], ["a"], ["a"]]);
    const settled = await waitForStable("the list", reads.read, (value) => value.length === 1, {
      ...fast,
      timeoutMs: 1_000,
    });
    expect(settled).toEqual(["a"]);
    expect(reads.calls()).toBe(1 + STABLE_READS);
  });

  // The flap a live probe watched: the list reported the property, then dropped it, then reported it again.
  // One agreeing read is not settled, so a disagreement starts the count over.
  it("starts the count over when a read disagrees", async () => {
    const reads = sequence([["a"], ["a"], [], ["a"], ["a"], ["a"]]);
    await waitForStable("the list", reads.read, (value) => value.length === 1, { ...fast, timeoutMs: 1_000 });
    expect(reads.calls()).toBe(6);
  });

  it("takes the number of agreeing reads as an option", async () => {
    const reads = sequence([true]);
    await waitForStable("the flag", reads.read, (value) => value, { ...fast, timeoutMs: 1_000, stableReads: 1 });
    expect(reads.calls()).toBe(1);
  });

  it("names what it waited for, and the last read, when the budget runs out", async () => {
    await expect(
      waitForStable(
        "the list",
        async () => ["b"],
        (value) => value.includes("a"),
        { ...fast, timeoutMs: 5 },
      ),
    ).rejects.toThrow(/waiting for the list to settle across 3 reads\. Last read: \["b"\]/);
  });
});

// A live test makes several waits in a row, and each one's own budget is no bound on their sum. When the sum
// outruns the test's timeout, vitest abandons the body mid-wait: the failure names no step, and the teardown
// that deletes the index never runs. A shared deadline makes the step in progress fail by name instead.
describe("a deadline shared across waits", () => {
  it("cuts waitFor short at the deadline and says the shared budget ran out", async () => {
    const started = Date.now();
    await expect(
      waitFor("the late upsert to be queryable", async () => false, {
        ...fast,
        timeoutMs: 60_000,
        deadline: Date.now() + 20,
      }),
    ).rejects.toThrow(/waiting for the late upsert to be queryable.*shared deadline/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("cuts waitForStable short at the deadline, naming the step and the last read", async () => {
    const started = Date.now();
    await expect(
      waitForStable(
        "the late `stage` filter",
        async () => ["b"],
        (value) => value.includes("a"),
        {
          ...fast,
          timeoutMs: 60_000,
          deadline: Date.now() + 20,
        },
      ),
    ).rejects.toThrow(
      /waiting for the late `stage` filter to settle across 3 reads.*shared deadline.*Last read: \["b"\]/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps the step's own budget when the deadline is further away", async () => {
    await expect(
      waitFor("index x to be addressable", async () => false, { ...fast, timeoutMs: 5, deadline: Date.now() + 60_000 }),
    ).rejects.toThrow(/^Timed out after \d+s waiting for index x to be addressable\. Cloudflare applies/);
  });

  it("still reads once when the deadline has already passed, so a ready condition is not failed unread", async () => {
    const reads = sequence([true]);
    await waitFor("the thing", reads.read, { ...fast, deadline: Date.now() - 1 });
    expect(reads.calls()).toBe(1);
  });
});
