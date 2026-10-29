// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { type Action, useAction } from "./action";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

/** A call the test answers by hand, recording the signal and arguments of each run. */
function deferredCalls() {
  const calls: {
    args: string[];
    signal: AbortSignal;
    resolve: (value: string) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const call = (signal: AbortSignal, ...args: string[]) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ args, signal, resolve, reject });
    });
  return { calls, call };
}

function mount(call: (signal: AbortSignal, ...args: string[]) => Promise<string>) {
  const seen: Action<string[], string>[] = [];
  function Probe() {
    seen.push(useAction(call));
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root?.render(<Probe />));
  return { seen, last: () => seen[seen.length - 1] as Action<string[], string> };
}

describe("useAction", () => {
  test("is idle until run", () => {
    const calls = deferredCalls();
    const probe = mount(calls.call);
    expect(calls.calls).toHaveLength(0);
    expect(probe.last()).toMatchObject({ pending: false, failure: null, value: undefined });
  });

  test("run sets pending, and then the result", async () => {
    const calls = deferredCalls();
    const probe = mount(calls.call);
    let result: Promise<string | undefined> = Promise.resolve(undefined);
    act(() => {
      result = probe.last().run("pro");
    });
    expect(probe.last().pending).toBe(true);
    expect(calls.calls[0]?.args).toEqual(["pro"]);
    await act(async () => calls.calls[0]?.resolve("bought"));
    expect(probe.last()).toMatchObject({ pending: false, failure: null, value: "bought" });
    expect(await result).toBe("bought");
  });

  test("run sets pending, and then the failure, without throwing", async () => {
    const calls = deferredCalls();
    const probe = mount(calls.call);
    let result: Promise<string | undefined> = Promise.resolve(undefined);
    act(() => {
      result = probe.last().run();
    });
    await act(async () => calls.calls[0]?.reject(new Error("refused")));
    expect(probe.last().pending).toBe(false);
    expect(probe.last().failure?.message).toBe("refused");
    expect(await result).toBeUndefined();
  });

  test("a new run clears the last failure and keeps the last value", async () => {
    const calls = deferredCalls();
    const probe = mount(calls.call);
    act(() => void probe.last().run());
    await act(async () => calls.calls[0]?.resolve("first"));
    act(() => void probe.last().run());
    await act(async () => calls.calls[1]?.reject(new Error("refused")));
    act(() => void probe.last().run());
    expect(probe.last()).toMatchObject({ pending: true, failure: null, value: "first" });
  });

  test("unmount mid-call aborts it and sets no state", async () => {
    const calls = deferredCalls();
    const probe = mount(calls.call);
    act(() => void probe.last().run());
    const renders = probe.seen.length;
    act(() => root?.unmount());
    root = null;
    expect(calls.calls[0]?.signal.aborted).toBe(true);
    await act(async () => calls.calls[0]?.resolve("too late"));
    expect(probe.seen.length).toBe(renders);
  });

  test("a newer run aborts the older one, whose answer is discarded", async () => {
    const calls = deferredCalls();
    const probe = mount(calls.call);
    let older: Promise<string | undefined> = Promise.resolve(undefined);
    act(() => {
      older = probe.last().run("a");
    });
    act(() => void probe.last().run("b"));
    expect(calls.calls[0]?.signal.aborted).toBe(true);
    await act(async () => calls.calls[1]?.resolve("b done"));
    await act(async () => calls.calls[0]?.resolve("a done"));
    expect(probe.last().value).toBe("b done");
    expect(await older).toBeUndefined();
  });

  test("run is the same function on every render", async () => {
    const calls = deferredCalls();
    const probe = mount(calls.call);
    act(() => void probe.last().run());
    await act(async () => calls.calls[0]?.resolve("x"));
    expect(new Set(probe.seen.map((seen) => seen.run)).size).toBe(1);
  });
});
