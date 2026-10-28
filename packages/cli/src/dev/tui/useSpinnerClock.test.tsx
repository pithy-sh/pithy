// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Text } from "ink";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SPINNER_INTERVAL_MS } from "./footer";
import { useSpinnerClock } from "./useSpinnerClock";

const START = 1_700_000_000_000;

/** Render a probe that records each clock reading it is handed. */
function probe(moving: boolean) {
  const seen: number[] = [];
  function Probe(props: { moving: boolean }) {
    const now = useSpinnerClock(props.moving);
    seen.push(now.getTime());
    return <Text>{now.getTime()}</Text>;
  }
  const view = render(<Probe moving={moving} />);
  return { seen, rerender: (next: boolean) => view.rerender(<Probe moving={next} />), unmount: view.unmount };
}

/** Advance the clock, then let React's real scheduler flush the renders the interval queued. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ["setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSpinnerClock", () => {
  test("while moving, the clock is re-read once per spinner interval", async () => {
    const clock = probe(true);
    await advance(0);
    const start = clock.seen.at(-1);
    await advance(SPINNER_INTERVAL_MS);
    expect(clock.seen.at(-1)).toBe((start ?? START) + SPINNER_INTERVAL_MS);
    await advance(SPINNER_INTERVAL_MS * 3);
    expect(clock.seen.at(-1)).toBe((start ?? START) + SPINNER_INTERVAL_MS * 4);
    clock.unmount();
  });

  test("while nothing moves, the clock never changes", async () => {
    const clock = probe(false);
    await advance(SPINNER_INTERVAL_MS * 10);
    expect(new Set(clock.seen)).toEqual(new Set([START]));
    expect(vi.getTimerCount()).toBe(0);
    clock.unmount();
  });

  test("once nothing moves, the interval is cleared and the clock freezes", async () => {
    const clock = probe(true);
    await advance(SPINNER_INTERVAL_MS * 2);
    clock.rerender(false);
    await advance(0);
    const frozen = clock.seen.at(-1);
    const renders = clock.seen.length;
    await advance(SPINNER_INTERVAL_MS * 10);
    expect(clock.seen.length).toBe(renders);
    expect(clock.seen.at(-1)).toBe(frozen);
    clock.unmount();
  });
});
