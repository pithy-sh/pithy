// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { TestersCohort } from "./cohort";
import { TestersEvent } from "./event";
import { TestersMember } from "./member";
import { TestersCohortSnapshot } from "./snapshot";
import {
  TESTERS_COHORTS_TABLE,
  TESTERS_EVENTS_TABLE,
  TESTERS_MEMBERS_TABLE,
  TESTERS_SNAPSHOTS_TABLE,
  testersTables,
} from "./tables";

/** camelCase here; `CamelCasePlugin` snake-cases it in the DDL. */
const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const AT = new Date("2026-06-10T12:00:00.000Z");

describe("table prefixing (CLAUDE.md §Data layer)", () => {
  it("prefixes every provided table pithy_testers_, so it can never clash with an adopter's own", () => {
    for (const name of Object.keys(testersTables())) {
      expect(toSnake(name)).toMatch(/^pithy_testers_/);
    }
  });

  it("names the four tables the migration creates", () => {
    expect(Object.keys(testersTables()).sort()).toEqual(
      [TESTERS_COHORTS_TABLE, TESTERS_MEMBERS_TABLE, TESTERS_EVENTS_TABLE, TESTERS_SNAPSHOTS_TABLE].sort(),
    );
  });
});

describe("codec round-trips", () => {
  const cohort = {
    id: "cohort-1",
    name: "closed-test",
    targetPlatform: "android" as const,
    targetSize: 12,
    windowDays: 14,
    maxRosterSize: 100,
    storeOptInUrl: "https://play.google.com/apps/testing/com.example.app",
    resetPolicy: "reset" as const,
    closedAt: null,
    createdAt: AT,
    updatedAt: AT,
  };

  it("encodes cohort timestamps to ms-epoch and decodes them back", () => {
    const row = TestersCohort.encode(cohort);
    expect(row.createdAt).toBe(AT.getTime());
    expect(row.closedAt).toBeNull();
    expect(TestersCohort.parse(row)).toEqual(cohort);
  });

  const member = {
    id: "member-1",
    cohortId: "cohort-1",
    email: "ada@example.com",
    name: "Ada Lovelace",
    optInToken: "K7pQ2vX9mR4tY8wZ1nB5cD3fG6hJ0kL2sA7dF9gH4jM",
    state: "opted_in" as const,
    invitedAt: AT,
    acceptedAt: AT,
    optedInAt: AT,
    lapsedAt: null,
    lastInvitedAt: AT,
    lastNudgedAt: null,
    nudgeCount: 2,
    unreachable: false,
    createdAt: AT,
    updatedAt: AT,
  };

  it("round-trips a member, nullable dates included", () => {
    const row = TestersMember.encode(member);
    expect(row.optedInAt).toBe(AT.getTime());
    expect(row.lapsedAt).toBeNull();
    expect(TestersMember.parse(row)).toEqual(member);
  });

  it("carries the confirmation token, which is the whole credential rather than a lookup key", () => {
    // A signed token could be verified without the row; this one cannot, which is exactly what makes it
    // revocable — removing a tester rotates it and the old link stops working on the next request.
    const row = TestersMember.encode(member);
    expect(row.optInToken).toBe(member.optInToken);
    expect(TestersMember.parse(row).optInToken).toBe(member.optInToken);
  });

  it("round-trips `unreachable` through the boolean codec, 0/1 on the row and a boolean in TS", () => {
    // It was a hand-written integer, justified by a comment saying the daily pass sums it in SQL.
    // Nothing sums it: every count in the package is a filter over already-decoded rows, so the
    // exemption bought two `? 1 : 0` conversions in write code and four `=== 1` re-derivations at
    // read sites — exactly what the codec rule exists to remove.
    expect(TestersMember.encode({ ...member, unreachable: true }).unreachable).toBe(1);
    expect(TestersMember.encode({ ...member, unreachable: false }).unreachable).toBe(0);
    expect(TestersMember.parse(TestersMember.encode({ ...member, unreachable: true })).unreachable).toBe(true);
    expect(TestersMember.parse(TestersMember.encode({ ...member, unreachable: false })).unreachable).toBe(false);
  });

  it("rejects a member state outside the enum", () => {
    expect(() => TestersMember.parse({ ...TestersMember.encode(member), state: "pending" })).toThrow();
  });

  const event = {
    id: 7,
    cohortId: "cohort-1",
    memberId: "member-1",
    kind: "nudged" as const,
    actor: "system" as const,
    occurredAt: AT,
    metadata: { nudge: { nudgeKind: "confirm" as const, jobId: "job-1", copySource: "default" as const } },
    createdAt: AT,
  };

  it("encodes event metadata to a JSON string and validates it on the way back", () => {
    const row = TestersEvent.encode(event);
    expect(typeof row.metadata).toBe("string");
    expect(TestersEvent.parse(row)).toEqual(event);
  });

  it("refuses event metadata that does not match the declared shape", () => {
    // An event log that accepts arbitrary shapes stops being replayable, so the JSON column is
    // validated on write and on read rather than merely serialized.
    expect(() =>
      TestersEvent.parse({ ...TestersEvent.encode(event), metadata: JSON.stringify({ nudge: { nudgeKind: "wat" } }) }),
    ).toThrow();
  });

  const snapshot = {
    id: 1,
    cohortId: "cohort-1",
    snapshotOn: "2026-06-10",
    dayIndex: 9,
    computedAt: AT,
    backfilled: false,
    modelVersion: "1",
    rosterSize: 14,
    invitedCount: 1,
    acceptedCount: 1,
    estimatedOptedInCount: 12,
    lapsedCount: 0,
    unreachableCount: 0,
    targetSize: 12,
    windowDays: 14,
    meetsTarget: true,
    headroom: 0,
    estimatedHeldDays: 9,
    estimatedWindowStartOn: "2026-06-02",
    estimatedDaysRemaining: 5,
    resetCount: 0,
    resetToday: false,
    observedCount: 9,
    neverLinkedCount: 3,
    observedCoverage: 0.75,
    activeCount: 7,
    darkThreeToSevenCount: 1,
    darkEightToThirteenCount: 1,
    darkFourteenPlusCount: 0,
    sessionsInWindow: 41,
    targetPlatformDeviceCount: 9,
    healthyCount: 7,
    watchCount: 1,
    atRiskCount: 1,
    criticalCount: 0,
    unknownHealthCount: 3,
    medianHealth: 90,
    minHealth: 55,
    expectedSurvivors: 11.3,
    probabilityReachTarget: 1,
    probabilityHoldWindow: 0.71,
    successProbability: 0.71,
    successProbabilityLow: 0.55,
    successProbabilityHigh: 0.84,
    confidence: "moderate" as const,
    basis: "estimated" as const,
    projectedTargetMetOn: "2026-06-10",
    projectedCompleteOn: "2026-06-15",
    invitesNeeded: 0,
    recommendedRosterSize: 18,
    optedInDelta1d: 0,
    optedInDelta7d: -1,
    activeDelta7d: -2,
    successProbabilityDelta1d: -0.02,
    successProbabilityDelta7d: -0.14,
    trendDirection: "declining" as const,
    fragile: true,
    trendReason: "Two testers went dark this week.",
    nudgesSent: { confirm: 1, store: 3, inactive: 2, closing: 0 },
    bouncedCount: 0,
  };

  it("round-trips a snapshot: booleans as 0|1, dates as ms-epoch, the nudge tally as JSON", () => {
    const row = TestersCohortSnapshot.encode(snapshot);
    expect(row.meetsTarget).toBe(1);
    expect(row.backfilled).toBe(0);
    expect(row.fragile).toBe(1);
    expect(row.computedAt).toBe(AT.getTime());
    expect(typeof row.nudgesSent).toBe("string");
    expect(TestersCohortSnapshot.parse(row)).toEqual(snapshot);
  });

  it("keeps the day key a plain YYYY-MM-DD string rather than a timestamp", () => {
    // Day arithmetic and the unique index are then exact, with no timezone left in the value to
    // disagree about — which is the whole reason the clock counts in UTC and says so.
    const row = TestersCohortSnapshot.encode(snapshot);
    expect(row.snapshotOn).toBe("2026-06-10");
    expect(() => TestersCohortSnapshot.parse({ ...row, snapshotOn: "2026-06-10T00:00:00Z" })).toThrow();
  });

  it("allows a null forecast, because 'we do not know' has to be representable", () => {
    const unknown = {
      ...snapshot,
      successProbability: null,
      successProbabilityLow: null,
      successProbabilityHigh: null,
      probabilityHoldWindow: null,
      confidence: null,
      basis: "no_observable_signal" as const,
    };
    expect(TestersCohortSnapshot.parse(TestersCohortSnapshot.encode(unknown))).toEqual(unknown);
  });

  describe("the schemas carry the value rules, because one schema per table is the table definition", () => {
    /**
     * These were `CHECK` constraints in the migration. Restating a rule in SQL that the schema already
     * declares buys a second source of truth that can drift from the first, and it fails as a raw
     * `CHECK constraint failed` out of Kysely — no action line for a human, no `--json` error object for
     * an agent. The rules live in Zod and are enforced on `encode` as well as `parse`, which is the
     * boundary every write already crosses.
     */

    const impossibleBase = {
      id: "c-1",
      name: "closed-test",
      targetPlatform: "android" as const,
      targetSize: 12,
      windowDays: 14,
      maxRosterSize: 100,
      storeOptInUrl: null,
      resetPolicy: "reset" as const,
      closedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };

    it("refuses a target larger than the roster cap, on the way in and on the way out", () => {
      // The one rule that spans two fields, so the only one a field schema could not carry alone. A
      // cohort that can never reach target is an author error; the symptom otherwise is a forecast that
      // is quietly meaningless rather than a write that failed.
      const impossible = { ...impossibleBase, targetSize: 200, maxRosterSize: 100 };
      expect(() => TestersCohort.encode(impossible)).toThrow(/can never reach target/);
      expect(() => TestersCohort.parse(TestersCohort.encode(impossibleBase as never))).not.toThrow();
    });

    it("refuses a zero or negative target, window or cap", () => {
      for (const field of ["targetSize", "windowDays", "maxRosterSize"] as const) {
        expect(() => TestersCohort.encode({ ...impossibleBase, [field]: 0 }), field).toThrow();
        expect(() => TestersCohort.encode({ ...impossibleBase, [field]: -1 }), field).toThrow();
      }
    });

    it("refuses a platform or reset policy outside the enum", () => {
      expect(() => TestersCohort.encode({ ...impossibleBase, targetPlatform: "windows" as never })).toThrow();
      expect(() => TestersCohort.encode({ ...impossibleBase, resetPolicy: "rewind" as never })).toThrow();
    });

    it("refuses a member state outside the enum", () => {
      expect(() => TestersMember.parse({ ...TestersMember.encode(member), state: "pending" })).toThrow();
    });

    it("refuses a negative nudge count", () => {
      expect(() => TestersMember.encode({ ...member, nudgeCount: -1 })).toThrow();
    });

    it("refuses an event kind or actor outside the enum", () => {
      const row = TestersEvent.encode(event);
      expect(() => TestersEvent.parse({ ...row, kind: "exploded" })).toThrow();
      expect(() => TestersEvent.parse({ ...row, actor: "robot" })).toThrow();
      expect(() => TestersEvent.parse(row)).not.toThrow();
    });

    it("refuses a probability or a coverage outside [0,1]", () => {
      // A probability above its own axis is a bug in the projection rather than bad input, and it would
      // otherwise surface as a chart line above the top of the chart.
      expect(() => TestersCohortSnapshot.encode({ ...snapshot, successProbability: 1.5 })).toThrow();
      expect(() => TestersCohortSnapshot.encode({ ...snapshot, successProbability: -0.1 })).toThrow();
      expect(() => TestersCohortSnapshot.encode({ ...snapshot, observedCoverage: 1.5 })).toThrow();
    });

    it("but allows a null forecast, because `we do not know` has to be storable", () => {
      expect(() => TestersCohortSnapshot.encode({ ...snapshot, successProbability: null })).not.toThrow();
    });
  });
});
