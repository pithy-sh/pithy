// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";

/** What {@link useAction} gives a screen. */
export interface Action<A extends unknown[], T> {
  /** Make the call. Resolves to its result, or `undefined` when it failed or was aborted. Never rejects. */
  readonly run: (...args: A) => Promise<T | undefined>;
  /** Whether a call is in flight. */
  readonly pending: boolean;
  /** Why the last call failed, or null. Cleared when the next one starts. */
  readonly failure: Error | null;
  /** The last call's result, kept through a later call that fails. `undefined` until one succeeds. */
  readonly value: T | undefined;
}

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/**
 * Run a call a person triggers — a purchase, a sign-out, a revoke — and keep its state.
 *
 * The call is handed an `AbortSignal` that aborts when a newer `run` starts or the component unmounts, and nothing
 * is set after either. `run` is stable, so it can be passed down without memoizing anything.
 */
export function useAction<A extends unknown[], T>(call: (signal: AbortSignal, ...args: A) => Promise<T>): Action<A, T> {
  const latest = useRef(call);
  latest.current = call;
  const inFlight = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ pending: boolean; failure: Error | null; value: T | undefined }>({
    pending: false,
    failure: null,
    value: undefined,
  });

  useEffect(
    () => () => {
      inFlight.current?.abort();
    },
    [],
  );

  const run = useCallback(async (...args: A): Promise<T | undefined> => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setState((now) => ({ ...now, pending: true, failure: null }));
    try {
      const value = await latest.current(controller.signal, ...args);
      if (controller.signal.aborted) return undefined;
      setState({ pending: false, failure: null, value });
      return value;
    } catch (thrown) {
      if (controller.signal.aborted) return undefined;
      setState((now) => ({ ...now, pending: false, failure: asError(thrown) }));
      return undefined;
    }
  }, []);

  return { run, pending: state.pending, failure: state.failure, value: state.value };
}
