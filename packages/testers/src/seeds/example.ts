// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { TestersCohort } from "../data/cohort";
import { TestersEvent } from "../data/event";
import { TestersMember } from "../data/member";
import { TESTERS_COHORTS_TABLE, TESTERS_EVENTS_TABLE, TESTERS_MEMBERS_TABLE } from "../data/tables";

/**
 * A worked example: one cohort, three testers, and a roster that is deliberately *not* healthy.
 *
 * The interesting demo is a cohort in trouble, because that is the state this capability exists to make
 * visible. Ada confirmed and is testing. Grace confirmed and has gone quiet. Alan was invited a week ago
 * and has never responded. Seeding three happy testers would show a green dashboard and teach nobody
 * what the columns mean.
 *
 * Fixed ids and a fixed clock throughout: seeding is `INSERT OR IGNORE`, so a generated id would insert
 * a second copy on every run, and a generated timestamp would make the streak a different number every
 * time the fixture loaded.
 */

/** Where this set sorts in the project's seed registry. After auth (100), which owns these users. */
const TESTERS_EXAMPLE_SEED_ORDER = 260;

/** The cohort every fixture row hangs off. */
const COHORT_ID = "3f0c2b18-9a4d-4e77-b5c1-2d8e6f0a1b93";

/** Ada: confirmed, and actually testing. */
const ADA_MEMBER_ID = "8c1d5e20-7b39-4a62-9f04-6e2a1c7d3b85";
/** Grace: confirmed, then went quiet. The early-warning case. */
const GRACE_MEMBER_ID = "b7e94a13-2c68-4d05-8a71-9f3b0e6c4d27";
/** Alan: invited a week ago, never responded. The conversion case. */
const ALAN_MEMBER_ID = "d2a86f47-5e10-4b93-a6c8-31f7b9d0e582";

/**
 * Fixed confirmation tokens.
 *
 * Real ones are 32 bytes of CSPRNG; these are fixed for the same reason the ids are, because seeding is
 * `INSERT OR IGNORE` and a generated value would insert a second copy on every run. They are obviously
 * not random, which is the point — a fixture token should never be mistaken for a live credential.
 *
 * They are exactly 43 base64url characters, because that is what `OPT_IN_TOKEN_PATTERN` accepts and the
 * route validator refuses anything else. A fixture that fails the shape check makes every seeded
 * tester's link 400 — a demo that looks fine until somebody clicks it.
 */
const ADA_OPT_IN_TOKEN = "seed-ada-opt-in-token----------------------";
const GRACE_OPT_IN_TOKEN = "seed-grace-opt-in-token--------------------";
const ALAN_OPT_IN_TOKEN = "seed-alan-opt-in-token---------------------";

/**
 * The fixture's timeline, anchored to the day it is seeded rather than to a fixed calendar date.
 *
 * The offsets are fixed, so the demo state is deterministic — nine days into a fourteen-day window,
 * two confirmed, one silent — and that is what determinism has to mean here. Fixed *absolute* dates
 * looked deterministic and were quietly wrong: `memberFor` bounds a link by the age of the invitation
 * that carried it, so from thirty days after 2026-01-01 every seeded tester's link answered 400. Alan
 * is seeded `invited` with no nudges recorded, so the first `pithy testers run` against a seeded
 * database mails a real email carrying a dead link. A demo that breaks the moment anyone clicks it is
 * the exact failure the token comment above says these fixtures exist to avoid.
 *
 * Read once at module load, so every row in one seed run shares one anchor. Re-seeding cannot shift
 * them either: seeding is `INSERT OR IGNORE`, so the rows keep the timeline they were first written
 * with.
 */
export const SEED_ANCHOR = new Date();

/** Days before the anchor, as a date. */
function daysAgo(days: number): Date {
  return new Date(SEED_ANCHOR.getTime() - days * 86_400_000);
}

/** When the cohort was created — nine days in, so the window is live and the demo has history. */
const CREATED_AT = daysAgo(9);
/** When the two who confirmed did so. */
const OPTED_IN_AT = daysAgo(8);
/** When Alan was invited and has been ignoring it since. Inside the link TTL, so his link works. */
const INVITED_AT = daysAgo(9);

export const testersExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: TESTERS_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", TESTERS_COHORTS_TABLE, TestersCohort, [
      {
        id: COHORT_ID,
        name: "closed-test",
        targetPlatform: "android",
        // Google Play's own numbers, so the fixture demonstrates the requirement rather than a toy.
        targetSize: 12,
        windowDays: 14,
        maxRosterSize: 100,
        // The store's own opt-in page, which is where a tester actually enrolls. Fixed, and obviously a
        // placeholder package name, so nobody mistakes the fixture for a real app.
        storeOptInUrl: "https://play.google.com/apps/testing/com.example.app",
        resetPolicy: "reset",
        closedAt: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ]),
    d1SeedGroup("app", TESTERS_MEMBERS_TABLE, TestersMember, [
      {
        id: ADA_MEMBER_ID,
        cohortId: COHORT_ID,
        optInToken: ADA_OPT_IN_TOKEN,
        email: EXAMPLE_ADA.email,
        name: EXAMPLE_ADA.name,
        state: "opted_in",
        invitedAt: INVITED_AT,
        acceptedAt: OPTED_IN_AT,
        optedInAt: OPTED_IN_AT,
        lapsedAt: null,
        lastInvitedAt: INVITED_AT,
        lastNudgedAt: null,
        nudgeCount: 0,
        unreachable: false,
        createdAt: INVITED_AT,
        updatedAt: OPTED_IN_AT,
      },
      {
        id: GRACE_MEMBER_ID,
        cohortId: COHORT_ID,
        optInToken: GRACE_OPT_IN_TOKEN,
        email: EXAMPLE_GRACE.email,
        name: EXAMPLE_GRACE.name,
        // Still `opted_in`, and that is the point: going quiet never moves anyone off the count, because
        // Google counts opt-ins rather than engagement. Grace shows up as a health problem, not as a
        // missing tester.
        state: "opted_in",
        invitedAt: INVITED_AT,
        acceptedAt: OPTED_IN_AT,
        optedInAt: OPTED_IN_AT,
        lapsedAt: null,
        lastInvitedAt: INVITED_AT,
        lastNudgedAt: null,
        nudgeCount: 1,
        unreachable: false,
        createdAt: INVITED_AT,
        updatedAt: OPTED_IN_AT,
      },
      {
        id: ALAN_MEMBER_ID,
        cohortId: COHORT_ID,
        optInToken: ALAN_OPT_IN_TOKEN,
        email: EXAMPLE_ALAN.email,
        name: EXAMPLE_ALAN.name,
        state: "invited",
        invitedAt: INVITED_AT,
        acceptedAt: null,
        optedInAt: null,
        lapsedAt: null,
        lastInvitedAt: INVITED_AT,
        lastNudgedAt: null,
        nudgeCount: 0,
        unreachable: false,
        createdAt: INVITED_AT,
        updatedAt: INVITED_AT,
      },
    ]),
    d1SeedGroup("app", TESTERS_EVENTS_TABLE, TestersEvent, [
      // The events are the source of truth, so the fixture seeds them too: a roster with member rows
      // and no history would replay to an empty clock, and the demo's whole point is the clock.
      {
        id: 1,
        cohortId: COHORT_ID,
        memberId: ADA_MEMBER_ID,
        kind: "invited",
        actor: "developer",
        occurredAt: INVITED_AT,
        metadata: {},
        createdAt: INVITED_AT,
      },
      {
        id: 2,
        cohortId: COHORT_ID,
        memberId: ADA_MEMBER_ID,
        kind: "opted_in",
        actor: "tester",
        occurredAt: OPTED_IN_AT,
        metadata: {},
        createdAt: OPTED_IN_AT,
      },
      {
        id: 3,
        cohortId: COHORT_ID,
        memberId: GRACE_MEMBER_ID,
        kind: "invited",
        actor: "developer",
        occurredAt: INVITED_AT,
        metadata: {},
        createdAt: INVITED_AT,
      },
      {
        id: 4,
        cohortId: COHORT_ID,
        memberId: GRACE_MEMBER_ID,
        kind: "opted_in",
        actor: "tester",
        occurredAt: OPTED_IN_AT,
        metadata: {},
        createdAt: OPTED_IN_AT,
      },
      {
        id: 5,
        cohortId: COHORT_ID,
        memberId: ALAN_MEMBER_ID,
        kind: "invited",
        actor: "developer",
        occurredAt: INVITED_AT,
        metadata: {},
        createdAt: INVITED_AT,
      },
    ]),
  ],
});
