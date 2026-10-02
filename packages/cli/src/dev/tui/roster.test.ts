// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { formatElapsed, keyBarSegments, rosterCells } from "./roster";
import type { SessionState } from "./session";

/**
 * **The roster's words and columns, decided here rather than inside a React component.**
 *
 * Everything the footer says about a worker is a string this module produces, so the brand voice is held
 * to account by an ordinary test rather than by reading a rendered frame. The component's only remaining
 * job is color — which §3.4 assigns per element and `terminal/style.ts` is the only place to apply.
 */

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

const session = (workers: SessionState["workers"]): SessionState => ({
  workers,
  login: { count: 0, email: null },
  sessionReady: false,
});

describe("formatElapsed", () => {
  test("under ten seconds carries one decimal, the way Done. (3.2s) does", () => {
    expect(formatElapsed(1900)).toBe("1.9s");
    expect(formatElapsed(3200)).toBe("3.2s");
  });

  test("ten seconds and over drops the decimal — nobody needs a tenth at that scale", () => {
    expect(formatElapsed(14_000)).toBe("14s");
    expect(formatElapsed(59_400)).toBe("59s");
  });

  test("a minute and over reads as minutes and seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(134_000)).toBe("2m14s");
  });

  test("zero and negative are not a crash and not a lie", () => {
    // Clock skew between a spawn and a tick is reachable; a negative duration renders as the floor.
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(-5)).toBe("0.0s");
  });
});

describe("rosterCells", () => {
  const four: SessionState["workers"] = [
    { name: "api", kind: "app", port: 8787, spawnedAt: at(0), status: "ready", readyMs: 1900 },
    { name: "web", kind: "app", port: 8788, spawnedAt: at(0), status: "ready", readyMs: 2400 },
    { name: "email", kind: "host", port: 8789, spawnedAt: at(0), status: "building" },
    { name: "support", kind: "host", port: 8790, spawnedAt: at(0), status: "waiting" },
  ];

  test("a ready worker reports the time it took, not how long it has been up", () => {
    const [api] = rosterCells(session(four), { now: at(600_000), columns: 80 }).rows;
    expect(api?.status.trim()).toBe("ready");
    expect(api?.timing.trim()).toBe("1.9s");
  });

  test("a building worker reports elapsed, and asks for the spinner", () => {
    const cells = rosterCells(session(four), { now: at(14_000), columns: 80 }).rows;
    const email = cells.find((c) => c.name.trim() === "email");
    expect(email?.status.trim()).toBe("building");
    expect(email?.timing.trim()).toBe("14s");
    expect(email?.spinner).toBe(true);
  });

  test("only a building worker asks for the spinner — §3.4 reserves it for an indivisible wait", () => {
    const cells = rosterCells(session(four), { now: at(14_000), columns: 80 }).rows;
    expect(cells.filter((c) => c.spinner).map((c) => c.name.trim())).toEqual(["email"]);
  });

  test("a waiting worker reports elapsed too, because that is the fact that makes it worrying", () => {
    const cells = rosterCells(session(four), { now: at(134_000), columns: 80 }).rows;
    const support = cells.find((c) => c.name.trim() === "support");
    expect(support?.status.trim()).toBe("waiting");
    expect(support?.timing.trim()).toBe("2m14s");
  });

  test("an exited worker names its code, and a signaled one says so in words", () => {
    const rows: SessionState["workers"] = [
      { name: "payments", kind: "host", port: 8791, spawnedAt: at(0), status: "exited", exitCode: 1 },
      { name: "media", kind: "host", port: 8792, spawnedAt: at(0), status: "exited", exitCode: null },
    ];
    const cells = rosterCells(session(rows), { now: at(1000), columns: 80 }).rows;
    expect(cells[0]?.status.trim()).toBe("exited (1)");
    expect(cells[1]?.status.trim()).toBe("exited (signal)");
  });

  test("an exited worker reports no timing — a dead worker has no elapsed worth reading", () => {
    const rows: SessionState["workers"] = [
      { name: "payments", kind: "host", port: 8791, spawnedAt: at(0), status: "exited", exitCode: 1 },
    ];
    expect(rosterCells(session(rows), { now: at(99_000), columns: 80 }).rows[0]?.timing.trim()).toBe("");
  });

  test("the name, kind and port columns are padded to the widest member", () => {
    const cells = rosterCells(session(four), { now: at(1000), columns: 80 }).rows;
    expect(new Set(cells.map((c) => c.name.length)).size).toBe(1);
    expect(new Set(cells.map((c) => c.kind.length)).size).toBe(1);
    expect(cells[0]?.name).toBe("api    ");
    expect(cells[3]?.name).toBe("support");
    // Padded to the widest *label* in the set — `worker` is six, so `app` carries three spaces.
    expect(cells[0]?.kind).toBe("app   ");
    expect(cells[2]?.kind).toBe("worker");
  });

  test("a narrow terminal drops the kind and the timing, never the name or the port", () => {
    // §9 sets 80 as the fallback width; below 60 the roster is the two facts you cannot act without.
    const cells = rosterCells(session(four), { now: at(14_000), columns: 48 }).rows;
    expect(cells[0]?.kind).toBe("");
    expect(cells[0]?.timing.trim()).toBe("");
    expect(cells[0]?.name.trim()).toBe("api");
    expect(cells[0]?.port.trim()).toBe("8787");
    // The status is what the row is for, so it survives every width.
    expect(cells[2]?.status.trim()).toBe("building");
    expect(cells[2]?.spinner).toBe(true);
  });

  test("an empty session has no rows rather than a placeholder", () => {
    expect(rosterCells(session([]), { now: at(0), columns: 80 }).rows).toEqual([]);
  });
});

describe("keyBarSegments", () => {
  const keys = [
    { key: "r", label: "restart", enabled: true },
    { key: "o", label: "open", enabled: false },
    { key: "q", label: "quit", enabled: true },
  ];

  test("an enabled key reads in the terminal's own foreground, a disabled one is dim", () => {
    // §3.4's tiers, and no new one: dim is already "secondary against any background". The bar used to
    // be uniformly dim, which left no way to say that a key does nothing on the row you are on.
    const segments = keyBarSegments(keys, 80);
    expect(segments.map((s) => [s.text, s.enabled])).toEqual([
      ["↑↓ select", true],
      ["r restart", true],
      ["o open", false],
      ["q quit", true],
    ]);
  });

  test("a narrow terminal collapses to the one key that lists the rest", () => {
    expect(keyBarSegments(keys, 24).map((s) => s.text)).toEqual(["? keys"]);
  });

  test("no keys is an empty bar rather than a stray selector", () => {
    expect(keyBarSegments([], 80)).toEqual([]);
  });

  test("selection is always available, whatever the row disables", () => {
    const allOff = keys.map((k) => ({ ...k, enabled: false }));
    expect(keyBarSegments(allOff, 80)[0]).toEqual({ text: "↑↓ select", enabled: true });
  });
});

describe("rosterCells — a parked worker", () => {
  const session = (workers: SessionState["workers"]): SessionState => ({
    workers,
    login: { count: 0, email: null },
    sessionReady: false,
  });

  test("a skipped worker says so, and reports no timing", () => {
    // It was never started, so elapsed would be a clock measuring nothing.
    const rows: SessionState["workers"] = [
      { name: "payments", kind: "host", port: 8789, spawnedAt: at(0), status: "skipped" },
    ];
    const [cell] = rosterCells(session(rows), { now: at(99_000), columns: 80 }).rows;
    expect(cell?.status.trim()).toBe("skipped");
    expect(cell?.timing.trim()).toBe("");
    expect(cell?.spinner).toBe(false);
  });

  test("a skipped worker still carries its pinned port, because that is where it would answer", () => {
    const rows: SessionState["workers"] = [
      { name: "payments", kind: "host", port: 8789, spawnedAt: at(0), status: "skipped" },
    ];
    expect(rosterCells(session(rows), { now: at(0), columns: 80 }).rows[0]?.port.trim()).toBe("8789");
  });
});

describe("rosterCells — a row the set seeded but nothing has spawned", () => {
  const session = (workers: SessionState["workers"]): SessionState => ({
    workers,
    login: { count: 0, email: null },
    sessionReady: false,
  });

  test("reports no elapsed rather than time since the epoch", () => {
    // The roster event seeds every member before anything spawns. Giving those rows a start time made
    // the table report `1514477m12s` against a real clock — absent and zero are different facts.
    const rows: SessionState["workers"] = [{ name: "api", kind: "app", port: 8787, status: "building" }];
    expect(rosterCells(session(rows), { now: new Date(), columns: 80 }).rows[0]?.timing.trim()).toBe("");
  });

  test("still asks for the spinner, because it is on its way up", () => {
    const rows: SessionState["workers"] = [{ name: "api", kind: "app", port: 8787, status: "building" }];
    expect(rosterCells(session(rows), { now: new Date(), columns: 80 }).rows[0]?.spinner).toBe(true);
  });
});

describe("rosterCells — the header", () => {
  const session = (workers: SessionState["workers"]): SessionState => ({
    workers,
    login: { count: 0, email: null },
    sessionReady: false,
  });
  const two: SessionState["workers"] = [
    { name: "api", kind: "app", port: 8787, spawnedAt: at(0), status: "ready", readyMs: 1900 },
    { name: "payments", kind: "host", port: 8789, spawnedAt: at(0), status: "skipped", autostart: false },
  ];

  test("it names every column", () => {
    const { header } = rosterCells(session(two), { now: at(0), columns: 100 });
    // Every label padded to its column, so the header sits over the values rather than near them.
    expect(header?.name).toBe("worker  ");
    expect(header?.kind).toBe("kind  ");
    expect(header?.port).toBe("port");
    expect(header?.status.trim()).toBe("state");
    expect(header?.timing.trim()).toBe("time");
    expect(header?.autostart).toBe("autostart");
  });

  test("its own labels are part of each column's width, or nothing lines up", () => {
    // `worker` is wider than `api`, so the name column is six even when every worker is shorter.
    const one: SessionState["workers"] = [{ name: "api", kind: "app", port: 80, spawnedAt: at(0), status: "ready" }];
    const { header, rows } = rosterCells(session(one), { now: at(0), columns: 100 });
    expect(header?.name.length).toBe(rows[0]?.name.length);
    expect(header?.port.length).toBe(rows[0]?.port.length);
  });

  test("an empty session has no header either", () => {
    expect(rosterCells(session([]), { now: at(0), columns: 80 })).toEqual({ header: null, rows: [] });
  });

  test("a narrow terminal drops the same columns from the header as from the rows", () => {
    const { header, rows } = rosterCells(session(two), { now: at(0), columns: 48 });
    expect(header?.kind).toBe("");
    expect(header?.timing.trim()).toBe("");
    expect(header?.autostart).toBe("");
    expect(rows[0]?.autostart).toBe("");
  });
});

describe("rosterCells — the autostart column", () => {
  const session = (workers: SessionState["workers"]): SessionState => ({
    workers,
    login: { count: 0, email: null },
    sessionReady: false,
  });

  test("absent means on, because that is what the file's silence means", () => {
    const rows: SessionState["workers"] = [{ name: "api", kind: "app", port: 8787, spawnedAt: at(0), status: "ready" }];
    expect(rosterCells(session(rows), { now: at(0), columns: 80 }).rows[0]?.autostart).toBe("on");
  });

  test("off says off", () => {
    const rows: SessionState["workers"] = [
      { name: "api", kind: "app", port: 8787, spawnedAt: at(0), status: "ready", autostart: false },
    ];
    expect(rosterCells(session(rows), { now: at(0), columns: 80 }).rows[0]?.autostart).toBe("off");
  });

  test("a running worker with autostart off says both — the two facts disagree until the next run", () => {
    const rows: SessionState["workers"] = [
      { name: "api", kind: "app", port: 8787, spawnedAt: at(0), status: "ready", readyMs: 1900, autostart: false },
    ];
    const [cell] = rosterCells(session(rows), { now: at(0), columns: 80 }).rows;
    expect(cell?.status.trim()).toBe("ready");
    expect(cell?.autostart).toBe("off");
  });
});

describe("rosterCells — the table lines up", () => {
  const session = (workers: SessionState["workers"]): SessionState => ({
    workers,
    login: { count: 0, email: null },
    sessionReady: false,
  });

  /**
   * **The property that was broken, asserted directly.**
   *
   * `state` runs from `ready` to `exited (1)` and `time` from empty to `2m14s`. Leaving either unpadded
   * put every column to its right at a different offset on each row, which is how `autostart` came to
   * sit under nothing in particular. Reported from a real session.
   */
  const ragged: SessionState["workers"] = [
    { name: "api", kind: "app", port: 8787, spawnedAt: at(0), status: "ready", readyMs: 1900 },
    { name: "payments", kind: "host", port: 8791, spawnedAt: at(0), status: "exited", exitCode: 1 },
    { name: "support", kind: "host", port: 8790, spawnedAt: at(0), status: "waiting" },
    { name: "secrets", kind: "host", port: 8811, spawnedAt: at(0), status: "skipped", autostart: false },
  ];

  test("every row's columns are the same width as every other row's", () => {
    const { rows } = rosterCells(session(ragged), { now: at(134_000), columns: 120 });
    for (const column of ["name", "kind", "port", "status", "timing"] as const) {
      expect(new Set(rows.map((r) => r[column].length)).size).toBe(1);
    }
  });

  test("and the same width as the header's", () => {
    const { header, rows } = rosterCells(session(ragged), { now: at(134_000), columns: 120 });
    for (const column of ["name", "kind", "port", "status", "timing"] as const) {
      expect(header?.[column].length).toBe(rows[0]?.[column].length);
    }
  });

  test("the status column is as wide as its widest value, not as its first", () => {
    const { rows } = rosterCells(session(ragged), { now: at(0), columns: 120 });
    expect(rows[0]?.status).toBe("ready     ");
    expect(rows[1]?.status).toBe("exited (1)");
  });
});

describe("keyBarSegments — it sheds the least useful hint first", () => {
  /** The real bar, at the width every key and label now costs. */
  const full = [
    { key: "r", label: "restart", enabled: true },
    { key: "o", label: "open", enabled: true },
    { key: "f", label: "logs (F all)", enabled: true },
    { key: "a", label: "autostart off", enabled: true },
    { key: "l", label: "login", enabled: true },
    { key: "q", label: "quit", enabled: true },
  ];

  test("a wide terminal gets the marker hint and every verb", () => {
    expect(keyBarSegments(full, 120)[0]?.text).toBe("↑↓ select");
    expect(keyBarSegments(full, 120)).toHaveLength(full.length + 1);
  });

  test("a terminal that cannot fit it drops `↑↓ select` and keeps the verbs", () => {
    // A single all-or-nothing threshold replaced the whole bar with `? keys` the moment one more key or
    // one longer label pushed it past 80 — §9's fallback width, and a common terminal. Arrows next to a
    // visible marker are the one hint that explains itself, so they go first.
    const segments = keyBarSegments(full, 74);
    expect(segments[0]?.text).toBe("r restart");
    expect(segments.map((s) => s.text)).not.toContain("↑↓ select");
  });

  test("and only a genuinely narrow one collapses to `? keys`", () => {
    expect(keyBarSegments(full, 30).map((s) => s.text)).toEqual(["? keys"]);
  });

  test("the disabled flags survive whichever shape it takes", () => {
    const some = full.map((k, i) => ({ ...k, enabled: i % 2 === 0 }));
    for (const columns of [120, 74]) {
      const verbs = keyBarSegments(some, columns).filter((s) => s.text !== "↑↓ select");
      expect(verbs.map((s) => s.enabled)).toEqual([true, false, true, false, true, false]);
    }
  });
});
