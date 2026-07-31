// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { describe, expect, test } from "vitest";
import { readClock } from "../clock/replay";
import { TestersConfig } from "../config/config";
import { isOptInTokenShape } from "../crypto/token";
import { TestersCohort } from "../data/cohort";
import { TestersEvent } from "../data/event";
import { TestersMember } from "../data/member";
import { TESTERS_COHORTS_TABLE, TESTERS_EVENTS_TABLE, TESTERS_MEMBERS_TABLE } from "../data/tables";
import { SEED_ANCHOR, testersExampleSeed } from "./example";

/** The seeded rows for one table, as the fixture declares them. */
function group(table: string) {
  const found = testersExampleSeed.d1?.find((entry) => entry.table === table);
  if (!found) throw new Error(`no seed group for ${table}`);
  return found.rows as readonly Record<string, unknown>[];
}

describe("the example seed", () => {
  test("is an example set, never seeded into production", () => {
    expect(testersExampleSeed.example).toBe(true);
    expect(testersExampleSeed.environments).toEqual(["dev", "staging"]);
    expect(testersExampleSeed.environments).not.toContain("production");
  });

  test("sorts after auth, which owns the users its addresses belong to", () => {
    expect(testersExampleSeed.order).toBeGreaterThan(100);
  });

  test("every row re-encodes cleanly, so seeding cannot fail on a shape the schema rejects", () => {
    for (const row of group(TESTERS_COHORTS_TABLE)) {
      expect(() => TestersCohort.parse(TestersCohort.encode(row as never))).not.toThrow();
    }
    for (const row of group(TESTERS_MEMBERS_TABLE)) {
      expect(() => TestersMember.parse(TestersMember.encode(row as never))).not.toThrow();
    }
    for (const row of group(TESTERS_EVENTS_TABLE)) {
      expect(() => TestersEvent.parse(TestersEvent.encode(row as never))).not.toThrow();
    }
  });

  test("every id is fixed, because seeding is INSERT OR IGNORE", () => {
    // A generated id would insert a second copy on every run, and a generated timestamp would make the
    // streak a different number each time the fixture loaded.
    const ids = group(TESTERS_MEMBERS_TABLE).map((row) => row.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("uses the shared demo cast, so the seeded data connects across capabilities", () => {
    const emails = group(TESTERS_MEMBERS_TABLE).map((row) => row.email as string);
    expect(emails.sort()).toEqual([EXAMPLE_ADA.email, EXAMPLE_ALAN.email, EXAMPLE_GRACE.email].sort());
  });

  test("seeds a cohort in trouble rather than three happy testers", () => {
    // The interesting demo is the state the capability exists to make visible. A green dashboard would
    // teach nobody what the columns mean.
    const states = group(TESTERS_MEMBERS_TABLE).map((row) => row.state as string);
    expect(states).toContain("opted_in");
    expect(states).toContain("invited"); // somebody who never responded
  });

  test("a tester who has gone quiet is still opted in, because silence never moves the count", () => {
    // Grace is the early-warning case. If the fixture lapsed her, it would teach exactly the wrong
    // model — Google counts opt-ins, not engagement.
    const grace = group(TESTERS_MEMBERS_TABLE).find((row) => row.email === EXAMPLE_GRACE.email);
    expect(grace?.state).toBe("opted_in");
    expect(grace?.lapsedAt).toBeNull();
  });

  test("seeds the event log, so the clock replays to something rather than to zero", () => {
    // Member rows are a projection. A fixture with rows and no history would show a roster whose clock
    // reads day zero, which is the one thing the demo needs to get right.
    const events = group(TESTERS_EVENTS_TABLE).map((row) => TestersEvent.parse(TestersEvent.encode(row as never)));
    const cohort = TestersCohort.parse(TestersCohort.encode(group(TESTERS_COHORTS_TABLE)[0] as never));

    const clock = readClock(
      {
        createdAt: cohort.createdAt,
        targetSize: cohort.targetSize,
        windowDays: cohort.windowDays,
        resetPolicy: cohort.resetPolicy,
      },
      events,
      SEED_ANCHOR,
    );
    // Two confirmed against a target of twelve: short, on purpose, so the fixture shows what "not there
    // yet" looks like.
    expect(clock.estimatedOptedInCount).toBe(2);
    expect(clock.meetsTarget).toBe(false);
    expect(clock.headroom).toBe(-10);
  });

  test("every seeded event belongs to a seeded member", () => {
    const memberIds = new Set(group(TESTERS_MEMBERS_TABLE).map((row) => row.id));
    for (const event of group(TESTERS_EVENTS_TABLE)) {
      expect(memberIds.has(event.memberId)).toBe(true);
    }
  });
});

describe("the seeded tokens are usable", () => {
  test("every one satisfies the shape the routes actually accept", () => {
    // A fixture that fails the validator makes every seeded tester's link 400 — a demo that looks
    // correct in the database and breaks the moment anyone clicks it.
    for (const row of group(TESTERS_MEMBERS_TABLE)) {
      expect(isOptInTokenShape(row.optInToken as string), row.optInToken as string).toBe(true);
    }
  });

  test("and they are distinct, because the token is the whole credential", () => {
    const tokens = group(TESTERS_MEMBERS_TABLE).map((row) => row.optInToken as string);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  test("and every one is still inside the link lifetime, so the demo survives being clicked", () => {
    // The shape check above proves the validator accepts the string. It says nothing about the row —
    // and `memberFor` bounds a link by the age of the invitation that carried it, which a fixed
    // calendar date fails the moment the fixture is a month old. Alan is seeded `invited`, so the
    // first `pithy testers run` mails a real email carrying whatever this link is worth.
    const ttlDays = TestersConfig.parse({}).optInLinkTtlDays;
    for (const row of group(TESTERS_MEMBERS_TABLE)) {
      const ageDays = (Date.now() - (row.lastInvitedAt as Date).getTime()) / 86_400_000;
      expect(ageDays, row.email as string).toBeLessThan(ttlDays);
      expect(ageDays).toBeGreaterThanOrEqual(0);
    }
  });

  test("the seeded cohort carries a store opt-in link, so the second email has somewhere to point", () => {
    const cohort = group(TESTERS_COHORTS_TABLE)[0] as { storeOptInUrl: string | null };
    expect(cohort.storeOptInUrl).toMatch(/^https:\/\/play\.google\.com\/apps\/testing\//);
  });
});
