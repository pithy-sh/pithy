// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";

/** The failure a read lands in when nothing answered it before its deadline. */
export class ReadTimeout extends Error {
  override readonly name = "ReadTimeout";

  constructor(readonly deadline: number) {
    super(`No answer within ${deadline} ms.`);
  }
}

/** How {@link useRead} runs a read. */
export interface ReadOptions {
  /** Make no request while this is true. The read runs as soon as it turns false. */
  readonly skip?: boolean | undefined;
  /** Milliseconds to wait for an answer. Past it the read is aborted and lands in `failure` as a {@link ReadTimeout}. */
  readonly deadline?: number | undefined;
  /**
   * Run the read at most once per key for the life of the component, StrictMode's second effect pass included.
   * For a read that costs something to make: a quote, a row in somebody's audit trail. `refresh` still runs it again.
   */
  readonly once?: boolean | undefined;
}

/** What {@link useRead} gives a screen. */
export interface Read<T> {
  /**
   * The last answer, kept while a newer read is in flight and after a failed one. `undefined` until one lands.
   * While `loading` it may answer an earlier key, so a screen that must not act on another key's answer checks
   * `loading` first.
   */
  readonly value: T | undefined;
  /**
   * Whether a read is in flight. True on the first render of a read that is not skipped, and on the first render
   * after the key changes, `refresh` runs or `skip` turns false, before any effect has run.
   */
  readonly loading: boolean;
  /** Why the read for the current key last failed, or null. Cleared by the next answer and by a new key. */
  readonly failure: Error | null;
  /** Run the read again. */
  readonly refresh: () => void;
}

type Outcome<T> = { kind: "value"; value: T } | { kind: "failure"; failure: Error } | { kind: "aborted" };

interface Flight<T> {
  readonly id: string;
  readonly controller: AbortController;
  readonly outcome: Promise<Outcome<T>>;
  /** A pending abort of a once-per-key flight, which the effect's next pass with the same key cancels. */
  release: ReturnType<typeof setTimeout> | undefined;
}

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

function abortOutcome<T>(signal: AbortSignal): Outcome<T> {
  return signal.reason instanceof ReadTimeout ? { kind: "failure", failure: signal.reason } : { kind: "aborted" };
}

/** Run one read under `signal`, settling the moment the signal aborts whether or not the read listens to it. */
function fly<T>(read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<Outcome<T>> {
  const aborted = new Promise<Outcome<T>>((resolve) => {
    signal.addEventListener("abort", () => resolve(abortOutcome(signal)), { once: true });
  });
  const answered = (async (): Promise<Outcome<T>> => {
    try {
      const value = await read(signal);
      return signal.aborted ? abortOutcome(signal) : { kind: "value", value };
    } catch (thrown) {
      return signal.aborted ? abortOutcome(signal) : { kind: "failure", failure: asError(thrown) };
    }
  })();
  return Promise.race([answered, aborted]);
}

/**
 * Run an async read for a screen, and keep only the answer to the question still being asked.
 *
 * `key` names the request: a new key supersedes the read in flight, and the same key on a re-render reads nothing
 * again, so `read` may be written inline. The read is handed an `AbortSignal` that aborts when a newer read
 * supersedes it or the component unmounts, and an answer that arrives anyway is discarded. A read that throws lands
 * in `failure`; an aborted one lands nowhere.
 */
export function useRead<T>(key: string, read: (signal: AbortSignal) => Promise<T>, options: ReadOptions = {}): Read<T> {
  const skip = options.skip ?? false;
  const deadline = options.deadline;
  const once = options.once ?? false;
  const latest = useRef(read);
  latest.current = read;
  const flight = useRef<Flight<T> | null>(null);
  const [round, setRound] = useState(0);
  const id = `${round}:${key}`;
  // `id` is the request the state answers for, so a render that asks a new question reads as loading before the
  // effect that starts it has run.
  const [state, setState] = useState<{
    id: string | null;
    value: T | undefined;
    loading: boolean;
    failure: Error | null;
  }>(() => ({ id: null, value: undefined, loading: false, failure: null }));

  useEffect(() => {
    if (skip) {
      setState((now) => (now.loading ? { ...now, loading: false } : now));
      return;
    }
    let mine = flight.current;
    if (once && mine?.id === id && !mine.controller.signal.aborted) {
      clearTimeout(mine.release);
      mine.release = undefined;
    } else {
      const controller = new AbortController();
      const timer =
        deadline === undefined ? undefined : setTimeout(() => controller.abort(new ReadTimeout(deadline)), deadline);
      const outcome = fly(latest.current, controller.signal).finally(() => clearTimeout(timer));
      mine = { id, controller, outcome, release: undefined };
      flight.current = mine;
    }
    const current = mine;
    let live = true;
    setState((now) =>
      now.id === id && now.loading ? now : { ...now, id, loading: true, failure: now.id === id ? now.failure : null },
    );
    void current.outcome.then((outcome) => {
      if (!live || outcome.kind === "aborted") return;
      if (outcome.kind === "value") setState({ id, value: outcome.value, loading: false, failure: null });
      else setState((now) => ({ id, value: now.value, loading: false, failure: outcome.failure }));
    });
    return () => {
      live = false;
      if (once) current.release = setTimeout(() => current.controller.abort(), 0);
      else current.controller.abort();
    };
  }, [id, skip, deadline, once]);

  const refresh = useCallback(() => setRound((now) => now + 1), []);
  const answers = state.id === id;

  return {
    value: state.value,
    loading: !skip && (!answers || state.loading),
    failure: answers ? state.failure : null,
    refresh,
  };
}
