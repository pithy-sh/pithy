// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **What a dev session is doing, as events rather than as sentences.**
 *
 * `pithy dev` already knows every fact a live roster needs — which workers started, on which ports,
 * which have matched their ready signal, which has exited, who the seed can sign in as. It says each of
 * them exactly once, as a line, and that is the right thing for a log file and for a piped consumer: the
 * stream is the session's history and the session logs replay it, worker by worker.
 *
 * It is the wrong thing for a reader who wants to know *the state the session is in right now*, which is
 * not a line anywhere — it is the fold of every line so far, and by the time a developer wants it the
 * lines have scrolled. `readyWatch`'s `Still waiting on:` line exists because of exactly that, and
 * answers it one deadline at a time.
 *
 * So the orchestrator raises these as well, and **the prose stays**. This is a second consumer of the
 * same facts, never a replacement for the first: a sink that hears nothing is the ordinary case, and
 * under `--json` there is no sink at all.
 *
 * The shape follows `terminal/progress.ts` — a producer raises, the sink decides whether anyone is
 * listening — with one deliberate difference. `progress.ts` is ambient (`AsyncLocalStorage`) because its
 * producers sit inside capability packages that have no business carrying a terminal concern. Here the
 * producer *is* the orchestrator and the consumer is chosen one function up, in `commands/dev.ts`, so
 * the sink is an ordinary option and there is no ambient state to reason about.
 */

/** One thing that happened to a dev session. */
export type DevEvent =
  /**
   * The whole dev set, before anything spawns — including the workers this branch has parked.
   *
   * A parked worker is never spawned, so no other event mentions it, and the roster used to have no row
   * for it at all. `pithy dev --list` has always marked one `skipped  off here`, and the footer is the
   * better place for that: it is the row you would press `r` on to start it.
   */
  | {
      event: "roster";
      members: readonly {
        worker: string;
        kind: "app" | "host";
        port: number;
        starts: boolean;
        /**
         * Whether this branch starts it, on this machine — `dev-ports.json`, never committed.
         *
         * `true` is the default and the common case: absence in that file means a worker starts, and
         * there is no state where the file's silence has to be interpreted (#549).
         */
        autostart: boolean;
      }[];
      at: Date;
    }
  /** A worker's child process has been spawned. A second one for a name already present is a restart. */
  | {
      event: "spawned";
      worker: string;
      /** An `apps/` Worker, or a capability's host Worker. */
      kind: "app" | "host";
      /** The port it was pinned to in `.dev.config.json`, verified free before it started. */
      port: number;
      at: Date;
    }
  /** That worker matched its `dev.readySignal`. */
  | { event: "ready"; worker: string; at: Date }
  /**
   * That worker's child exited. `null` is the code a signaled child reports.
   *
   * `expected` is whether *we* caused it — a teardown, or a restart. Required rather than optional
   * because the raise site always knows, and a default would quietly make every exit look like a
   * failure again: hiding worker output is only honest if a crash reveals itself, and only usable if a
   * `q` does not reveal all five at once.
   */
  | { event: "exited"; worker: string; code: number | null; expected: boolean }
  /**
   * A worker's autostart answer changed — this branch will, or will not, start it next time.
   *
   * Separate from `roster`, which is raised once before anything spawns: this is somebody pressing `a`
   * mid-session. It changes **what the next run does**, never what this one is doing.
   */
  | { event: "autostart"; worker: string; autostart: boolean }
  /** The workers that have started and not become ready, as `readyWatch` reports them. */
  | { event: "waiting"; workers: readonly string[] }
  /**
   * What this session can sign in as — **a count, and a name only when there is just one.**
   *
   * It used to carry the first identity's email whatever the number, which read as *this is who you
   * are* on a project seeding 29 of them: arbitrary, and wrong, since `l` opens a picker. The email
   * alone and never a claim, as the banner has been since `#667`.
   */
  | { event: "login"; email: string | null; count: number }
  /** Every started worker has become ready. */
  | { event: "session-ready" };

/**
 * Where a session's events go, or nowhere.
 *
 * **Synchronous and returning nothing**, for the reason `Progress` is: it feeds a terminal, and a sink
 * that could block or reject would put the console in the failure path of supervising Workers.
 */
export type DevEvents = (event: DevEvent) => void;
