// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dim } from "../terminal/style";

/**
 * How long a worker gets to match its ready signal before `pithy dev` names it (pithy-sh/pithy#429).
 *
 * Generous on purpose. The first `wrangler dev` of a session pays for a cold bundle, and a slow worker is
 * not a broken one — a deadline that cries wolf teaches a developer to scroll past the one line that was
 * ever going to reach them. The value below is longer than any healthy cold start we have measured and
 * still short enough to arrive while the session is being watched.
 *
 * **It is measured from the spawn, not from the command.** The watch starts after the last child is
 * running, so none of what `pithy dev` does first — `.dev.vars`, the host configs, stopping the previous
 * session, the orphan sweep, both loopback families of every pinned port, the dev secrets — is on this
 * clock. On a cold project that is tens of seconds, and charging it to a worker would make the budget a
 * worker actually gets vary with how much housekeeping the run happened to need.
 *
 * `docs/commands/dev.md` states it in seconds, and says what it is measured from, in both places it
 * appears; `readyWatchDocs.test.ts` pins both sentences to this constant.
 */
export const READY_DEADLINE_MS = 90_000;

/**
 * How often the still-waiting report repeats while at least one worker has not arrived.
 *
 * A single line at the deadline scrolls away exactly like the build error did — the other workers keep
 * printing. Repeating is what makes it findable, and the value below is often enough to stay in view
 * without becoming the noise it is trying to cut through.
 */
export const READY_REMINDER_MS = 30_000;

/**
 * Schedule `run` after `ms`; the returned function cancels it. The timer seam — real `setTimeout` in
 * production, a hand-driven clock in tests, so nothing here waits ninety real seconds to be proven.
 */
export type Schedule = (ms: number, run: () => void) => () => void;

/** The real timer. Unreferenced: the supervisor's lifetime is its children's, never a pending report's. */
export const scheduleTimeout: Schedule = (ms, run) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/**
 * The report rendered for a person: who has not arrived, by name.
 *
 * *Still waiting* rather than *failed*, because the orchestrator does not know which it is — a worker
 * this line names may be one bundle away from the banner. The reason it had to be a deadline that told
 * you is said once, with the first report; the repeats are the short line alone.
 *
 * **The action line names the mechanism, never a cause.** It used to say `wrangler dev keeps running
 * after a build error`, which is true of the case that prompted #429 and of nothing else the same
 * deadline catches: a startup that hangs, a port that never binds, a binding that never resolves, and a
 * `dev.command` worker — a Vite front end — where wrangler is not in the picture at all. What every one
 * of them shares is the property that made the session look healthy: the child is *alive*, so no exit
 * handler fires and nothing else in the run was ever going to mention it. That is what the line says,
 * and it points at the worker's own output for the reason, which is the only place the reason exists.
 *
 * It names a restart because for the case that prompted this, a restart is not optional: a `wrangler dev`
 * whose **first** build fails prints the error, keeps running, and does not rebuild when the file is fixed
 * — measured against wrangler 4.123 on a Worker with an unresolvable import. Editing the file and waiting
 * is the thing a developer would otherwise try, and it is the one thing that cannot work.
 */
export function stillWaitingLines(waiting: readonly string[], first: boolean): string[] {
  const line = `Still waiting on: ${waiting.join(", ")}.`;
  if (!first) return [line];
  return [
    line,
    dim("  A worker that never becomes ready keeps running, so nothing else reports it."),
    dim("  Each one's own output above says why. Fix it and run pithy dev again."),
  ];
}

/** What {@link watchReady} needs: the set that has not arrived, somewhere to say it, and a clock. */
export interface ReadyWatchOptions {
  /** The workers yet to match their ready signal, in start order. Read afresh at every tick. */
  pending: () => readonly string[];
  /**
   * Say it. Handed the set rather than a rendered line, because the two audiences render it differently:
   * a person gets {@link stillWaitingLines}, and an agent driving `pithy dev --json` gets a record it can
   * read. A seam that emitted prose would have made the machine-readable half unbuildable without parsing
   * our own sentence back out of it.
   *
   * `first` is true for the report at the deadline and false for every repeat.
   */
  report: (waiting: readonly string[], first: boolean) => void;
  /** Timer seam (default {@link scheduleTimeout}). */
  schedule?: Schedule;
  /** How long before the first report (default {@link READY_DEADLINE_MS}). */
  deadlineMs?: number;
  /** How long between repeats while the set stays non-empty (default {@link READY_REMINDER_MS}). */
  reminderMs?: number;
}

/** A running watch. `stop()` cancels the pending timer and is safe to call more than once. */
export interface ReadyWatch {
  stop: () => void;
}

/**
 * Watch for the workers that start and never become ready, and name them.
 *
 * `wrangler dev` does not exit when a build fails — it prints the error and keeps running — so a broken
 * worker is a live child that never matches its ready signal. The banner waits on the whole set, so it
 * never fires, and until this the session simply proceeded looking healthy with the error forty lines up
 * the scrollback. This is the deadline that names it, and keeps naming it while it stays true.
 *
 * The set is read at every tick rather than captured, so a worker that arrives late drops out of the next
 * report on its own. An empty set ends the watch: everything arrived, and the banner says the rest.
 */
export function watchReady(options: ReadyWatchOptions): ReadyWatch {
  const schedule = options.schedule ?? scheduleTimeout;
  const deadlineMs = options.deadlineMs ?? READY_DEADLINE_MS;
  const reminderMs = options.reminderMs ?? READY_REMINDER_MS;

  let cancel: (() => void) | null = null;
  let stopped = false;
  let reported = false;

  const tick = () => {
    cancel = null;
    if (stopped) return;
    const waiting = options.pending();
    if (waiting.length === 0) return;
    options.report(waiting, !reported);
    reported = true;
    cancel = schedule(reminderMs, tick);
  };

  cancel = schedule(deadlineMs, tick);

  return {
    stop: () => {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
}
