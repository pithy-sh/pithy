// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type Read, type ReadOptions, ReadTimeout, useRead } from "./read";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A read the test answers by hand, recording the signal each call was given. */
function deferredReads<T>() {
  const calls: { key: string; signal: AbortSignal; resolve: (value: T) => void; reject: (error: unknown) => void }[] =
    [];
  const read = (key: string) => (signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ key, signal, resolve, reject });
    });
  return { calls, read };
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

/** Mount a probe that records every render's view of the read. */
function mount<T>(
  initial: { key: string; read: (signal: AbortSignal) => Promise<T>; options?: ReadOptions },
  strict = false,
) {
  const seen: Read<T>[] = [];
  let props = initial;
  function Probe({ args }: { args: typeof initial }) {
    const result = useRead(args.key, args.read, args.options);
    seen.push(result);
    return null;
  }
  const host = document.createElement("div");
  root = createRoot(host);
  const render = () => {
    const tree = <Probe args={props} />;
    root?.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  };
  act(render);
  return {
    seen,
    last: () => seen[seen.length - 1] as Read<T>,
    rerender(next: Partial<typeof initial>) {
      props = { ...props, ...next };
      act(render);
    },
  };
}

describe("useRead", () => {
  test("starts loading, then holds the value the read answered", async () => {
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a") });
    expect(probe.last()).toMatchObject({ value: undefined, loading: true, failure: null });
    await act(async () => reads.calls[0]?.resolve("first"));
    expect(probe.last()).toMatchObject({ value: "first", loading: false, failure: null });
  });

  test("a response that arrives after a newer read is discarded", async () => {
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a") });
    probe.rerender({ key: "b", read: reads.read("b") });
    await act(async () => reads.calls[1]?.resolve("b answered"));
    await act(async () => reads.calls[0]?.resolve("a answered late"));
    expect(probe.last().value).toBe("b answered");
  });

  test("the read's signal aborts when a newer read supersedes it", () => {
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a") });
    expect(reads.calls[0]?.signal.aborted).toBe(false);
    probe.rerender({ key: "b", read: reads.read("b") });
    expect(reads.calls[0]?.signal.aborted).toBe(true);
    expect(reads.calls[1]?.signal.aborted).toBe(false);
  });

  test("the read's signal aborts on unmount, and a response after it sets no state", async () => {
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a") });
    const renders = probe.seen.length;
    act(() => root?.unmount());
    root = null;
    expect(reads.calls[0]?.signal.aborted).toBe(true);
    await act(async () => reads.calls[0]?.resolve("too late"));
    expect(probe.seen.length).toBe(renders);
  });

  test("a skipped read makes no request, and is not loading", () => {
    const read = vi.fn(async () => "never");
    const probe = mount({ key: "a", read, options: { skip: true } });
    expect(read).not.toHaveBeenCalled();
    expect(probe.last()).toMatchObject({ value: undefined, loading: false, failure: null });
  });

  test("a skipped read runs once the condition holds", async () => {
    const read = vi.fn(async () => "now");
    const probe = mount({ key: "a", read, options: { skip: true } });
    probe.rerender({ options: { skip: false } });
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(1);
    expect(probe.last().value).toBe("now");
  });

  test("refresh re-runs the read", async () => {
    let count = 0;
    const read = vi.fn(async () => ++count);
    const probe = mount({ key: "a", read });
    await act(async () => undefined);
    expect(probe.last().value).toBe(1);
    await act(async () => probe.last().refresh());
    expect(read).toHaveBeenCalledTimes(2);
    expect(probe.last().value).toBe(2);
  });

  test("a re-render with the same key reads nothing again", async () => {
    const read = vi.fn(async () => "once");
    const probe = mount({ key: "a", read });
    await act(async () => undefined);
    probe.rerender({ read: vi.fn(async () => "other") });
    probe.rerender({});
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("the first render after the key changes is loading, though it still holds the last key's value", async () => {
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a") });
    await act(async () => reads.calls[0]?.resolve("a answered"));
    const before = probe.seen.length;
    probe.rerender({ key: "b", read: reads.read("b") });
    const first = probe.seen[before] as Read<string>;
    expect(first).toMatchObject({ value: "a answered", loading: true });
    await act(async () => reads.calls[1]?.resolve("b answered"));
    expect(probe.last()).toMatchObject({ value: "b answered", loading: false });
  });

  test("the first render after refresh is loading", async () => {
    const read = vi.fn(async () => "fresh");
    const probe = mount({ key: "a", read });
    await act(async () => undefined);
    const before = probe.seen.length;
    act(() => probe.last().refresh());
    expect((probe.seen[before] as Read<string>).loading).toBe(true);
  });

  test("the first render after skip turns false is loading", () => {
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a"), options: { skip: true } });
    expect(probe.last().loading).toBe(false);
    const before = probe.seen.length;
    probe.rerender({ options: { skip: false } });
    expect((probe.seen[before] as Read<string>).loading).toBe(true);
  });

  test("a failure for one key is not reported for the next", async () => {
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a") });
    await act(async () => reads.calls[0]?.reject(new Error("a failed")));
    expect(probe.last().failure?.message).toBe("a failed");
    const before = probe.seen.length;
    probe.rerender({ key: "b", read: reads.read("b") });
    expect(probe.seen.slice(before).every((seen) => seen.failure === null)).toBe(true);
  });

  test("a failed read lands in failure, not as a throw, and keeps the last value", async () => {
    let fail = false;
    const read = async () => {
      if (fail) throw new Error("down");
      return "good";
    };
    const probe = mount({ key: "a", read });
    await act(async () => undefined);
    fail = true;
    await act(async () => probe.last().refresh());
    expect(probe.last()).toMatchObject({ value: "good", loading: false });
    expect(probe.last().failure?.message).toBe("down");
    fail = false;
    await act(async () => probe.last().refresh());
    expect(probe.last().failure).toBeNull();
  });

  test("a thrown value that is not an Error still lands as one", async () => {
    const probe = mount({
      key: "a",
      read: async () => {
        throw "plain";
      },
    });
    await act(async () => undefined);
    expect(probe.last().failure).toBeInstanceOf(Error);
    expect(probe.last().failure?.message).toBe("plain");
  });

  test("an aborted read lands in neither value nor failure", async () => {
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a") });
    probe.rerender({ key: "b", read: reads.read("b") });
    await act(async () => reads.calls[0]?.reject(new DOMException("aborted", "AbortError")));
    expect(probe.last()).toMatchObject({ value: undefined, failure: null, loading: true });
  });

  test("a read past its deadline is aborted and lands in failure as timed out", async () => {
    vi.useFakeTimers();
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a"), options: { deadline: 5_000 } });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(reads.calls[0]?.signal.aborted).toBe(true);
    expect(probe.last().loading).toBe(false);
    expect(probe.last().failure).toBeInstanceOf(ReadTimeout);
    await act(async () => reads.calls[0]?.resolve("after the deadline"));
    expect(probe.last().value).toBeUndefined();
  });

  test("a read inside its deadline is not timed out", async () => {
    vi.useFakeTimers();
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a"), options: { deadline: 5_000 } });
    await act(async () => reads.calls[0]?.resolve("in time"));
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(probe.last()).toMatchObject({ value: "in time", failure: null });
  });

  test("a once-per-key read makes one request under StrictMode, and still answers", async () => {
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a"), options: { once: true } }, true);
    expect(reads.calls).toHaveLength(1);
    expect(reads.calls[0]?.signal.aborted).toBe(false);
    await act(async () => reads.calls[0]?.resolve("answered"));
    expect(probe.last().value).toBe("answered");
  });

  test("a once-per-key read reads again for a new key, and aborts on unmount", async () => {
    vi.useFakeTimers();
    const reads = deferredReads<string>();
    const probe = mount({ key: "a", read: reads.read("a"), options: { once: true } }, true);
    probe.rerender({ key: "b", read: reads.read("b") });
    expect(reads.calls.map((call) => call.key)).toEqual(["a", "b"]);
    act(() => root?.unmount());
    root = null;
    await act(async () => {
      vi.runAllTimers();
    });
    expect(reads.calls[1]?.signal.aborted).toBe(true);
  });

  test("without once, StrictMode's second pass aborts the first read and makes a second", () => {
    const reads = deferredReads<string>();
    mount({ key: "a", read: reads.read("a") }, true);
    expect(reads.calls).toHaveLength(2);
    expect(reads.calls[0]?.signal.aborted).toBe(true);
    expect(reads.calls[1]?.signal.aborted).toBe(false);
  });
});
