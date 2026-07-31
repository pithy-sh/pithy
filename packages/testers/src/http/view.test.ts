// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { TesterActivity } from "../activity/resolve";
import { readClock } from "../clock/replay";
import { TestersConfig } from "../config/config";
import type { TestersCohort } from "../data/cohort";
import type { TestersEvent } from "../data/event";
import type { TestersMember } from "../data/member";
import type { MemberReading } from "../projection/build";
import type { CohortReading } from "../roster/read";
import { toCohortView } from "./view";

/**
 * The cohort view had no test at all — 0% of statements, on the shape every dashboard and every
 * `pithy testers status --json` is built from.
 *
 * Six mutations survived the whole suite, and every one of them sat on a line whose comment records a
 * bug that had already been found and fixed once: returning the roster regardless of `?members=`,
 * dropping the third conjunct from `fragile`, counting removed testers toward the roster cap, throwing
 * the measured conversion latency away, and removing the opt-in floor from the dark clock. A fix with
 * no test is a fix waiting to be undone.
 */

const CONFIG = TestersConfig.parse({ baseUrl: "https://api.example.test" });
const NOW = new Date("2026-06-10T12:00:00.000Z");
const CREATED = new Date("2026-06-01T00:00:00.000Z");

function cohort(overrides: Partial<TestersCohort> = {}): TestersCohort {
  return {
    id: "c-1",
    name: "closed-test",
    targetPlatform: "android",
    targetSize: 2,
    windowDays: 14,
    maxRosterSize: 10,
    storeOptInUrl: "https://play.google.com/apps/testing/com.example.app",
    resetPolicy: "reset",
    closedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  } as TestersCohort;
}

function member(id: string, overrides: Partial<TestersMember> = {}): TestersMember {
  return {
    id,
    cohortId: "c-1",
    email: `${id}@example.test`,
    name: null,
    optInToken: `${id}-token`,
    state: "opted_in",
    invitedAt: CREATED,
    acceptedAt: CREATED,
    optedInAt: new Date("2026-06-02T00:00:00.000Z"),
    lapsedAt: null,
    lastInvitedAt: CREATED,
    lastNudgedAt: null,
    nudgeCount: 0,
    unreachable: false,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  } as TestersMember;
}

function activity(overrides: Partial<TesterActivity> = {}): TesterActivity {
  return {
    email: "x@example.test",
    userId: "u-1",
    observability: "observed",
    state: "active",
    lastAuthenticatedAt: new Date("2026-06-09T00:00:00.000Z"),
    sessionsInWindow: 3,
    devices: [],
    ...overrides,
  };
}

/** An opted-in event for each member, so the clock replays to something. */
function events(readings: readonly MemberReading[]): TestersEvent[] {
  return readings
    .filter((entry) => entry.member.optedInAt !== null)
    .map(
      (entry, index) =>
        ({
          id: index + 1,
          cohortId: "c-1",
          memberId: entry.member.id,
          kind: "opted_in",
          actor: "tester",
          metadata: null,
          occurredAt: entry.member.optedInAt as Date,
          createdAt: entry.member.optedInAt as Date,
        }) as unknown as TestersEvent,
    );
}

function reading(readings: readonly MemberReading[], overrides: Partial<TestersCohort> = {}): CohortReading {
  const c = cohort(overrides);
  const log = events(readings);
  return {
    cohort: c,
    clock: readClock(
      { createdAt: c.createdAt, targetSize: c.targetSize, windowDays: c.windowDays, resetPolicy: c.resetPolicy },
      log,
      NOW,
    ),
    readings,
    events: log,
  };
}

const OPTIONS = { includeMembers: false, snapshots: [], latest: undefined } as const;

describe("the roster is only returned when it is asked for", () => {
  const two: MemberReading[] = [
    { member: member("ada"), activity: activity({ email: "ada@example.test" }) },
    { member: member("grace"), activity: activity({ email: "grace@example.test" }) },
  ];

  test("omitted by default, so a caller does not receive every tester's address unasked", () => {
    // `testers:roster:read` gates the roster deliberately. Returning it unconditionally hands a caller
    // twelve email addresses they did not request, on a response about a cohort's position.
    const view = toCohortView(reading(two), CONFIG, OPTIONS, NOW);
    expect(view.members).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("ada@example.test");
  });

  test("present when it is", () => {
    const view = toCohortView(reading(two), CONFIG, { ...OPTIONS, includeMembers: true }, NOW);
    expect(view.members?.map((m) => m.email).sort()).toEqual(["ada@example.test", "grace@example.test"]);
  });

  test("but the counts are always there, because that is what the response is about", () => {
    const view = toCohortView(reading(two), CONFIG, OPTIONS, NOW);
    expect(view.roster.optedIn).toBe(2);
  });
});

describe("the roster cap counts only testers who occupy a place", () => {
  test("a removed tester frees theirs", () => {
    // Counting every row against the cap meant a cohort that had churned through a few people could
    // not invite a replacement despite having room.
    const readings: MemberReading[] = [
      { member: member("ada"), activity: activity() },
      { member: member("gone", { state: "removed" }), activity: activity() },
      { member: member("left", { state: "lapsed", lapsedAt: NOW }), activity: activity() },
    ];
    const view = toCohortView(reading(readings), CONFIG, OPTIONS, NOW);
    expect(view.roster.headroomToMax).toBe(cohort().maxRosterSize - 1);
  });
});

describe("fragile means all three things, not two of them", () => {
  test("at target with no headroom but every tester healthy is not fragile", () => {
    // "One lapse from a reset." is a saffron line in the CLI, and the brand reserves that for meaning.
    // A twelve-of-twelve cohort of entirely healthy testers raised it until its first snapshot landed,
    // then the warning vanished with nothing about the cohort having changed.
    const readings: MemberReading[] = [
      { member: member("ada"), activity: activity() },
      { member: member("grace"), activity: activity() },
    ];
    const view = toCohortView(reading(readings), CONFIG, OPTIONS, NOW);
    expect(view.estimatedClock.headroom).toBe(0);
    expect(view.estimatedClock.meetsTarget).toBe(true);
    expect(view.trend.fragile).toBe(false);
  });

  test("at target with no headroom and a weak tester is", () => {
    const readings: MemberReading[] = [
      { member: member("ada"), activity: activity() },
      {
        member: member("quiet"),
        activity: activity({ state: "inactive", lastAuthenticatedAt: new Date("2026-05-20T00:00:00.000Z") }),
      },
    ];
    const view = toCohortView(reading(readings), CONFIG, OPTIONS, NOW);
    expect(view.trend.fragile).toBe(true);
  });
});

describe("the dark clock floors at the opt-in", () => {
  test("a tester who confirmed this morning is not reported as long dark", () => {
    // Opting in is a GET on a public route and creates no session, so a tester whose confirmation is
    // newer than their last sign-in would otherwise measure darkness from the day they were invited
    // and arrive reading as critical.
    const readings: MemberReading[] = [
      {
        member: member("ada", { optedInAt: new Date("2026-06-10T08:00:00.000Z") }),
        activity: activity({ lastAuthenticatedAt: new Date("2026-05-01T00:00:00.000Z") }),
      },
    ];
    const view = toCohortView(reading(readings), CONFIG, { ...OPTIONS, includeMembers: true }, NOW);
    // Measured from the confirmation, not from the May sign-in — 0 days, not 40.
    expect(view.members?.[0]?.activity.daysDark).toBe(0);
  });
});

describe("the forecast reads the cohort's own conversion latency", () => {
  test("a cohort with measured conversions does not fall back to the default prior", () => {
    // Hardcoding "no evidence" here could never clear the five-conversion evidence gate, so the live
    // read always used the three-day default prior while the snapshot written the same morning used
    // the cohort's real one — and the card and the chart projected different completion dates.
    //
    // Six testers who each took eight days to convert, plus enough pipeline to close the remaining gap.
    const converted: MemberReading[] = Array.from({ length: 6 }, (_, i) => ({
      member: member(`slow-${i}`, {
        invitedAt: CREATED,
        optedInAt: new Date(CREATED.getTime() + 8 * 86_400_000),
      }),
      activity: activity(),
    }));
    const pipeline: MemberReading[] = Array.from({ length: 12 }, (_, i) => ({
      member: member(`waiting-${i}`, { state: "accepted", optedInAt: null }),
      activity: activity(),
    }));

    const view = toCohortView(reading([...converted, ...pipeline], { targetSize: 8 }), CONFIG, OPTIONS, NOW);

    // Eight days measured, from a sample of six — past the five-conversion gate. The default prior is
    // three days, which would project 2026-06-13.
    expect(view.projection.projectedTargetMetOn).toBe("2026-06-18");
  });
});

describe("the disclaimer", () => {
  test("is on every response, because a required field is a fact about the wire format", () => {
    expect(toCohortView(reading([]), CONFIG, OPTIONS, NOW).disclaimer.statement).toContain("no API");
  });

  test("and an empty cohort renders rather than throwing", () => {
    const view = toCohortView(reading([]), CONFIG, { ...OPTIONS, includeMembers: true }, NOW);
    expect(view.members).toEqual([]);
    expect(view.roster.size).toBe(0);
    expect(view.roster.optedIn).toBe(0);
    expect(view.estimatedClock.meetsTarget).toBe(false);
  });
});
