// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DevEvent } from "../events";
import { filterIdentities, type PickerIdentity } from "./picker";
import { emptySession, reduceSession, type SessionState } from "./session";

/**
 * One line of the session's output, already committed.
 *
 * It carries an `id` because `<Static>` keys on identity and two identical log lines are two lines — a
 * stream is not a set, and `GET /health 200` arriving twice must print twice.
 */
export interface CommittedLine {
  id: number;
  text: string;
}

export interface DevTuiState {
  /** Everything committed to the stream, in order. Append-only: nothing here is ever rewritten. */
  lines: readonly CommittedLine[];
  session: SessionState;
  /** The workers whose output is landing, in reveal order. Empty is the quiet default. */
  revealed: readonly string[];
  /** Whether every worker's output is landing. */
  showingAll: boolean;
  /** Which roster row the verbs act on. */
  selected: number;
  /**
   * The identity picker, while `l` has one open — and `null` the rest of the time.
   *
   * It replaces the roster rather than sitting beside it: the question is *who*, the roster answers
   * *what is running*, and a session with 29 seeded users needs the whole pane to answer the first one.
   */
  picker: { identities: readonly PickerIdentity[]; selected: number; worker?: string; query: string } | null;
}

/**
 * How much of a hidden worker's output is kept to replay when it is revealed.
 *
 * Revealing forward-only would answer a question about an idle worker with nothing at all, which makes
 * the key useless exactly when you need it. Bounded because the other failure is worse: an hour of a
 * chatty Vite server dumped into the terminal at one keystroke.
 */
export const HIDDEN_TAIL = 200;

/**
 * **What the renderer is looking at, driven from outside React.**
 *
 * The supervisor pushes; the component subscribes. A plain store rather than component state because the
 * two pieces of behavior worth getting right — forward-only focus filtering, and a selection that
 * clamps — are then testable without rendering anything, and because the supervisor has no business
 * holding a React ref.
 */
export function createDevStore() {
  /**
   * **The committed array is replaced on every append, and that is not an oversight.**
   *
   * `<Static>` memoizes the slice it is about to render on `[items, index]`, and bumps `index` to
   * `items.length` from a layout effect keyed on that length. Appending to *one* array therefore loses
   * the new lines outright: the effect moves `index` to the new length first, and the memo then slices
   * from there and finds nothing. It was tried — the footer rendered and not one log line did.
   *
   * So a fresh identity is the contract, not a wasted copy. What was actually costing a chatty session
   * its responsiveness was one React render per line, which `set` now coalesces.
   */
  let state: DevTuiState = {
    lines: [],
    session: emptySession,
    revealed: [],
    showingAll: false,
    selected: 0,
    picker: null,
  };
  const listeners = new Set<() => void>();
  let nextId = 0;
  /** Each hidden worker's recent output, kept so revealing it can show what it already said. */
  const buffered = new Map<string, string[]>();

  /**
   * Publish a new snapshot and wake the renderer — **once per tick, not once per line.**
   *
   * A chatty worker arrives in bursts, and a render per line turns one frame's worth of output into
   * hundreds of reconciles. The snapshot is updated synchronously so a read is never stale; only the
   * notification is coalesced onto a microtask.
   */
  let waking = false;
  const set = (next: DevTuiState) => {
    state = next;
    if (waking) return;
    waking = true;
    void Promise.resolve().then(() => {
      waking = false;
      for (const listener of listeners) listener();
    });
  };

  /**
   * Reveal one worker, committing whatever it said while hidden.
   *
   * Pure over the state it is handed so `event` can reveal several workers in one update rather than
   * notifying subscribers once per name.
   */
  const revealInto = (current: DevTuiState, worker: string): DevTuiState => {
    const tail = buffered.get(worker);
    // Cleared as it is replayed, so revealing twice does not print it twice.
    buffered.delete(worker);
    const lines = tail ? [...current.lines, ...tail.map((text) => ({ id: nextId++, text }))] : current.lines;
    const revealed = current.revealed.includes(worker) ? current.revealed : [...current.revealed, worker];
    return { ...current, lines, revealed };
  };

  /** Keep the marker on a real row: clamped, never wrapped, and never past the end of a shrinking roster. */
  const clamp = (index: number, count: number) => (count === 0 ? 0 : Math.max(0, Math.min(index, count - 1)));

  return {
    state: () => state,

    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },

    /**
     * Commit one line to the stream, or hold it back.
     *
     * `origin` is the worker it came from, and the supervisor knows it at the call site — so this filters
     * on a value rather than on a parse of the `[name]` prefix, which is already colorized and would have
     * to be un-ANSI'd to read.
     *
     * **A line with no origin always lands.** That is the session's own narration — `Starting api, web.`,
     * a `.dev.vars` refusal, the delivery verdict, the ready banner, `Still waiting on: support.`, and
     * `Which identity? Press 1-9.` — and a developer who quietened the workers did not ask to stop
     * hearing from the supervisor. It is also the half that would have made hiding output unusable: the
     * identity list is prose, and losing it would have broken `l`.
     */
    line: (text: string, origin?: string) => {
      if (origin === undefined || state.showingAll || state.revealed.includes(origin)) {
        set({ ...state, lines: [...state.lines, { id: nextId++, text }] });
        return;
      }
      const tail = buffered.get(origin) ?? [];
      tail.push(text);
      // Dropped from the front, so what is kept is the most recent — which is what a reveal is for.
      if (tail.length > HIDDEN_TAIL) tail.splice(0, tail.length - HIDDEN_TAIL);
      buffered.set(origin, tail);
    },

    event: (event: DevEvent) => {
      const session = reduceSession(state.session, event);
      let next = { ...state, session, selected: clamp(state.selected, session.workers.length) };
      // **A worker in trouble reveals itself.** Hiding output by default must not bury the one thing
      // anybody came for: `docs/commands/dev.md` is explicit that the real error forty lines up the
      // scrollback is the defect, and a hidden worker would make that worse rather than better. An exit
      // is one signal; the ready deadline is the other, and it is the one that catches a `wrangler dev`
      // whose first build failed — which prints its error and then keeps running forever.
      const trouble =
        event.event === "exited" && !event.expected ? [event.worker] : event.event === "waiting" ? event.workers : [];
      for (const worker of trouble) next = revealInto(next, worker);
      set(next);
    },

    /** Show this worker's output, replaying the tail it produced while hidden. */
    reveal: (worker: string) => set(revealInto(state, worker)),

    /** Stop showing it. What already printed stays printed — `<Static>` wrote it to the terminal once. */
    hide: (worker: string) =>
      set({ ...state, revealed: state.revealed.filter((name) => name !== worker), showingAll: false }),

    /** Every worker's output, or back to the quiet default. */
    showAll: (on: boolean) => {
      if (!on) {
        set({ ...state, revealed: [], showingAll: false });
        return;
      }
      let next: DevTuiState = { ...state, showingAll: true };
      /**
       * **Every worker that is running, plus anything that has already said something.**
       *
       * Not every row: a worker this branch parked produces no output this run, so revealing it marked
       * its name as though its logs were showing and gave the roster a color to paint for nothing. A
       * buffered worker is included whatever its status, because a line can reach the store before the
       * event that gives it a row, and a buffer nothing replays is output thrown away.
       */
      const running = state.session.workers.filter((w) => w.status !== "skipped").map((w) => w.name);
      for (const worker of [...buffered.keys(), ...running]) next = revealInto(next, worker);
      set(next);
    },

    move: (delta: number) => set({ ...state, selected: clamp(state.selected + delta, state.session.workers.length) }),

    /** Open the picker over the roster, remembering which worker `l` was pressed on. */
    openPicker: (identities: readonly PickerIdentity[], worker?: string) =>
      set({
        ...state,
        picker: { identities, selected: 0, query: "", ...(worker === undefined ? {} : { worker }) },
      }),

    /**
     * Move the picker's marker, clamped — "down" at the bottom honestly means staying there.
     *
     * Clamped against the **matches**, not the whole list: with a query narrowing 29 to 2, a marker
     * anywhere past the second row would point at nothing.
     */
    movePicker: (delta: number) => {
      const picker = state.picker;
      if (!picker) return;
      const matches = filterIdentities(picker.identities, picker.query).length;
      set({ ...state, picker: { ...picker, selected: clamp(picker.selected + delta, matches) } });
    },

    /**
     * Append a character to the query.
     *
     * **Typing filters, and that is why digits no longer jump.** The rows were numbered by their place
     * in the whole list, so while the window showed 8-17 the bar's `1-9 jump` pointed at rows that were
     * not on screen — and an email contains digits (`user12@…`), so a typed `1` cannot mean both. The
     * selection resets to the top, because the list under it just changed.
     */
    typePicker: (character: string) => {
      const picker = state.picker;
      if (!picker) return;
      set({ ...state, picker: { ...picker, query: picker.query + character, selected: 0 } });
    },

    /** Remove the last character of the query. */
    backspacePicker: () => {
      const picker = state.picker;
      if (!picker || picker.query === "") return;
      set({ ...state, picker: { ...picker, query: picker.query.slice(0, -1), selected: 0 } });
    },

    /** Drop the query, keeping the picker open. What `esc` does first, before it closes anything. */
    clearPickerQuery: () => {
      const picker = state.picker;
      if (!picker) return;
      set({ ...state, picker: { ...picker, query: "", selected: 0 } });
    },

    /** Put the roster back. */
    closePicker: () => set({ ...state, picker: null }),

    /**
     * What Enter would act on, or `null` when nothing is open.
     *
     * Resolved against the **same filtered list the view draws**. If the two disagreed about what
     * matches, Enter would sign you in as whoever occupied that row in the other list — which is the
     * worst possible way for a filter bug to show up.
     */
    pickerChoice: (): { identity: PickerIdentity; worker?: string } | null => {
      const picker = state.picker;
      const identity = picker ? filterIdentities(picker.identities, picker.query)[picker.selected] : undefined;
      if (!picker || !identity) return null;
      return { identity, ...(picker.worker === undefined ? {} : { worker: picker.worker }) };
    },

    /** The worker a verb acts on, or `null` when there is no roster yet. */
    selectedWorker: (): string | null => state.session.workers[state.selected]?.name ?? null,
  };
}

/** The store, as the component and the supervisor both see it. */
export type DevStore = ReturnType<typeof createDevStore>;
