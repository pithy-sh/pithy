// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { MemberEventKind } from "../data/enums";
import type { TestersEvent } from "../data/event";
import { readClock } from "./replay";

const COHORT = "cohort-1";

/** Build an event without ceremony. `occurredAt` is the only field the replay orders on. */
function event(memberId: string, kind: MemberEventKind, on: string, createdOn = on): TestersEvent {
  return {
    id: 0,
    cohortId: COHORT,
    memberId,
    kind,
    actor: kind === "opted_in" ? "tester" : "developer",
    occurredAt: new Date(`${on}T12:00:00.000Z`),
    metadata: {},
    createdAt: new Date(`${createdOn}T12:00:00.000Z`),
  };
}

/** Opt `count` testers in on one day, so a cohort can be brought to target in one line. */
function optInCohort(count: number, on: string): TestersEvent[] {
  return Array.from({ length: count }, (_, index) => event(`m${index}`, "opted_in", on));
}

const BASE = {
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  targetSize: 12,
  windowDays: 14,
  resetPolicy: "reset" as const,
};

describe("the cohort clock, replayed from events", () => {
  test("a cohort with no events has held no days and is not at target", () => {
    const clock = readClock(BASE, [], new Date("2026-06-05T09:00:00.000Z"));
    expect(clock.estimatedOptedInCount).toBe(0);
    expect(clock.meetsTarget).toBe(false);
    expect(clock.estimatedHeldDays).toBe(0);
    expect(clock.estimatedWindowStartOn).toBeNull();
    expect(clock.estimatedDaysRemaining).toBe(14);
  });

  test("counts a tester from the day they opted in, not from the day they were invited", () => {
    // The whole model rests on the opt-in event; an invitation is not a tester in the count, and
    // counting from the invite would inflate every cohort by everyone who never confirmed.
    const events = [event("m0", "invited", "2026-06-01"), event("m0", "opted_in", "2026-06-04")];
    const clock = readClock({ ...BASE, targetSize: 1 }, events, new Date("2026-06-06T09:00:00.000Z"));
    expect(clock.estimatedHeldDays).toBe(3); // the 4th, 5th, 6th
    expect(clock.estimatedWindowStartOn).toBe("2026-06-04");
  });

  test("held days count the unbroken run ending today, and the window start names its first day", () => {
    const clock = readClock(BASE, optInCohort(12, "2026-06-02"), new Date("2026-06-10T09:00:00.000Z"));
    expect(clock.estimatedOptedInCount).toBe(12);
    expect(clock.estimatedHeldDays).toBe(9);
    expect(clock.estimatedWindowStartOn).toBe("2026-06-02");
    expect(clock.estimatedDaysRemaining).toBe(5);
    expect(clock.headroom).toBe(0);
  });

  test("one tester lapsing mid-window breaks the run, and the streak restarts from zero", () => {
    // This is the failure the whole capability exists to warn about: lose one on day nine and the
    // fourteen-day clock effectively starts again.
    const events = [...optInCohort(12, "2026-06-02"), event("m0", "lapsed", "2026-06-06")];
    const clock = readClock(BASE, events, new Date("2026-06-08T09:00:00.000Z"));
    expect(clock.estimatedOptedInCount).toBe(11);
    expect(clock.meetsTarget).toBe(false);
    expect(clock.estimatedHeldDays).toBe(0);
    expect(clock.resetCount).toBe(1);
    expect(clock.headroom).toBe(-1);
  });

  test("a run that broke and recovered counts only the days since it recovered", () => {
    const events = [
      ...optInCohort(12, "2026-06-02"),
      event("m0", "lapsed", "2026-06-06"),
      event("m12", "opted_in", "2026-06-09"),
    ];
    const clock = readClock(BASE, events, new Date("2026-06-11T09:00:00.000Z"));
    expect(clock.estimatedOptedInCount).toBe(12);
    expect(clock.estimatedHeldDays).toBe(3); // the 9th, 10th, 11th
    expect(clock.estimatedWindowStartOn).toBe("2026-06-09");
    expect(clock.resetCount).toBe(1);
  });

  test("resetToday fires only on the day the run actually broke", () => {
    const events = [...optInCohort(12, "2026-06-02"), event("m0", "lapsed", "2026-06-06")];
    const onTheDay = readClock(BASE, events, new Date("2026-06-06T23:00:00.000Z"));
    const theDayAfter = readClock(BASE, events, new Date("2026-06-07T09:00:00.000Z"));
    expect(onTheDay.resetToday).toBe(true);
    expect(theDayAfter.resetToday).toBe(false);
    // Still broken on both days — `resetToday` marks the transition, not the condition.
    expect(theDayAfter.meetsTarget).toBe(false);
  });

  test("a tester who lapses and opts in again is counted from the second confirmation", () => {
    // Google says the fourteen days must be consecutive and explicitly does not credit an opt-out and
    // re-opt-in as continuous. Taking the latest transition rather than the first is what encodes that.
    const events = [
      event("m0", "opted_in", "2026-06-02"),
      event("m0", "lapsed", "2026-06-04"),
      event("m0", "opted_in", "2026-06-07"),
    ];
    const clock = readClock({ ...BASE, targetSize: 1 }, events, new Date("2026-06-09T09:00:00.000Z"));
    expect(clock.estimatedHeldDays).toBe(3); // the 7th, 8th, 9th — not eight days
    expect(clock.resetCount).toBe(1);
  });

  test("a removed tester leaves the count exactly as a lapsed one does", () => {
    const events = [...optInCohort(12, "2026-06-02"), event("m0", "removed", "2026-06-05")];
    const clock = readClock(BASE, events, new Date("2026-06-06T09:00:00.000Z"));
    expect(clock.estimatedOptedInCount).toBe(11);
  });

  test("nudges and resends move nothing — they are outreach history, not state", () => {
    const events = [
      ...optInCohort(12, "2026-06-02"),
      event("m0", "nudged", "2026-06-04"),
      event("m1", "reinvited", "2026-06-05"),
    ];
    const clock = readClock(BASE, events, new Date("2026-06-06T09:00:00.000Z"));
    expect(clock.estimatedOptedInCount).toBe(12);
    expect(clock.estimatedHeldDays).toBe(5);
  });

  test("an event recorded late is replayed on the day it happened, not the day it was written", () => {
    // A backfill, or a confirmation from a device with a stale clock. Filing it by insertion order
    // would put the opt-in in the wrong day, which for a continuous-days counter is the difference
    // between a completed window and a reset one.
    const events = [...optInCohort(11, "2026-06-02"), event("m11", "opted_in", "2026-06-02", "2026-06-09")];
    const clock = readClock(BASE, events, new Date("2026-06-10T09:00:00.000Z"));
    expect(clock.estimatedHeldDays).toBe(9); // from the 2nd, not from the 9th
  });

  test("`pause` banks every at-target day, where `reset` counts only the unbroken tail", () => {
    // The two policies differ by design, and the difference is stated on the wire as an assumption
    // because Google documents neither behaviour.
    const events = [
      ...optInCohort(12, "2026-06-02"),
      event("m0", "lapsed", "2026-06-05"),
      event("m0", "opted_in", "2026-06-07"),
    ];
    const now = new Date("2026-06-08T09:00:00.000Z");
    const reset = readClock(BASE, events, now);
    const paused = readClock({ ...BASE, resetPolicy: "pause" }, events, now);
    expect(reset.estimatedHeldDays).toBe(2); // the 7th and 8th
    expect(paused.estimatedHeldDays).toBe(5); // 2nd–4th banked, plus the 7th and 8th
    // Under `pause` the banked days need not be adjacent, so there is no day the run "began".
    expect(paused.estimatedWindowStartOn).toBeNull();
  });

  test("days remaining floors at zero once the window is complete", () => {
    const clock = readClock(BASE, optInCohort(12, "2026-06-01"), new Date("2026-06-30T09:00:00.000Z"));
    expect(clock.estimatedHeldDays).toBe(30);
    expect(clock.estimatedDaysRemaining).toBe(0);
  });

  test("headroom is signed, and zero is the danger line rather than a comfortable state", () => {
    const clock = readClock(BASE, optInCohort(12, "2026-06-02"), new Date("2026-06-04T09:00:00.000Z"));
    expect(clock.headroom).toBe(0);
    expect(clock.meetsTarget).toBe(true);
    const spare = readClock(BASE, optInCohort(15, "2026-06-02"), new Date("2026-06-04T09:00:00.000Z"));
    expect(spare.headroom).toBe(3);
  });

  test("the series covers every day from creation to today, so a chart has no gaps", () => {
    const clock = readClock(BASE, optInCohort(12, "2026-06-03"), new Date("2026-06-06T09:00:00.000Z"));
    expect(clock.series.map((entry) => entry.day)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
    ]);
    expect(clock.series.map((entry) => entry.optedIn)).toEqual([0, 0, 12, 12, 12, 12]);
  });
});
