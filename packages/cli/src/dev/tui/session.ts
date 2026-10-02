// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DevEvent } from "../events";

/**
 * One worker's row on the live roster — the fold of every event about it so far.
 *
 * `status` is what the row *says*; the three optional fields are what it says *with*. They are optional
 * rather than defaulted because absent and zero are different facts: a worker with no `readyMs` has not
 * arrived, and one with `exitCode: null` exited on a signal.
 */
export interface WorkerRow {
  name: string;
  /** An `apps/` Worker, or a capability's host Worker. */
  kind: "app" | "host";
  port: number;
  /**
   * When this run of the worker started — reset by a restart, which is why elapsed is honest after one.
   *
   * **Absent until it has actually spawned.** A row seeded from the dev set has no start time, and
   * inventing one made the roster report elapsed since the epoch — a parked worker showed `1514477m12s`.
   * Absent and zero are different facts here, which is why this is optional rather than defaulted.
   */
  spawnedAt?: Date;
  /**
   * `skipped` is a worker this branch has parked — discovered, pinned to a port, and deliberately not
   * started (`pithy dev --app <name> --disable-autostart`). It is not a failure and not a delay.
   */
  status: "building" | "ready" | "waiting" | "exited" | "skipped";
  /** How long it took to match its ready signal. Time-to-ready, not uptime. */
  readyMs?: number;
  /** Its exit code, once gone. `null` from a signaled child. */
  exitCode?: number | null;
  /**
   * Whether this branch starts it next time — `dev-ports.json`'s answer, defaulting to `true`.
   *
   * Distinct from `status: "skipped"`, which is about *this* run. A worker can be running with autostart
   * off — you pressed `a` on it a moment ago — and the roster has to say both, because the two facts
   * genuinely disagree until the next run.
   */
  autostart?: boolean;
}

/** Everything the footer renders, and nothing else. */
export interface SessionState {
  /** In start order, which is the order the roster lists them. */
  workers: readonly WorkerRow[];
  /** What `l` can sign in as: how many identities are seeded, and the one email when there is one. */
  login: { count: number; email: string | null };
  /** Whether every started worker has arrived. The footer stops ticking once this is true. */
  sessionReady: boolean;
}

export const emptySession: SessionState = { workers: [], login: { count: 0, email: null }, sessionReady: false };

/** Replace one worker's row, by name, leaving its position and every sibling alone. */
function mapWorker(state: SessionState, name: string, change: (row: WorkerRow) => WorkerRow | undefined): SessionState {
  let changed = false;
  const workers = state.workers.map((row) => {
    if (row.name !== name) return row;
    const next = change(row);
    if (next === undefined) return row;
    changed = true;
    return next;
  });
  // An event naming a worker that never spawned is dropped rather than inventing a row: the roster lists
  // what this session started, and a name it does not hold is a fact about some other session.
  return changed ? { ...state, workers } : state;
}

/**
 * Fold one event into the session's state. Pure, and never mutates what it was handed.
 *
 * **`exited` is terminal until the worker is spawned again.** A child's streams flush after it is gone,
 * so a ready line can genuinely arrive after its exit — and treating that as an arrival would put a dead
 * worker back on the roster as healthy.
 */
export function reduceSession(state: SessionState, event: DevEvent): SessionState {
  switch (event.event) {
    case "roster":
      // Seeded in the set's own order, which is what the roster lists in. A `spawned` for any of these
      // replaces its row in place, so starting a parked worker never reorders the table.
      return {
        ...state,
        workers: event.members.map((member) => ({
          name: member.worker,
          kind: member.kind,
          port: member.port,
          status: member.starts ? ("building" as const) : ("skipped" as const),
          autostart: member.autostart,
        })),
      };
    case "spawned": {
      const row: WorkerRow = {
        name: event.worker,
        kind: event.kind,
        port: event.port,
        spawnedAt: event.at,
        status: "building",
      };
      // A second spawn of a name already on the roster is a restart, so it takes that row's place. An
      // append would leave the dead run listed and move every worker below it down a line.
      const existing = state.workers.findIndex((w) => w.name === event.worker);
      if (existing === -1) return { ...state, workers: [...state.workers, row] };
      const workers = [...state.workers];
      // The autostart answer is carried across: it is a fact about the branch, not about this run of the
      // child, so a restart must not quietly forget it.
      workers[existing] = { ...row, autostart: workers[existing]?.autostart };
      return { ...state, workers };
    }
    case "ready":
      return mapWorker(state, event.worker, (row) =>
        row.status === "exited"
          ? undefined
          : {
              ...row,
              status: "ready",
              // No spawn time means nothing timed this run — a ready without a spawn, which the orderings
              // above make unreachable but which must not render as a quarter-century either way.
              ...(row.spawnedAt ? { readyMs: event.at.getTime() - row.spawnedAt.getTime() } : {}),
            },
      );
    case "exited":
      return mapWorker(state, event.worker, (row) => ({ ...row, status: "exited", exitCode: event.code }));
    case "waiting": {
      // Only a worker that is still building becomes `waiting`. The report is read afresh at every
      // deadline, so a worker that has since arrived is simply absent from it — it is never a demotion.
      const late = new Set(event.workers);
      return {
        ...state,
        // Only a worker that is still building becomes `waiting`. A parked one never started, so it is
        // not late — it is off, and the deadline has nothing to say about it.
        workers: state.workers.map((row) =>
          late.has(row.name) && row.status === "building" ? { ...row, status: "waiting" } : row,
        ),
      };
    }
    case "autostart":
      // Only the flag. A worker whose autostart is turned off keeps running — `a` changes what the next
      // run does, and saying otherwise on the row would be a lie about the session in front of you.
      return mapWorker(state, event.worker, (row) => ({ ...row, autostart: event.autostart }));
    case "login":
      return { ...state, login: { count: event.count, email: event.email } };
    case "session-ready":
      return { ...state, sessionReady: true };
  }
}
