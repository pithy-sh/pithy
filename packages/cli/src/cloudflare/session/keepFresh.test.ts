// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import { keepBoundSessionFresh } from "./keepFresh";

afterEach(() => {
  vi.useRealTimers();
});

describe("keepBoundSessionFresh", () => {
  test("checks on every interval, never two at once, and stops when told", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release: () => void = () => {};
    const keeper = keepBoundSessionFresh({
      cwd: "/project",
      intervalMs: 1_000,
      freshen: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    keeper.stop();
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2);
  });
});
