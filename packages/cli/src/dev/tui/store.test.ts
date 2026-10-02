// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { DevEvent } from "../events";
import { createDevStore, HIDDEN_TAIL } from "./store";

/**
 * **What the renderer is looking at, driven from outside React.**
 *
 * The supervisor pushes lines and events; the component subscribes. Keeping that in a plain store rather
 * than in component state is what makes focus filtering and selection testable without a terminal — and
 * they are the two pieces of behavior here that a reader would notice getting wrong.
 */

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

describe("createDevStore — the committed stream", () => {
  test("lines are kept in order, each with a key of its own", () => {
    const store = createDevStore();
    store.line("[api] one");
    store.line("[api] two");

    expect(store.state().lines.map((l) => l.text)).toEqual(["[api] one", "[api] two"]);
    expect(new Set(store.state().lines.map((l) => l.id)).size).toBe(2);
  });

  test("a duplicate line is still two lines — a stream is not a set", () => {
    // `<Static>` keys on identity, so two identical log lines must not collapse into one.
    const store = createDevStore();
    store.line("GET /health 200");
    store.line("GET /health 200");
    expect(store.state().lines).toHaveLength(2);
  });

  test("subscribers are told when something arrives", async () => {
    // On the next microtask, not synchronously: a burst of lines wakes the renderer once (below).
    const store = createDevStore();
    let notified = 0;
    store.subscribe(() => notified++);
    store.line("[api] one");
    await Promise.resolve();
    expect(notified).toBe(1);
  });

  test("unsubscribing stops the notifications", async () => {
    const store = createDevStore();
    let notified = 0;
    const off = store.subscribe(() => notified++);
    off();
    store.line("[api] one");
    await Promise.resolve();
    expect(notified).toBe(0);
  });
});

describe("createDevStore — worker output is hidden until asked for", () => {
  test("a worker's own output does not land by default", () => {
    // The roster is the point of the footer; five workers' startup chatter is what buries it.
    const store = createDevStore();
    store.line("[api] GET /health 200", "api");
    expect(store.state().lines).toEqual([]);
  });

  test("the session's own prose always lands, whatever is hidden", () => {
    // `Starting api, web.`, a `.dev.vars` refusal, the delivery verdict, the ready banner,
    // `Still waiting on: support.`, and — the one that would hurt most — `Which identity? Press 1-3.`
    const store = createDevStore();
    store.line("Starting api, web.");
    store.line("Which identity? Press 1-3.");
    expect(store.state().lines.map((l) => l.text)).toEqual(["Starting api, web.", "Which identity? Press 1-3."]);
  });

  test("revealing a worker lands its lines from then on", () => {
    const store = createDevStore();
    store.reveal("api");
    store.line("[api] GET /health 200", "api");
    expect(store.state().lines.map((l) => l.text)).toEqual(["[api] GET /health 200"]);
  });

  test("revealing replays the recent tail, so the key answers the question you pressed it for", () => {
    // Forward-only revealing would show an idle worker nothing at all. The buffer is what makes `f` a
    // way of reading output rather than a way of waiting for more.
    const store = createDevStore();
    store.line("[api] one", "api");
    store.line("[api] two", "api");
    store.reveal("api");
    expect(store.state().lines.map((l) => l.text)).toEqual(["[api] one", "[api] two"]);
  });

  test("the replayed tail is bounded, so a long session does not dump an hour of output", () => {
    const store = createDevStore();
    for (let i = 0; i < HIDDEN_TAIL + 50; i++) store.line(`[api] L${i}`, "api");
    store.reveal("api");
    const lines = store.state().lines.map((l) => l.text);
    expect(lines).toHaveLength(HIDDEN_TAIL);
    expect(lines.at(-1)).toBe(`[api] L${HIDDEN_TAIL + 49}`);
  });

  test("a replayed tail is replayed once", () => {
    const store = createDevStore();
    store.line("[api] one", "api");
    store.reveal("api");
    store.hide("api");
    store.reveal("api");
    expect(store.state().lines.map((l) => l.text)).toEqual(["[api] one"]);
  });

  test("revealing one worker does not reveal another", () => {
    const store = createDevStore();
    store.reveal("api");
    store.line("[api] mine", "api");
    store.line("[web] theirs", "web");
    expect(store.state().lines.map((l) => l.text)).toEqual(["[api] mine"]);
  });

  test("two workers can be revealed at once — a stack can have several front ends", () => {
    const store = createDevStore();
    store.reveal("api");
    store.reveal("web");
    store.line("[api] mine", "api");
    store.line("[web] theirs", "web");
    expect(store.state().lines).toHaveLength(2);
  });

  test("hiding stops the output again, and leaves what already printed alone", () => {
    const store = createDevStore();
    store.reveal("api");
    store.line("[api] kept", "api");
    store.hide("api");
    store.line("[api] dropped", "api");
    expect(store.state().lines.map((l) => l.text)).toEqual(["[api] kept"]);
  });

  test("which workers are revealed is readable, so the footer can mark them", () => {
    const store = createDevStore();
    expect(store.state().revealed).toEqual([]);
    store.reveal("api");
    expect(store.state().revealed).toEqual(["api"]);
  });

  test("showAll reveals everything, and replays each worker's tail once", () => {
    const store = createDevStore();
    store.line("[api] one", "api");
    store.line("[web] two", "web");
    store.showAll(true);
    expect(store.state().lines.map((l) => l.text)).toEqual(["[api] one", "[web] two"]);
    store.line("[api] three", "api");
    expect(store.state().lines).toHaveLength(3);
  });
});

describe("createDevStore — a worker in trouble reveals itself", () => {
  test("a worker that exits is revealed, because its output is why", () => {
    // Hiding by default must not bury the thing you came for. `docs/commands/dev.md` is emphatic that
    // the error forty lines up the scrollback is the whole problem — so a failure is loud by itself.
    const store = createDevStore();
    store.line("[payments] Build failed with 1 error", "payments");
    store.event({ event: "spawned", worker: "payments", kind: "host", port: 8791, at: at(0) });
    store.event({ event: "exited", worker: "payments", code: 1, expected: false });
    expect(store.state().lines.map((l) => l.text)).toContain("[payments] Build failed with 1 error");
    expect(store.state().revealed).toContain("payments");
  });

  test("a worker still missing at the deadline is revealed too", () => {
    // A `wrangler dev` whose first build fails never exits — it prints the error and keeps running. The
    // deadline is the only signal that worker is in trouble.
    const store = createDevStore();
    store.line("[support] error during build", "support");
    store.event({ event: "spawned", worker: "support", kind: "host", port: 8790, at: at(0) });
    store.event({ event: "waiting", workers: ["support"] });
    expect(store.state().lines.map((l) => l.text)).toContain("[support] error during build");
  });

  test("a healthy worker becoming ready reveals nothing", () => {
    const store = createDevStore();
    store.line("[api] Ready on http://localhost:8787", "api");
    store.event({ event: "spawned", worker: "api", kind: "app", port: 8787, at: at(0) });
    store.event({ event: "ready", worker: "api", at: at(1900) });
    expect(store.state().lines).toEqual([]);
    expect(store.state().revealed).toEqual([]);
  });
});

describe("createDevStore — selection", () => {
  const twoWorkers = (store: ReturnType<typeof createDevStore>) => {
    store.event({ event: "spawned", worker: "api", kind: "app", port: 8787, at: at(0) });
    store.event({ event: "spawned", worker: "web", kind: "app", port: 8788, at: at(0) });
  };

  test("the first worker is selected once there is one", () => {
    const store = createDevStore();
    twoWorkers(store);
    expect(store.state().selected).toBe(0);
  });

  test("moving down and up walks the roster", () => {
    const store = createDevStore();
    twoWorkers(store);
    store.move(1);
    expect(store.state().selected).toBe(1);
    store.move(-1);
    expect(store.state().selected).toBe(0);
  });

  test("selection clamps rather than wrapping, at both ends", () => {
    // Clamping, because a roster of four is read by eye: a marker that leaps from the last row to the
    // first reads as a glitch rather than as a move.
    const store = createDevStore();
    twoWorkers(store);
    store.move(-1);
    expect(store.state().selected).toBe(0);
    store.move(5);
    expect(store.state().selected).toBe(1);
  });

  test("selection on an empty roster stays at zero rather than going negative", () => {
    const store = createDevStore();
    store.move(-1);
    expect(store.state().selected).toBe(0);
    store.move(3);
    expect(store.state().selected).toBe(0);
  });

  test("the selected worker's name is what a key acts on", () => {
    const store = createDevStore();
    twoWorkers(store);
    expect(store.selectedWorker()).toBe("api");
    store.move(1);
    expect(store.selectedWorker()).toBe("web");
  });

  test("an empty roster has no selected worker rather than a wrong one", () => {
    expect(createDevStore().selectedWorker()).toBeNull();
  });
});

describe("createDevStore — session events", () => {
  test("events fold into the session the footer renders", () => {
    const store = createDevStore();
    store.event({ event: "spawned", worker: "api", kind: "app", port: 8787, at: at(0) });
    store.event({ event: "ready", worker: "api", at: at(1900) });

    expect(store.state().session.workers[0]?.status).toBe("ready");
    expect(store.state().session.workers[0]?.readyMs).toBe(1900);
  });

  test("an event notifies subscribers, because the footer has to repaint", async () => {
    const store = createDevStore();
    let notified = 0;
    store.subscribe(() => notified++);
    store.event({ event: "session-ready" });
    await Promise.resolve();
    expect(notified).toBe(1);
  });
});

/**
 * **Committing a line must cost the same whether it is the first or the ten-thousandth.**
 *
 * The renderer handed `<Static>` a fresh copy of every committed line on every render, and every line
 * produced a render — so the cost of a session was quadratic in its own output. With worker logs showing
 * and five workers talking, that saturates the event loop: a real session went unresponsive, and a `q`
 * pressed into it looked like a deadlock when it was starvation. Reported from a session that had all
 * logging turned on.
 *
 * Two properties fix it and are pinned here: the committed array is **one array**, appended to rather
 * than rebuilt, and a burst of lines wakes the renderer **once** rather than once per line.
 */
describe("createDevStore — the cost of a line", () => {
  test("the committed array is replaced on every append, which `<Static>` requires", () => {
    // Not a wasted copy. `<Static>` memoizes `items.slice(index)` on `[items, index]` and bumps `index`
    // to `items.length` from a layout effect keyed on that length — so appending to one stable array
    // loses the new lines entirely: the index moves first, and the slice then finds nothing. Tried, and
    // the footer rendered with not one log line under it.
    const store = createDevStore();
    store.showAll(true);
    store.line("one", "api");
    const first = store.state().lines;
    store.line("two", "api");
    expect(store.state().lines).not.toBe(first);
    expect(store.state().lines.map((l) => l.text)).toEqual(["one", "two"]);
  });

  test("the snapshot object still changes, or React would never re-render", () => {
    // `useSyncExternalStore` compares snapshots by identity. The array is stable; the wrapper is not.
    const store = createDevStore();
    store.showAll(true);
    const before = store.state();
    store.line("one", "api");
    expect(store.state()).not.toBe(before);
  });

  test("the snapshot is cached between changes, which useSyncExternalStore requires", () => {
    const store = createDevStore();
    expect(store.state()).toBe(store.state());
  });

  test("a burst of lines wakes the renderer once", async () => {
    const store = createDevStore();
    store.showAll(true);
    let woken = 0;
    store.subscribe(() => woken++);

    for (let i = 0; i < 500; i++) store.line(`L${i}`, "api");
    expect(woken).toBe(0);
    await Promise.resolve();
    expect(woken).toBe(1);
    expect(store.state().lines).toHaveLength(500);
  });

  test("and the lines are all there, in order, exactly once", async () => {
    const store = createDevStore();
    store.showAll(true);
    for (let i = 0; i < 500; i++) store.line(`L${i}`, "api");
    await Promise.resolve();
    expect(store.state().lines.map((l) => l.text)).toEqual(Array.from({ length: 500 }, (_, i) => `L${i}`));
  });
});

/**
 * **An exit nobody asked for is a failure. An exit we caused is not.**
 *
 * Revealing a worker's output when it dies is what keeps hiding-by-default honest. But *every* worker
 * exits during a teardown, and a restart exits one on purpose — so `q` revealed all five at once and
 * replayed up to 200 buffered lines each, which is a wall of output arriving exactly as the session
 * ends. Reported twice from real sessions.
 */
describe("createDevStore — an expected exit reveals nothing", () => {
  const spawn = (name: string): DevEvent => ({
    event: "spawned",
    worker: name,
    kind: "host",
    port: 8791,
    at: at(0),
  });

  test("an unexpected exit still reveals, with its buffered output", () => {
    const store = createDevStore();
    store.event(spawn("payments"));
    store.line("[payments] Build failed with 1 error", "payments");
    store.event({ event: "exited", worker: "payments", code: 1, expected: false });

    expect(store.state().revealed).toContain("payments");
    expect(store.state().lines.map((l) => l.text)).toContain("[payments] Build failed with 1 error");
  });

  test("a teardown's exit reveals nothing and replays nothing", () => {
    const store = createDevStore();
    store.event(spawn("payments"));
    store.line("[payments] shutting down", "payments");
    store.event({ event: "exited", worker: "payments", code: 0, expected: true });

    expect(store.state().revealed).toEqual([]);
    expect(store.state().lines).toEqual([]);
  });

  test("a restart's exit reveals nothing either — `r` is not a crash", () => {
    const store = createDevStore();
    store.event(spawn("secrets"));
    store.line("[secrets] stopping", "secrets");
    store.event({ event: "exited", worker: "secrets", code: 0, expected: true });
    store.event(spawn("secrets"));

    expect(store.state().revealed).toEqual([]);
  });

  test("a worker already revealed by hand stays revealed through a teardown", () => {
    // Asking for output is a decision; an expected exit must not quietly undo it.
    const store = createDevStore();
    store.event(spawn("payments"));
    store.reveal("payments");
    store.event({ event: "exited", worker: "payments", code: 0, expected: true });

    expect(store.state().revealed).toEqual(["payments"]);
  });

  test("the row still says it exited, whoever caused it", () => {
    const store = createDevStore();
    store.event(spawn("payments"));
    store.event({ event: "exited", worker: "payments", code: 0, expected: true });

    expect(store.state().session.workers[0]?.status).toBe("exited");
  });
});

describe("createDevStore — the identity picker", () => {
  const people = [
    { userId: "dev-1", email: "one@example.com" },
    { userId: "dev-2", email: "two@example.com" },
    { userId: "dev-3", email: "three@example.com" },
  ];

  test("nothing is open to begin with, so the roster is what shows", () => {
    expect(createDevStore().state().picker).toBeNull();
  });

  test("opening it remembers the list and the worker `l` was pressed on", () => {
    const store = createDevStore();
    store.openPicker(people, "dash-board");
    expect(store.state().picker).toMatchObject({ identities: people, selected: 0, worker: "dash-board" });
  });

  test("the marker moves, clamped at both ends", () => {
    const store = createDevStore();
    store.openPicker(people);
    store.movePicker(1);
    expect(store.state().picker?.selected).toBe(1);
    store.movePicker(-5);
    expect(store.state().picker?.selected).toBe(0);
    store.movePicker(99);
    expect(store.state().picker?.selected).toBe(2);
  });

  test("typing filters, and resets the marker to the top of what is left", () => {
    const store = createDevStore();
    store.openPicker(people);
    store.movePicker(2);
    store.typePicker("t");
    store.typePicker("w");
    expect(store.state().picker?.query).toBe("tw");
    expect(store.state().picker?.selected).toBe(0);
  });

  test("backspace takes a character back, and does nothing on an empty query", () => {
    const store = createDevStore();
    store.openPicker(people);
    store.typePicker("t");
    store.backspacePicker();
    expect(store.state().picker?.query).toBe("");
    store.backspacePicker();
    expect(store.state().picker?.query).toBe("");
  });

  test("clearing the query keeps the picker open", () => {
    const store = createDevStore();
    store.openPicker(people);
    store.typePicker("t");
    store.clearPickerQuery();
    expect(store.state().picker).toMatchObject({ query: "", selected: 0 });
  });

  test("the marker is clamped against the matches, not the whole list", () => {
    // Narrowing three to one and then pressing down must not leave the marker pointing at nothing.
    const store = createDevStore();
    store.openPicker(people);
    store.typePicker("one");
    store.movePicker(5);
    expect(store.state().picker?.selected).toBe(0);
  });

  test("the choice resolves against the filtered list the view draws", () => {
    // If the two disagreed, Enter would sign you in as whoever occupied that row in the other list.
    const store = createDevStore();
    store.openPicker(people, "web");
    store.typePicker("three");
    expect(store.pickerChoice()).toEqual({ identity: people[2], worker: "web" });
  });

  test("a query matching nothing has nothing to choose", () => {
    const store = createDevStore();
    store.openPicker(people);
    store.typePicker("nobody");
    expect(store.pickerChoice()).toBeNull();
  });

  test("the chosen identity is readable, so Enter has something to act on", () => {
    const store = createDevStore();
    store.openPicker(people, "web");
    store.movePicker(1);
    expect(store.pickerChoice()).toEqual({ identity: people[1], worker: "web" });
  });

  test("closing it returns to the roster", () => {
    const store = createDevStore();
    store.openPicker(people);
    store.closePicker();
    expect(store.state().picker).toBeNull();
  });

  test("nothing is chosen when nothing is open", () => {
    expect(createDevStore().pickerChoice()).toBeNull();
  });

  test("moving or typing with nothing open does nothing rather than throwing", () => {
    const store = createDevStore();
    store.movePicker(1);
    store.typePicker("x");
    store.backspacePicker();
    store.clearPickerQuery();
    expect(store.state().picker).toBeNull();
  });

  test("the roster's own selection is untouched by the picker", () => {
    // The two markers are separate: coming back from the picker must not have moved the roster.
    const store = createDevStore();
    store.event({ event: "spawned", worker: "api", kind: "app", port: 8787, at: at(0) });
    store.event({ event: "spawned", worker: "web", kind: "app", port: 8788, at: at(0) });
    store.move(1);
    store.openPicker(people);
    store.movePicker(2);
    store.closePicker();
    expect(store.state().selected).toBe(1);
  });
});

describe("createDevStore — showAll and a worker that never started", () => {
  const roster = (): DevEvent => ({
    event: "roster",
    members: [
      { worker: "api", kind: "app", port: 8787, starts: true, autostart: true },
      { worker: "payments", kind: "host", port: 8791, starts: false, autostart: false },
      { worker: "secrets", kind: "host", port: 8811, starts: false, autostart: false },
    ],
    at: at(0),
  });

  test("F reveals only the workers that are running", () => {
    // A parked worker has no output and will produce none this run, so marking it revealed made its name
    // wear its color on the roster as though its logs were showing. Reported from a session with three
    // workers off.
    const store = createDevStore();
    store.event(roster());
    store.showAll(true);

    expect(store.state().revealed).toEqual(["api"]);
  });

  test("and it still shows everything that does have output", () => {
    const store = createDevStore();
    store.event(roster());
    store.line("[api] one", "api");
    store.showAll(true);

    expect(store.state().lines.map((l) => l.text)).toEqual(["[api] one"]);
    expect(store.state().showingAll).toBe(true);
  });

  test("a worker started from parked is revealed by a later F", () => {
    const store = createDevStore();
    store.event(roster());
    store.showAll(true);
    store.event({ event: "spawned", worker: "payments", kind: "host", port: 8791, at: at(9000) });
    store.showAll(false);
    store.showAll(true);

    expect(store.state().revealed).toEqual(["api", "payments"]);
  });

  test("output that arrived before the roster knew about it is not lost", () => {
    // Defensive: a line can reach the store before the `roster` event that gives it a row, and a buffer
    // nothing replays is output thrown away.
    const store = createDevStore();
    store.line("[early] something", "early");
    store.showAll(true);

    expect(store.state().lines.map((l) => l.text)).toEqual(["[early] something"]);
  });
});
