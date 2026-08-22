// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import { READY_DEADLINE_MS, READY_REMINDER_MS, type Schedule, stillWaitingLines, watchReady } from "./readyWatch";

/** A hand-driven clock: the timer seam plus the only two verbs a test needs. */
function clock(): { schedule: Schedule; advance: (ms: number) => void; pending: () => number } {
  const timers: { at: number; run: () => void; done: boolean }[] = [];
  let elapsed = 0;
  return {
    schedule: (ms, run) => {
      const timer = { at: elapsed + ms, run, done: false };
      timers.push(timer);
      return () => {
        timer.done = true;
      };
    },
    advance: (ms) => {
      elapsed += ms;
      for (const timer of [...timers]) {
        if (timer.done || timer.at > elapsed) continue;
        timer.done = true;
        timer.run();
      }
    },
    pending: () => timers.filter((timer) => !timer.done).length,
  };
}

/**
 * Start a watch over a mutable pending set, recording every report and the lines a person would see.
 *
 * **`pending` hands back a copy, and that is the whole reason the tests below can fail.** The property
 * under test is that the set is read at *every tick* rather than captured once — and a `() => pending`
 * that returned the live array made the two indistinguishable: an implementation that called `pending()`
 * once still held the array everything else mutates, so it observed the same `shift()` the correct one
 * did. The test named after that property passed against exactly the bug it was written for. A snapshot
 * per call is what makes the call the seam, so a captured set goes stale and the assertion sees it.
 *
 * The recorded reports are copied for the same reason, one layer out.
 */
function watching(pending: string[], overrides: { deadlineMs?: number; reminderMs?: number } = {}) {
  const time = clock();
  const lines: string[] = [];
  const reports: { waiting: string[]; first: boolean }[] = [];
  const watch = watchReady({
    pending: () => [...pending],
    report: (waiting, first) => {
      reports.push({ waiting: [...waiting], first });
      for (const line of stillWaitingLines(waiting, first)) lines.push(line);
    },
    schedule: time.schedule,
    ...overrides,
  });
  return { time, lines, reports, watch };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stillWaitingLines", () => {
  test("names every worker still starting, not how many", () => {
    expect(stillWaitingLines(["support", "email"], true)[0]).toBe("Still waiting on: support, email.");
  });

  test("carries the reason nothing else reported it, once", () => {
    const first = stillWaitingLines(["support"], true);
    expect(first).toHaveLength(3);
    // The mechanism every cause of this deadline shares — a live child nothing else will mention — and
    // never one cause. A build error, a hung startup, a port that never binds and a Vite `dev.command`
    // worker all land here, and only the first of those involves wrangler at all.
    expect(first[1]).toContain("keeps running, so nothing else reports it");
    expect(first.join(" ")).not.toContain("wrangler");
    // The action names the restart, because a wrangler dev whose first build failed never rebuilds.
    expect(first[2]).toContain("run pithy dev again");
    // The repeat is one short line — it is there to be found in scrollback, not read again.
    expect(stillWaitingLines(["support"], false)).toEqual(["Still waiting on: support."]);
  });
});

describe("watchReady", () => {
  test("says nothing before the deadline — a cold first build is not a broken one", () => {
    const w = watching(["api"], { deadlineMs: 1000 });
    w.time.advance(999);
    expect(w.reports).toEqual([]);
  });

  test("names the worker that has not arrived, at the deadline", () => {
    const w = watching(["support"], { deadlineMs: 1000 });
    w.time.advance(1000);
    expect(w.reports).toEqual([{ waiting: ["support"], first: true }]);
    expect(w.lines[0]).toBe("Still waiting on: support.");
  });

  test("repeats a short line while the set stays non-empty", () => {
    const w = watching(["support"], { deadlineMs: 1000, reminderMs: 500 });
    w.time.advance(1000);
    w.time.advance(500);
    w.time.advance(500);
    expect(w.reports.map((report) => report.first)).toEqual([true, false, false]);
    expect(w.lines.filter((line) => line === "Still waiting on: support.")).toHaveLength(3);
    // The reason is said once; the repeats are the short line alone.
    expect(w.lines.filter((line) => line.includes("keeps running"))).toHaveLength(1);
  });

  test("the report follows the set — a worker that arrives drops out of the next one", () => {
    const pending = ["api", "support"];
    const w = watching(pending, { deadlineMs: 1000, reminderMs: 500 });
    w.time.advance(1000);
    pending.shift();
    w.time.advance(500);
    // Both reports, asserted together: the second is the set as it stood at the second tick, which is
    // the claim. A watch that read `pending()` once reports `["api", "support"]` twice and fails here.
    expect(w.reports).toEqual([
      { waiting: ["api", "support"], first: true },
      { waiting: ["support"], first: false },
    ]);
  });

  test("a worker that arrives after the last one leaves ends the watch", () => {
    const pending = ["api", "support"];
    const w = watching(pending, { deadlineMs: 1000, reminderMs: 500 });
    w.time.advance(1000);
    pending.length = 0;
    w.time.advance(500);
    // One report, and nothing left ticking: the empty set is what stops it, read at that tick.
    expect(w.reports).toHaveLength(1);
    expect(w.time.pending()).toBe(0);
  });

  test("goes quiet once the set empties, and schedules nothing more", () => {
    const pending = ["api"];
    const w = watching(pending, { deadlineMs: 1000, reminderMs: 500 });
    pending.pop();
    w.time.advance(1000);
    expect(w.reports).toEqual([]);
    expect(w.time.pending()).toBe(0);
  });

  test("stop cancels the pending timer, and is idempotent", () => {
    const w = watching(["api"], { deadlineMs: 1000, reminderMs: 500 });
    w.watch.stop();
    w.watch.stop();
    w.time.advance(5000);
    expect(w.reports).toEqual([]);
    expect(w.time.pending()).toBe(0);
  });

  test("stopping between ticks silences the repeat", () => {
    const w = watching(["api"], { deadlineMs: 1000, reminderMs: 500 });
    w.time.advance(1000);
    expect(w.reports).toHaveLength(1);
    w.watch.stop();
    w.time.advance(500);
    expect(w.reports).toHaveLength(1);
  });

  test("defaults to the stated deadline and reminder, on the real timer", () => {
    vi.useFakeTimers();
    const reports: string[][] = [];
    const watch = watchReady({ pending: () => ["support"], report: (waiting) => reports.push([...waiting]) });

    vi.advanceTimersByTime(READY_DEADLINE_MS - 1);
    expect(reports).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reports).toEqual([["support"]]);
    vi.advanceTimersByTime(READY_REMINDER_MS);
    expect(reports).toEqual([["support"], ["support"]]);
    watch.stop();
  });
});
