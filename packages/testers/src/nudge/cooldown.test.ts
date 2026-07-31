// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { TestersMember } from "../data/member";
import {
  answersRecentAction,
  chasedOut,
  cooldownUntil,
  MAX_UNANSWERED_NUDGES,
  mayNudge,
  splitByCooldown,
} from "./cooldown";

/**
 * The cooldown had no test at all.
 *
 * Its own docblock calls it "mandatory, server-side, and on every path", and `mayNudge` could be
 * replaced with `return true` — or its call site in the daily pass deleted outright — with the whole
 * suite still green. The one test named for it was asserting a different rule: after a morning pass a
 * member sits at `nudgeCount: 1`, so the re-run was suppressed by `dueNudge`'s two-day re-chase
 * interval and `mayNudge` was never the deciding call. That interval does not apply to `inactive` or
 * `closing`, so the cooldown was the only thing standing between an opted-in tester and a nudge on
 * every consecutive pass.
 */

const HOUR = 3_600_000;
const NOW = new Date("2026-06-10T12:00:00.000Z");

/** A member reduced to the four fields these functions read. */
function member(overrides: Partial<TestersMember> = {}): TestersMember {
  return {
    id: "m-1",
    lastNudgedAt: null,
    acceptedAt: null,
    unreachable: false,
    nudgeCount: 0,
    ...overrides,
  } as TestersMember;
}

describe("when a tester may next be nudged", () => {
  test("a tester never nudged may be nudged now", () => {
    expect(cooldownUntil(member(), 72)).toBeNull();
    expect(mayNudge(member(), 72, NOW)).toBe(true);
  });

  test("the wait is measured from the last nudge, not from now", () => {
    const last = new Date(NOW.getTime() - 24 * HOUR);
    expect(cooldownUntil(member({ lastNudgedAt: last }), 72)?.toISOString()).toBe(
      new Date(last.getTime() + 72 * HOUR).toISOString(),
    );
  });

  test("inside the window they may not be nudged", () => {
    expect(mayNudge(member({ lastNudgedAt: new Date(NOW.getTime() - 71 * HOUR) }), 72, NOW)).toBe(false);
  });

  test("exactly at the boundary they may", () => {
    // `<=`, not `<`. A tester who has waited the full configured period has waited it.
    expect(mayNudge(member({ lastNudgedAt: new Date(NOW.getTime() - 72 * HOUR) }), 72, NOW)).toBe(true);
  });

  test("one millisecond short of it they may not", () => {
    const last = new Date(NOW.getTime() - 72 * HOUR + 1);
    expect(mayNudge(member({ lastNudgedAt: last }), 72, NOW)).toBe(false);
  });

  test("a cooldown of zero hours never blocks anyone", () => {
    expect(mayNudge(member({ lastNudgedAt: NOW }), 0, NOW)).toBe(true);
  });

  test("the configured hours are actually read, so changing them changes the answer", () => {
    // The guard could be deleted entirely and nothing noticed. This is the assertion that notices.
    const last = new Date(NOW.getTime() - 10 * HOUR);
    expect(mayNudge(member({ lastNudgedAt: last }), 6, NOW)).toBe(true);
    expect(mayNudge(member({ lastNudgedAt: last }), 24, NOW)).toBe(false);
  });
});

describe("splitting a roster", () => {
  const cooling = member({ id: "cooling", lastNudgedAt: new Date(NOW.getTime() - HOUR) });
  const ready = member({ id: "ready", lastNudgedAt: new Date(NOW.getTime() - 100 * HOUR) });
  const fresh = member({ id: "fresh" });
  const bounced = member({ id: "bounced", unreachable: true });

  test("puts each tester in exactly one bucket", () => {
    const split = splitByCooldown([cooling, ready, fresh, bounced], 72, NOW);
    expect(split.eligible.map((m) => m.id)).toEqual(["ready", "fresh"]);
    expect(split.cooling.map((m) => m.id)).toEqual(["cooling"]);
    expect(split.unreachable.map((m) => m.id)).toEqual(["bounced"]);
  });

  test("unreachable wins over the cooldown, because the two mean different things", () => {
    // A cooling tester is nudgeable tomorrow; an unreachable one never will be and needs replacing.
    // Reporting them together tells a developer to wait for something that is not going to happen.
    const bouncedAndReady = member({ id: "x", unreachable: true, lastNudgedAt: new Date(NOW.getTime() - 100 * HOUR) });
    const split = splitByCooldown([bouncedAndReady], 72, NOW);
    expect(split.eligible).toEqual([]);
    expect(split.unreachable.map((m) => m.id)).toEqual(["x"]);
  });

  test("an unreachable tester is never eligible, whatever the cooldown says", () => {
    expect(splitByCooldown([bounced], 0, NOW).eligible).toEqual([]);
  });

  test("an empty roster splits into empty buckets rather than throwing", () => {
    expect(splitByCooldown([], 72, NOW)).toEqual({ eligible: [], cooling: [], unreachable: [], chasedOut: [] });
  });
});

describe("chasing stops after three unanswered messages", () => {
  test("a tester who has stopped answering is put aside, not merely cooled", () => {
    // The cooldown bounds how *often*; this bounds how *many times*. It was read only by the daily
    // pass, so a dashboard holding the send scope could mail an unresponsive address every three days
    // for the life of the cohort — the exact failure the cap was written to prevent.
    const unresponsive = member({ id: "gone", nudgeCount: 3, lastNudgedAt: new Date(NOW.getTime() - 100 * HOUR) });
    const split = splitByCooldown([unresponsive], 72, NOW);
    expect(split.eligible).toEqual([]);
    expect(split.chasedOut.map((m) => m.id)).toEqual(["gone"]);
  });

  test("under the cap they are still chased", () => {
    const nearly = member({ id: "ok", nudgeCount: 2, lastNudgedAt: new Date(NOW.getTime() - 100 * HOUR) });
    expect(splitByCooldown([nearly], 72, NOW).eligible.map((m) => m.id)).toEqual(["ok"]);
    expect(chasedOut(nearly)).toBe(false);
  });

  test("the cap is a floor, so a counter past it still counts", () => {
    expect(chasedOut(member({ nudgeCount: MAX_UNANSWERED_NUDGES }))).toBe(true);
    expect(chasedOut(member({ nudgeCount: 12 }))).toBe(true);
  });

  test("and answering clears it, so it only ever bites the genuinely unresponsive", () => {
    // `recordAccepted` and `confirmOptIn` reset the counter. A tester who replies is never capped out.
    expect(chasedOut(member({ nudgeCount: 0 }))).toBe(false);
  });
});

describe("a reply is not a chase", () => {
  test("a tester who agreed after our last message is owed the reply now", () => {
    // The cooldown exists to stop repeated chasing, not to delay a reply. Holding the store link for
    // three days because we happened to ask them two days ago loses the people who were most willing.
    const agreed = member({
      lastNudgedAt: new Date("2026-06-08T09:00:00.000Z"),
      acceptedAt: new Date("2026-06-09T09:00:00.000Z"),
    });
    expect(answersRecentAction(agreed)).toBe(true);
    expect(mayNudge(agreed, 72, NOW)).toBe(false);
  });

  test("a tester who agreed and has since been written to falls under the normal cooldown", () => {
    // Once the reply has gone, `lastNudgedAt` moves past `acceptedAt` and every later reminder is a
    // chase like any other.
    const replied = member({
      acceptedAt: new Date("2026-06-08T09:00:00.000Z"),
      lastNudgedAt: new Date("2026-06-09T09:00:00.000Z"),
    });
    expect(answersRecentAction(replied)).toBe(false);
  });

  test("a tester who agreed and has never been written to is owed it too", () => {
    expect(answersRecentAction(member({ acceptedAt: NOW }))).toBe(true);
  });

  test("a tester who never agreed is never owed a reply", () => {
    expect(answersRecentAction(member({ lastNudgedAt: null }))).toBe(false);
    expect(answersRecentAction(member({ lastNudgedAt: new Date(NOW.getTime() - HOUR) }))).toBe(false);
  });
});
