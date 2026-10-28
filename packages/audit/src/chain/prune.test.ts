// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { resolveRetention } from "@pithy-sh/core/src/retention/policy";
import { describe, expect, test } from "vitest";
import { expiredRuns, expiryCutoffs, pastWindow, shortestWindowDays } from "./prune";
import type { ChainRow } from "./rows";

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 9, 27));
const retention = resolveRetention(
  { audit: { default: "90d", prefixes: { "support/": "30d" } } },
  { purgeWindows: [], lifecycleActions: [] },
);

function row(seq: number, action: string, daysAgo: number): ChainRow {
  return { chainSeq: seq, action, occurredAt: NOW.getTime() - daysAgo * DAY } as ChainRow;
}

describe("shortestWindowDays", () => {
  test("the least of every rule and the default", () => {
    expect(shortestWindowDays(retention)).toBe(30);
  });

  test("null when the policy keeps everything", () => {
    expect(shortestWindowDays(resolveRetention({}, { purgeWindows: [], lifecycleActions: [] }))).toBeNull();
  });
});

describe("pastWindow", () => {
  test("by the longest matching prefix, else the default, and never under the floor for the control plane", () => {
    expect(pastWindow(retention, "support/thread_opened", NOW.getTime() - 31 * DAY, NOW)).toBe(true);
    expect(pastWindow(retention, "auth/login", NOW.getTime() - 31 * DAY, NOW)).toBe(false);
    expect(pastWindow(retention, "auth/login", NOW.getTime() - 91 * DAY, NOW)).toBe(true);
    expect(pastWindow(retention, "controlplane/key_created", NOW.getTime() - 91 * DAY, NOW)).toBe(false);
    expect(pastWindow(retention, "controlplane/key_created", NOW.getTime() - 366 * DAY, NOW)).toBe(true);
  });
});

describe("expiryCutoffs", () => {
  test("groups the actions by the instant each passes its window, earliest first, and leaves out what is kept forever", () => {
    expect(
      expiryCutoffs(retention, ["auth/login", "support/thread_opened", "controlplane/key_created", "auth/login"], NOW),
    ).toEqual([
      { before: NOW.getTime() - 365 * DAY, actions: ["controlplane/key_created"] },
      { before: NOW.getTime() - 90 * DAY, actions: ["auth/login"] },
      { before: NOW.getTime() - 30 * DAY, actions: ["support/thread_opened"] },
    ]);
    const forever = resolveRetention(
      { audit: { prefixes: { "support/": "30d" } } },
      { purgeWindows: [], lifecycleActions: [] },
    );
    expect(expiryCutoffs(forever, ["auth/login", "support/thread_opened"], NOW)).toEqual([
      { before: NOW.getTime() - 30 * DAY, actions: ["support/thread_opened"] },
    ]);
  });
});

describe("expiredRuns", () => {
  test("splits at an event kept longer and at a gap in positions", () => {
    const runs = expiredRuns(
      [
        row(1, "auth/login", 100),
        row(2, "auth/login", 100),
        row(3, "auth/login", 1),
        row(4, "auth/login", 100),
        row(6, "auth/login", 100),
        row(7, "support/x", 40),
      ],
      retention,
      NOW,
    );
    expect(runs.map((run) => run.map((each) => each.chainSeq))).toEqual([[1, 2], [4], [6, 7]]);
  });

  test("none when nothing is past its window", () => {
    expect(expiredRuns([row(1, "auth/login", 1)], retention, NOW)).toEqual([]);
  });
});
