// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { DevLogEntry } from "./devLogRead";
import { devLogText, devLogWorkerOrder, renderDevLog } from "./devLogRender";
import { stripAnsi } from "./logging";

const entry = (worker: string, record: DevLogEntry["record"]): DevLogEntry => ({ worker, record });
const at = (seconds: number) => `2026-07-27T00:00:${String(seconds).padStart(2, "0")}.000Z`;

describe("devLogText", () => {
  test("an output record is its own text — no prefix, no decoration", () => {
    expect(devLogText({ ts: at(0), stream: "stdout", text: "Ready on http://localhost:8787" })).toBe(
      "Ready on http://localhost:8787",
    );
  });

  test("a lifecycle record is the sentence a person reads", () => {
    expect(devLogText({ ts: at(0), event: "spawned", port: 8787 })).toBe("spawned on port 8787.");
    expect(devLogText({ ts: at(0), event: "ready" })).toBe("ready.");
    expect(devLogText({ ts: at(0), event: "exited", code: 1 })).toBe("exited (1).");
  });

  test("a signaled child has no status to report, so it is not reported as 0", () => {
    expect(devLogText({ ts: at(0), event: "exited", code: null })).toBe("exited (signaled).");
  });
});

describe("renderDevLog", () => {
  test("renders [name] text, which is how the session read live", () => {
    const lines = renderDevLog({
      entries: [entry("api", { ts: at(0), stream: "stdout", text: "hello" })],
      named: ["api"],
      timestamps: false,
    });
    expect(lines.map(stripAnsi)).toEqual(["[api] hello"]);
  });

  test("--timestamps prefixes each line with the record's instant", () => {
    const lines = renderDevLog({
      entries: [entry("api", { ts: at(7), stream: "stdout", text: "hello" })],
      named: ["api"],
      timestamps: true,
    });
    expect(lines.map(stripAnsi)).toEqual([`${at(7)} [api] hello`]);
  });
});

/**
 * **One stable color per worker, recovered from the data.** `workerColor` is keyed on a worker's position
 * in the started set, which is not in the file — so the order is taken from the `spawned` records, which
 * is the order `startWorker` was called in.
 */
describe("devLogWorkerOrder", () => {
  test("orders by first spawn, which is the order the live palette was keyed on", () => {
    const entries = [
      entry("web", { ts: at(2), event: "spawned", port: 8788 }),
      entry("api", { ts: at(1), event: "spawned", port: 8787 }),
    ];
    expect(devLogWorkerOrder(entries, ["web", "api"])).toEqual(["api", "web"]);
  });

  test("a worker whose file holds no spawn still gets a place, after the ones that do", () => {
    const entries = [
      entry("quiet", { ts: at(0), stream: "stdout", text: "x" }),
      entry("api", { ts: at(1), event: "spawned", port: 8787 }),
    ];
    expect(devLogWorkerOrder(entries, ["quiet", "api"])).toEqual(["api", "quiet"]);
  });

  test("a restart does not move a worker: the first spawn is what counts", () => {
    const entries = [
      entry("api", { ts: at(1), event: "spawned", port: 8787 }),
      entry("web", { ts: at(2), event: "spawned", port: 8788 }),
      entry("api", { ts: at(3), event: "exited", code: 0 }),
      entry("api", { ts: at(4), event: "spawned", port: 8787 }),
    ];
    expect(devLogWorkerOrder(entries, ["api", "web"])).toEqual(["api", "web"]);
  });

  test("two workers rendered together are painted differently, which is what the color is for", () => {
    const entries = [
      entry("api", { ts: at(1), event: "spawned", port: 8787 }),
      entry("web", { ts: at(2), event: "spawned", port: 8788 }),
    ];
    const lines = renderDevLog({ entries, named: ["api", "web"], timestamps: false });
    expect(lines.map(stripAnsi)).toEqual(["[api] spawned on port 8787.", "[web] spawned on port 8788."]);
  });
});
