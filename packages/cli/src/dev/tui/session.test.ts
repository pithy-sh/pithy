// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { DevEvent } from "../events";
import { emptySession, reduceSession } from "./session";

/**
 * **The footer's whole model: a session is what its events say it is.**
 *
 * The orchestrator already holds every fact the roster shows — `readyState`, the port block, the member
 * list — and says each of them once, as prose. The reducer is where those facts become a *state* rather
 * than a sentence, and it is deliberately the only place that decides what a worker's row means: the Ink
 * component renders what this returns and nothing else, so every rule below is testable without a
 * terminal.
 */

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

/** Fold a run of events, the way the component folds them. */
const run = (...events: readonly DevEvent[]) => events.reduce(reduceSession, emptySession);

const spawned = (name: string, overrides: Partial<Extract<DevEvent, { event: "spawned" }>> = {}): DevEvent => ({
  event: "spawned",
  worker: name,
  kind: "app",
  port: 8787,
  at: at(0),
  ...overrides,
});

describe("reduceSession", () => {
  test("an unstarted session has no workers", () => {
    expect(emptySession.workers).toEqual([]);
  });

  test("spawned workers keep the order they started in", () => {
    const state = run(spawned("api"), spawned("web", { port: 8788 }), spawned("email", { kind: "host", port: 8789 }));
    expect(state.workers.map((w) => w.name)).toEqual(["api", "web", "email"]);
    expect(state.workers.map((w) => w.port)).toEqual([8787, 8788, 8789]);
    expect(state.workers.map((w) => w.kind)).toEqual(["app", "app", "host"]);
  });

  test("a spawned worker is building until it is ready", () => {
    const state = run(spawned("api"));
    expect(state.workers[0]?.status).toBe("building");
  });

  test("ready records how long the worker took, not when it arrived", () => {
    const state = run(spawned("api", { at: at(0) }), { event: "ready", worker: "api", at: at(1900) });
    expect(state.workers[0]?.status).toBe("ready");
    expect(state.workers[0]?.readyMs).toBe(1900);
  });

  test("waiting marks only the workers that are still building", () => {
    const state = run(
      spawned("api"),
      spawned("support", { port: 8790 }),
      { event: "ready", worker: "api", at: at(1000) },
      { event: "waiting", workers: ["support"] },
    );
    expect(state.workers.map((w) => w.status)).toEqual(["ready", "waiting"]);
  });

  test("a worker that arrives late stops waiting and reports its own elapsed time", () => {
    const state = run(
      spawned("support", { at: at(0) }),
      { event: "waiting", workers: ["support"] },
      { event: "ready", worker: "support", at: at(134_000) },
    );
    expect(state.workers[0]?.status).toBe("ready");
    expect(state.workers[0]?.readyMs).toBe(134_000);
  });

  test("exited carries the code, including a null from a signal", () => {
    const state = run(spawned("payments"), { event: "exited", worker: "payments", code: 1, expected: false });
    expect(state.workers[0]?.status).toBe("exited");
    expect(state.workers[0]?.exitCode).toBe(1);

    const signaled = run(spawned("payments"), { event: "exited", worker: "payments", code: null, expected: false });
    expect(signaled.workers[0]?.exitCode).toBeNull();
  });

  test("a ready line that arrives after the worker exited does not revive it", () => {
    // A child's streams flush after it is gone, so this ordering is reachable rather than theoretical.
    const state = run(
      spawned("payments"),
      { event: "exited", worker: "payments", code: 1, expected: false },
      { event: "ready", worker: "payments", at: at(500) },
    );
    expect(state.workers[0]?.status).toBe("exited");
  });

  test("an event for a worker that never spawned invents no row", () => {
    const state = run(spawned("api"), { event: "ready", worker: "ghost", at: at(10) });
    expect(state.workers.map((w) => w.name)).toEqual(["api"]);
  });

  test("a restart replaces the worker in place rather than appending a second row", () => {
    // `r` respawns one worker on the same pinned port. Its row is the same row — appending would leave
    // the dead one on the roster and move every worker below it.
    const state = run(
      spawned("api"),
      spawned("web", { port: 8788 }),
      { event: "ready", worker: "api", at: at(1000) },
      { event: "exited", worker: "api", code: 1, expected: false },
      spawned("api", { at: at(5000) }),
    );
    expect(state.workers.map((w) => w.name)).toEqual(["api", "web"]);
    expect(state.workers[0]?.status).toBe("building");
    expect(state.workers[0]?.readyMs).toBeUndefined();
    expect(state.workers[0]?.exitCode).toBeUndefined();
    expect(state.workers[0]?.spawnedAt).toEqual(at(5000));
  });

  test("one seeded identity is named", () => {
    const state = run(spawned("api"), { event: "login", email: "ada@example.com", count: 1 });
    expect(state.login).toEqual({ count: 1, email: "ada@example.com" });
  });

  test("several are counted rather than one of them named", () => {
    // Naming the first of 29 read as *this is who you are*, which is arbitrary and untrue: `l` opens a
    // picker over all of them.
    const state = run(spawned("api"), { event: "login", email: null, count: 29 });
    expect(state.login).toEqual({ count: 29, email: null });
  });

  test("session-ready is recorded so the footer can stop ticking", () => {
    const before = run(spawned("api"));
    expect(before.sessionReady).toBe(false);
    const after = reduceSession(before, { event: "session-ready" });
    expect(after.sessionReady).toBe(true);
  });

  test("reducing never mutates the state it was handed", () => {
    const first = run(spawned("api"));
    const second = reduceSession(first, { event: "ready", worker: "api", at: at(100) });
    expect(first.workers[0]?.status).toBe("building");
    expect(second).not.toBe(first);
  });
});

/**
 * **The roster lists the whole dev set, not just what started.**
 *
 * A worker parked on this branch used to be invisible to the footer — it was never spawned, so no event
 * ever mentioned it — while `pithy dev --list` marks it `skipped  off here`. That made the footer answer
 * "what is running" when the question a developer actually has is "what is this project, and what is it
 * doing", and it hid the one row you would want to press `r` on.
 */
describe("reduceSession — the full dev set", () => {
  const members = [
    { worker: "dash-board", kind: "app" as const, port: 8787, starts: true, autostart: true },
    { worker: "email", kind: "host" as const, port: 8788, starts: true, autostart: true },
    { worker: "payments", kind: "host" as const, port: 8789, starts: false, autostart: false },
  ];

  test("every member gets a row, in the order the set lists them", () => {
    const state = reduceSession(emptySession, { event: "roster", members, at: at(0) });
    expect(state.workers.map((w) => w.name)).toEqual(["dash-board", "email", "payments"]);
  });

  test("a parked worker is skipped rather than building", () => {
    const state = reduceSession(emptySession, { event: "roster", members, at: at(0) });
    expect(state.workers.map((w) => w.status)).toEqual(["building", "building", "skipped"]);
  });

  test("spawning upgrades a row in place, keeping the set's order", () => {
    const state = [
      { event: "roster", members, at: at(0) } as DevEvent,
      { event: "spawned", worker: "email", kind: "host", port: 8788, at: at(500) } as DevEvent,
    ].reduce(reduceSession, emptySession);

    expect(state.workers.map((w) => w.name)).toEqual(["dash-board", "email", "payments"]);
    expect(state.workers[1]?.spawnedAt).toEqual(at(500));
  });

  test("a parked worker that is started later stops being skipped", () => {
    // `r` on a skipped row is a start. The row is the same row.
    const state = [
      { event: "roster", members, at: at(0) } as DevEvent,
      { event: "spawned", worker: "payments", kind: "host", port: 8789, at: at(9000) } as DevEvent,
    ].reduce(reduceSession, emptySession);

    expect(state.workers[2]?.status).toBe("building");
    expect(state.workers[2]?.spawnedAt).toEqual(at(9000));
  });

  test("a skipped worker is never reported as waiting", () => {
    // The ready deadline names workers that started and have not arrived. One that never started is not
    // late; it is off.
    const state = [
      { event: "roster", members, at: at(0) } as DevEvent,
      { event: "waiting", workers: ["payments"] } as DevEvent,
    ].reduce(reduceSession, emptySession);

    expect(state.workers[2]?.status).toBe("skipped");
  });
});
