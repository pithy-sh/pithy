// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { TestersCohort } from "../data/cohort";
import { TESTERS_COHORTS_TABLE, testersDatabase } from "../data/tables";
import { testers_0001_cohorts } from "../migrations/0001_cohorts";
import { listEvents, listMembers } from "./read";
import {
  confirmOptIn,
  createCohort,
  findMemberByEmail,
  findMemberByToken,
  inviteMember,
  lapseMember,
  recordAccepted,
  recordNudge,
  removeMember,
  requireMember,
  resendInvite,
  type WriteDeps,
} from "./write";

/**
 * The write path against real D1.
 *
 * Every guarantee here is a constraint the database enforces or a sequence the code must get right, and
 * both are things a mock would only agree with. The idempotency tests matter most: a confirmation link
 * is followed from an email client, and email clients prefetch, scanners follow, and people click twice
 * when a page is slow — so "a second visit changes nothing" is the difference between a working cohort
 * and a streak that silently resets on ordinary user behavior.
 */

const COHORT_ID = "cohort-1";
const NOW = new Date("2026-06-10T12:00:00.000Z");

let sequence = 0;
const deps = (now: Date = NOW): WriteDeps => ({
  db: testersDatabase(env.DB),
  now,
  newId: () => `generated-${++sequence}`,
});

beforeEach(async () => {
  const untyped = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  for (const table of [
    "pithy_testers_cohort_snapshots",
    "pithy_testers_events",
    "pithy_testers_members",
    "pithy_testers_cohorts",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await testers_0001_cohorts.up(untyped);
  sequence = 0;

  const row = TestersCohort.encode({
    id: COHORT_ID,
    name: "closed-test",
    targetPlatform: "android",
    // A tiny cohort, so the roster-cap tests can actually reach the cap. The migration's CHECK refuses
    // a target larger than the cap, so both move together.
    targetSize: 2,
    windowDays: 14,
    maxRosterSize: 3,
    storeOptInUrl: "https://play.google.com/apps/testing/com.example.app",
    resetPolicy: "reset",
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await testersDatabase(env.DB)
    .insertInto(TESTERS_COHORTS_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side.
    .values(row as any)
    .execute();
});

async function invite(email: string, maxRosterSize = 3) {
  return inviteMember(deps(), { cohortId: COHORT_ID, email, maxRosterSize });
}

describe("inviting", () => {
  test("creates a member and the event it is projected from", async () => {
    const { member, created } = await invite("ada@example.com");
    expect(created).toBe(true);
    expect(member.state).toBe("invited");
    const events = await listEvents(testersDatabase(env.DB), COHORT_ID);
    expect(events.map((event) => event.kind)).toEqual(["invited"]);
  });

  test("lowercases the address, because it is the join key to the user record", async () => {
    const { member } = await invite("Ada@Example.COM");
    expect(member.email).toBe("ada@example.com");
    expect(await findMemberByEmail(testersDatabase(env.DB), COHORT_ID, "ADA@EXAMPLE.COM")).toBeDefined();
  });

  test("refuses an address already on the roster rather than resetting their dates", async () => {
    // Silently re-inviting an opted-in tester would overwrite `invitedAt` and move the date the streak
    // is measured from — the one number this whole capability exists to get right.
    await invite("ada@example.com");
    await expect(invite("ada@example.com")).rejects.toThrow(/already on this cohort/i);
  });

  test("refuses once the roster is at its cap", async () => {
    await invite("a@example.com");
    await invite("b@example.com");
    await invite("c@example.com");
    await expect(invite("d@example.com")).rejects.toThrow(/roster is full/i);
  });

  test("a removed member is revived under the same id, keeping their history attached to one person", async () => {
    const first = await invite("ada@example.com");
    await removeMember(deps(), first.member.id);
    const second = await invite("ada@example.com");
    expect(second.created).toBe(false);
    expect(second.member.id).toBe(first.member.id);
    expect(second.member.state).toBe("invited");
    expect(second.member.lapsedAt).toBeNull();
    // Four events on one member: invited, removed, invited — history intact rather than fragmented
    // across two rows.
    const events = await listEvents(testersDatabase(env.DB), COHORT_ID);
    expect(events.map((event) => event.kind)).toEqual(["invited", "removed", "invited"]);
  });

  test("a removed member does not count against the cap", async () => {
    // Otherwise a cohort that churned through people could never be topped up.
    await invite("a@example.com");
    await invite("b@example.com");
    const third = await invite("c@example.com");
    await removeMember(deps(), third.member.id);
    await expect(invite("d@example.com")).resolves.toBeDefined();
  });
});

describe("confirming an opt-in", () => {
  test("records the date and moves the state", async () => {
    const { member } = await invite("ada@example.com");
    const result = await confirmOptIn(deps(), member.id);
    expect(result.firstTime).toBe(true);
    expect(result.member.state).toBe("opted_in");
    expect(result.member.optedInAt).toEqual(NOW);
  });

  test("a second visit is idempotent and does not move the date", async () => {
    // The failure this prevents: a prefetching mail client, a link scanner, or a double-click would
    // otherwise reset the streak to zero on entirely ordinary behavior.
    const { member } = await invite("ada@example.com");
    await confirmOptIn(deps(), member.id);
    const later = new Date("2026-06-20T12:00:00.000Z");
    const second = await confirmOptIn(deps(later), member.id);
    expect(second.firstTime).toBe(false);
    expect(second.member.optedInAt).toEqual(NOW);
    // And no second event, so a replay cannot bend the clock either.
    const events = await listEvents(testersDatabase(env.DB), COHORT_ID);
    expect(events.filter((event) => event.kind === "opted_in")).toHaveLength(1);
  });

  test("clears a stale bounce, because they visibly received mail at that address", async () => {
    const { member } = await invite("ada@example.com");
    const db = testersDatabase(env.DB);
    await db
      .updateTable("pithyTestersMembers")
      // biome-ignore lint/suspicious/noExplicitAny: partial of the schema's z.input side.
      .set({ unreachable: 1 } as any)
      .where("id", "=", member.id)
      .execute();
    const result = await confirmOptIn(deps(), member.id);
    expect(result.member.unreachable).toBe(false);
  });

  test("re-confirming after a lapse starts a fresh streak", async () => {
    const { member } = await invite("ada@example.com");
    await confirmOptIn(deps(), member.id);
    await lapseMember(deps(new Date("2026-06-12T12:00:00.000Z")), member.id);
    const again = new Date("2026-06-15T12:00:00.000Z");
    const result = await confirmOptIn(deps(again), member.id);
    expect(result.firstTime).toBe(true);
    expect(result.member.optedInAt).toEqual(again);
    expect(result.member.lapsedAt).toBeNull();
  });
});

describe("lapsing and removing", () => {
  test("lapsing is idempotent and attributed to the tester", async () => {
    const { member } = await invite("ada@example.com");
    await confirmOptIn(deps(), member.id);
    await lapseMember(deps(), member.id);
    await lapseMember(deps(), member.id);
    const events = await listEvents(testersDatabase(env.DB), COHORT_ID);
    const lapses = events.filter((event) => event.kind === "lapsed");
    expect(lapses).toHaveLength(1);
    expect(lapses[0]?.actor).toBe("tester");
  });

  test("removal is attributed to the developer and can carry a reason", async () => {
    const { member } = await invite("ada@example.com");
    await removeMember(deps(), member.id, "duplicate address");
    const events = await listEvents(testersDatabase(env.DB), COHORT_ID);
    const removal = events.find((event) => event.kind === "removed");
    expect(removal?.actor).toBe("developer");
    expect(removal?.metadata.reason).toBe("duplicate address");
  });
});

describe("acceptance and outreach", () => {
  test("acceptance is recorded once and never walks an opted-in tester backwards", async () => {
    const { member } = await invite("ada@example.com");
    await recordAccepted(deps(), member.id);
    expect((await requireMember(testersDatabase(env.DB), member.id)).state).toBe("accepted");
    await confirmOptIn(deps(), member.id);
    await recordAccepted(deps(), member.id);
    expect((await requireMember(testersDatabase(env.DB), member.id)).state).toBe("opted_in");
  });

  test("a resend moves only the last-invited date, never the first", async () => {
    // `invitedAt` anchors every latency statistic the forecast computes; resetting it on a resend would
    // make conversion look instantaneous.
    const { member } = await invite("ada@example.com");
    const later = new Date("2026-06-14T12:00:00.000Z");
    const resent = await resendInvite(deps(later), member.id);
    expect(resent.invitedAt).toEqual(NOW);
    expect(resent.lastInvitedAt).toEqual(later);
  });

  test("a nudge stamps the cooldown at enqueue and records its provenance", async () => {
    // Stamped at enqueue rather than at delivery: a cooldown waiting for the send Workflow would leave
    // a window in which a retried request mails the same tester twice.
    const { member } = await invite("ada@example.com");
    await recordNudge(deps(), { memberId: member.id, nudgeKind: "confirm", jobId: "job-1", copySource: "supplied" });
    const updated = await requireMember(testersDatabase(env.DB), member.id);
    expect(updated.lastNudgedAt).toEqual(NOW);
    expect(updated.nudgeCount).toBe(1);
    const event = (await listEvents(testersDatabase(env.DB), COHORT_ID)).find((e) => e.kind === "nudged");
    expect(event?.metadata.nudge).toEqual({ nudgeKind: "confirm", jobId: "job-1", copySource: "supplied" });
  });

  test("a nudge never changes roster state", async () => {
    // Outreach is history, not membership. If nudging could move anybody, the count would stop being a
    // record of who confirmed.
    const { member } = await invite("ada@example.com");
    await confirmOptIn(deps(), member.id);
    await recordNudge(deps(), { memberId: member.id, nudgeKind: "inactive", jobId: "job-2", copySource: "default" });
    expect((await requireMember(testersDatabase(env.DB), member.id)).state).toBe("opted_in");
  });
});

describe("reading back", () => {
  test("the roster lists members in the order they were invited", async () => {
    await invite("a@example.com");
    await invite("b@example.com");
    const roster = await listMembers(testersDatabase(env.DB), COHORT_ID);
    expect(roster.map((member) => member.email)).toEqual(["a@example.com", "b@example.com"]);
  });

  test("a missing member raises the capability's own 404 rather than returning undefined", async () => {
    await expect(requireMember(testersDatabase(env.DB), "nope")).rejects.toMatchObject({
      payload: { code: "testers/member_not_found" },
    });
  });
});

describe("guarantees the review found missing", () => {
  test("the roster cap applies to a revival, not only to a new member", async () => {
    // The bypass: remove someone, refill the cap with a replacement, then re-invite the removed person.
    // The cap check used to sit inside `if (!existing)`, so the revival never counted and the cohort
    // ended up over its own advertised cap.
    await invite("a@example.com");
    await invite("b@example.com");
    const third = await invite("c@example.com");
    await removeMember(deps(), third.member.id);
    await invite("d@example.com"); // refills the cap: 3 live
    await expect(invite("c@example.com")).rejects.toThrow(/roster is full/i);
  });

  test("answering resets the unanswered-nudge counter", async () => {
    // It feeds a penalty whose field is named for probes that went *unanswered*. Left as a lifetime
    // total, a tester who did everything right kept losing points for messages they had replied to.
    const { member } = await invite("ada@example.com");
    await recordNudge(deps(), { memberId: member.id, nudgeKind: "confirm", jobId: "j1", copySource: "default" });
    expect((await requireMember(testersDatabase(env.DB), member.id)).nudgeCount).toBe(1);
    await recordAccepted(deps(), member.id);
    expect((await requireMember(testersDatabase(env.DB), member.id)).nudgeCount).toBe(0);
  });

  test("opting in resets it too", async () => {
    const { member } = await invite("grace@example.com");
    await recordAccepted(deps(), member.id);
    await recordNudge(deps(), { memberId: member.id, nudgeKind: "store", jobId: "j2", copySource: "default" });
    await confirmOptIn(deps(), member.id);
    expect((await requireMember(testersDatabase(env.DB), member.id)).nudgeCount).toBe(0);
  });

  test("opting out revokes the link, so a replay cannot re-enroll them", async () => {
    // A withdrawal that left the link live meant one prefetch of an older email silently undid it.
    const { member } = await invite("alan@example.com");
    await confirmOptIn(deps(), member.id);
    const before = member.optInToken;
    const lapsed = await lapseMember(deps(), member.id);
    expect(lapsed.firstTime).toBe(true);
    expect(lapsed.member.optInToken).not.toBe(before);
    expect(await findMemberByToken(testersDatabase(env.DB), before)).toBeUndefined();
  });

  test("a repeat opt-out reports that nothing changed, so a replay writes no audit row", async () => {
    const { member } = await invite("ada@example.com");
    await lapseMember(deps(), member.id);
    expect((await lapseMember(deps(), member.id)).firstTime).toBe(false);
  });
});

describe("a cohort is refused rather than half-created", () => {
  test("a store link that is not a store link", async () => {
    // `--store-url` is the only way to set this per cohort, and it reached a bare `text` column
    // unvalidated. A present-but-unusable URL is worse than an absent one: the daily pass reads
    // presence as readiness and mails every accepted tester a link that enrolls nobody with Google,
    // while the opt-in estimate climbs on the way through.
    for (const bad of [
      "http://play.google.com/apps/testing/com.example.app",
      "https://play.google.com.evil.test/apps/testing/x",
      "https://bit.ly/beta",
      "not a url",
    ]) {
      await expect(
        createCohort(deps(), {
          name: `bad-${bad}`,
          targetSize: 12,
          windowDays: 14,
          maxRosterSize: 20,
          targetPlatform: "android",
          storeOptInUrl: bad,
          resetPolicy: "reset",
        }),
      ).rejects.toThrow(/not a store link/);
    }
  });

  test("but null is fine, because the developer supplies it later", async () => {
    const cohort = await createCohort(deps(), {
      name: "later",
      targetSize: 12,
      windowDays: 14,
      maxRosterSize: 20,
      targetPlatform: "android",
      storeOptInUrl: null,
      resetPolicy: "reset",
    });
    expect(cohort.storeOptInUrl).toBeNull();
  });

  test("a target that cannot fit in the roster cap", async () => {
    // Enforced by the migration's CHECK, which surfaces as `CHECK constraint failed` out of Kysely —
    // not a PithyError, so no action line and no `--json` error object.
    await expect(
      createCohort(deps(), {
        name: "too-tight",
        targetSize: 12,
        windowDays: 14,
        maxRosterSize: 5,
        targetPlatform: "android",
        storeOptInUrl: null,
        resetPolicy: "reset",
      }),
    ).rejects.toThrow(/cannot fit in a roster capped at 5/);
  });
});

describe("a cohort name is taken once", () => {
  test("a repeat is refused by name rather than by constraint", async () => {
    // The unique constraint surfaces as `UNIQUE constraint failed` out of Kysely — not a PithyError,
    // so `withErrorReporting` rethrows it: a stack trace, no action line, and no `--json` error object
    // for an agent driving the CLI.
    const input = {
      name: "second-cohort",
      targetSize: 12,
      windowDays: 14,
      maxRosterSize: 20,
      targetPlatform: "android" as const,
      storeOptInUrl: null,
      resetPolicy: "reset" as const,
    };
    await createCohort(deps(), input);
    await expect(createCohort(deps(), input)).rejects.toThrow(/already a cohort called second-cohort/);
  });
});

describe("a withdrawal is the tester's own decision, and it stands", () => {
  test("re-inviting somebody who opted out is refused", async () => {
    // `lapsed` has exactly one producer: the opt-out route the tester followed themselves, having been
    // told "you will not hear from this test again". Reviving them restored the row to `invited` with a
    // fresh token and a zeroed nudge count — and `POST /invite` sends by default, so one call re-mailed
    // somebody who asked to be left alone and restarted the chase against them.
    const invited = await invite("ada@example.com");
    await lapseMember(deps(), invited.member.id);

    await expect(invite("ada@example.com")).rejects.toThrow(/asked to be taken off/);
  });

  test("and the refusal does not depend on how the address was typed", async () => {
    const invited = await invite("Ada@Example.COM");
    await lapseMember(deps(), invited.member.id);
    await expect(invite("ada@example.com")).rejects.toThrow(/asked to be taken off/);
  });

  test("but a developer-removed tester may be invited back, because that was the developer's own act", async () => {
    // Undoing a removal takes nobody's consent away. Undoing a withdrawal does.
    const invited = await invite("grace@example.com");
    await removeMember(deps(), invited.member.id);

    const revived = await invite("grace@example.com");
    expect(revived.created).toBe(false);
    expect(revived.member.state).toBe("invited");
    expect(revived.member.id).toBe(invited.member.id);
  });

  test("a revival keeps `lastNudgedAt`, so remove-then-invite is not a way round the cooldown", async () => {
    // The chase counter restarts — `dueNudge`'s prompt-first rule keys on it. The cooldown clock does
    // not, or a remove-and-re-add cycle would mail immediately somebody who was inside the cooldown a
    // moment before, bypassing by the back door the guard `resend` and `nudge` re-check by hand.
    const invited = await invite("alan@example.com");
    await recordNudge(deps(), {
      memberId: invited.member.id,
      nudgeKind: "confirm",
      jobId: "j-1",
      copySource: "default",
    });
    const nudged = await requireMember(testersDatabase(env.DB), invited.member.id);
    expect(nudged.lastNudgedAt).not.toBeNull();

    await removeMember(deps(), invited.member.id);
    const revived = await invite("alan@example.com");
    expect(revived.member.nudgeCount).toBe(0);
    expect(revived.member.lastNudgedAt?.toISOString()).toBe(nudged.lastNudgedAt?.toISOString());
  });
});
