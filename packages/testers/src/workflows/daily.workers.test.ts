// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { dayKey } from "../clock/days";
import { TestersConfig } from "../config/config";
import { NudgeKind } from "../data/enums";
import { testersDatabase } from "../data/tables";
import { testers_0001_cohorts } from "../migrations/0001_cohorts";
import type { EnqueueNudge } from "../nudge/send";
import { listSnapshots, snapshotOn } from "../roster/read";
import {
  closeCohort,
  confirmOptIn,
  createCohort,
  findMemberByToken,
  inviteMember,
  lapseMember,
  markUnreachable,
  recordAccepted,
  removeMember,
  requireMember,
  type WriteDeps,
} from "../roster/write";
import { type DailyPassDeps, dueNudge, runCohortPass, runDailyPass } from "./daily";

/**
 * The daily pass end to end against real D1.
 *
 * The properties worth proving here are all about re-running: a Workflow step can retry, a cron can
 * overlap its own previous fire, and an operator can run the pass by hand on a day it has already
 * covered. Every one of those has to change nothing it has already done, and the only way to know is
 * to actually do it twice against a real database.
 */

const CONFIG = TestersConfig.parse({ baseUrl: "https://api.example.test" });
const DAY_ONE = new Date("2026-06-01T05:00:00.000Z");

let sequence = 0;

function write(now: Date): WriteDeps {
  return { db: testersDatabase(env.DB), now, newId: () => `id-${++sequence}` };
}

/** Every nudge the pass enqueued, so a test can assert what went out without a mail server. */
let sent: { to: string; payload: unknown }[] = [];

function deps(now: Date, overrides: Partial<DailyPassDeps> = {}): DailyPassDeps {
  const enqueue: EnqueueNudge = async (input) => {
    sent.push({ to: input.to, payload: input.payload });
    return { jobId: `job-${sent.length}`, status: "pending" };
  };
  return {
    db: testersDatabase(env.DB),
    d1: env.DB,
    config: CONFIG,
    now,
    newId: () => `id-${++sequence}`,
    enqueue,
    // Most tests here pass no suppression database, so the reconciliation is a no-op and every other
    // assertion is independent of a table they do not stand up. The reconciliation has its own block at
    // the foot of this file, which stands the table up and passes it in.
    suppressionD1: undefined,
    optOutLinkFor: (member) => `https://api.example.test/testers/opt-out/${member.optInToken}`,
    linkFor: (kind, member) =>
      kind === "confirm"
        ? `https://api.example.test/testers/confirm/${member.optInToken}`
        : kind === "store"
          ? `https://api.example.test/testers/opt-in/${member.optInToken}`
          : undefined,
    ...overrides,
  };
}

async function makeCohort(now = DAY_ONE) {
  return createCohort(write(now), {
    name: `cohort-${++sequence}`,
    targetSize: 2,
    windowDays: 14,
    maxRosterSize: 10,
    targetPlatform: "android",
    storeOptInUrl: "https://play.google.com/apps/testing/com.example.app",
    resetPolicy: "reset",
  });
}

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
  sent = [];
});

describe("the daily pass", () => {
  test("writes one snapshot for the day", async () => {
    const cohort = await makeCohort();
    const result = await runCohortPass(deps(DAY_ONE), cohort.id);
    expect(result.snapshotOn).toBe("2026-06-01");
    const stored = await snapshotOn(testersDatabase(env.DB), cohort.id, "2026-06-01");
    expect(stored?.rosterSize).toBe(0);
    expect(stored?.modelVersion).toBe(CONFIG.modelVersion);
  });

  test("re-running the same day rewrites the row rather than appending a second one", async () => {
    // The property the whole pass rests on: a retried Workflow step, a manual backfill, and two crons
    // firing a second apart must all leave one point on the chart. A duplicated day would put two
    // points at one x-coordinate and every delta computed afterwards would be wrong.
    const cohort = await makeCohort();
    await runCohortPass(deps(DAY_ONE), cohort.id);
    await runCohortPass(deps(new Date("2026-06-01T23:00:00.000Z")), cohort.id);
    const snapshots = await listSnapshots(testersDatabase(env.DB), cohort.id, 10);
    expect(snapshots.filter((entry) => entry.snapshotOn === "2026-06-01")).toHaveLength(1);
  });

  test("the snapshot records the settled position, after the day's transitions", async () => {
    const cohort = await makeCohort();
    const ada = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "ada@example.com",
      maxRosterSize: 10,
    });
    await confirmOptIn(write(DAY_ONE), ada.member.id);
    const result = await runCohortPass(deps(DAY_ONE), cohort.id);
    expect(result.estimatedOptedInCount).toBe(1);
    const stored = await snapshotOn(testersDatabase(env.DB), cohort.id, "2026-06-01");
    expect(stored?.estimatedOptedInCount).toBe(1);
    expect(stored?.rosterSize).toBe(1);
  });

  test("sends the first confirmation promptly, so a CLI-added tester is actually told", async () => {
    // Without this the capability only appears to work without a dashboard: a tester added from the
    // terminal would sit on the roster for two days before anything reached them.
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "ada@example.com", maxRosterSize: 10 });
    const result = await runCohortPass(deps(DAY_ONE), cohort.id);
    expect(result.nudged.confirm).toBe(1);
    expect(sent[0]?.to).toBe("ada@example.com");
  });

  test("the cooldown stops a second pass on the same day mailing anyone twice", async () => {
    // The cooldown is checked inside the pass rather than trusted to its caller, because the pass IS a
    // caller — a cron that fired twice would otherwise mail the same twelve people twice.
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "ada@example.com", maxRosterSize: 10 });
    await runCohortPass(deps(DAY_ONE), cohort.id);
    const second = await runCohortPass(deps(new Date("2026-06-01T17:00:00.000Z")), cohort.id);
    expect(second.nudged.confirm).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test("the first nudge carries the will-you-test link, not the store one", async () => {
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "ada@example.com", maxRosterSize: 10 });
    await runCohortPass(deps(DAY_ONE), cohort.id);
    const payload = sent[0]?.payload as { ctaUrl?: string } | undefined;
    expect(payload?.ctaUrl).toContain("/testers/confirm/");
  });

  test("no link builder means no confirmation nudge, rather than a nag with nothing to click", async () => {
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "ada@example.com", maxRosterSize: 10 });
    const result = await runCohortPass(deps(DAY_ONE, { linkFor: undefined }), cohort.id);
    expect(result.nudged.confirm).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("with no email seam the pass still advances state and records the day", async () => {
    // Which is what makes `pithy testers run` useful from a terminal that holds no sending domain.
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "ada@example.com", maxRosterSize: 10 });
    const result = await runCohortPass(deps(DAY_ONE, { enqueue: undefined }), cohort.id);
    expect(result.nudged.confirm).toBe(0);
    expect(await snapshotOn(testersDatabase(env.DB), cohort.id, "2026-06-01")).toBeDefined();
  });

  test("every nudge carries the honesty note, so a tester is not misled either", async () => {
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "ada@example.com", maxRosterSize: 10 });
    await runCohortPass(deps(DAY_ONE), cohort.id);
    const payload = sent[0]?.payload as { footnote?: string; paragraphs?: string[] } | undefined;
    expect(payload?.footnote).toMatch(/no API exposes it/i);
    // And the body is an array of plain strings — the property that makes supplied copy safe to render.
    expect(Array.isArray(payload?.paragraphs)).toBe(true);
  });

  test("the trend fills in as days accumulate, and is unknown before three of them", async () => {
    const cohort = await makeCohort();
    const ada = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "ada@example.com",
      maxRosterSize: 10,
    });
    await confirmOptIn(write(DAY_ONE), ada.member.id);

    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];
    for (const day of days) await runCohortPass(deps(new Date(`${day}T05:00:00.000Z`)), cohort.id);

    const series = await listSnapshots(testersDatabase(env.DB), cohort.id, 10);
    expect(series.map((entry) => entry.snapshotOn)).toEqual(days);
    // Two points make a straight line through noise; the rule says so rather than drawing it.
    expect(series[0]?.trendDirection).toBe("unknown");
    expect(series[1]?.trendDirection).toBe("unknown");
    expect(series[3]?.trendDirection).not.toBe("unknown");
    // The one-day delta appears as soon as there is a yesterday to compare against.
    expect(series[0]?.optedInDelta1d).toBeNull();
    expect(series[1]?.optedInDelta1d).toBe(0);
  });

  test("a lapse mid-window shows up as a reset on the day it happened", async () => {
    // The failure the whole capability exists to make visible, drawn on the chart where it occurred.
    const cohort = await makeCohort();
    const roster = [];
    for (const email of ["a@example.com", "b@example.com"]) {
      const invited = await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email, maxRosterSize: 10 });
      await confirmOptIn(write(DAY_ONE), invited.member.id);
      roster.push(invited.member);
    }
    await runCohortPass(deps(DAY_ONE), cohort.id);
    await runCohortPass(deps(new Date("2026-06-02T05:00:00.000Z")), cohort.id);

    const breakDay = new Date("2026-06-03T05:00:00.000Z");
    await lapseMember(write(breakDay), roster[0]?.id as string);
    await runCohortPass(deps(breakDay), cohort.id);

    const series = await listSnapshots(testersDatabase(env.DB), cohort.id, 10);
    const second = series.find((entry) => entry.snapshotOn === "2026-06-02");
    const third = series.find((entry) => entry.snapshotOn === "2026-06-03");
    expect(second?.meetsTarget).toBe(true);
    expect(second?.estimatedHeldDays).toBe(2);
    expect(third?.meetsTarget).toBe(false);
    expect(third?.resetToday).toBe(true);
    expect(third?.estimatedHeldDays).toBe(0);
  });

  test("runs every open cohort and skips the closed ones", async () => {
    const open = await makeCohort();
    const closed = await makeCohort();
    await testersDatabase(env.DB)
      .updateTable("pithyTestersCohorts")
      // biome-ignore lint/suspicious/noExplicitAny: partial of the schema's z.input side.
      .set({ closedAt: DAY_ONE.getTime() } as any)
      .where("id", "=", closed.id)
      .execute();
    const results = await runDailyPass(deps(DAY_ONE));
    expect(results.map((entry) => entry.cohortId)).toEqual([open.id]);
  });

  test("prunes snapshots past the retention window", async () => {
    const cohort = await makeCohort();
    await runCohortPass(deps(new Date("2026-06-01T05:00:00.000Z")), cohort.id);
    // A year and a half later, well past the 400-day default.
    const result = await runCohortPass(deps(new Date("2027-12-01T05:00:00.000Z")), cohort.id);
    expect(result.pruned).toBe(1);
    const series = await listSnapshots(testersDatabase(env.DB), cohort.id, 500);
    expect(series.map((entry) => entry.snapshotOn)).toEqual(["2027-12-01"]);
  });
});

describe("which nudge is due", () => {
  const member = {
    state: "invited" as const,
    nudgeCount: 0,
    lastInvitedAt: DAY_ONE,
  };

  test("an unconfirmed tester who has never been contacted is due a confirmation now", () => {
    expect(dueNudge(member as never, { now: DAY_ONE, daysRemaining: 14, lastSeenAt: null, storeReady: true })).toBe(
      "confirm",
    );
  });

  test("an unconfirmed tester already contacted waits before the next chase", () => {
    const chased = { ...member, nudgeCount: 1 };
    expect(
      dueNudge(chased as never, { now: DAY_ONE, daysRemaining: 14, lastSeenAt: null, storeReady: true }),
    ).toBeNull();
    const later = new Date("2026-06-04T05:00:00.000Z");
    expect(dueNudge(chased as never, { now: later, daysRemaining: 14, lastSeenAt: null, storeReady: true })).toBe(
      "confirm",
    );
  });

  test("a confirmed tester near the end of the window gets the closing message, not a complaint", () => {
    // The last thing they hear should not be a grumble about their engagement.
    const optedIn = { ...member, state: "opted_in" as const, nudgeCount: 0 };
    const longDark = new Date("2026-05-01T05:00:00.000Z");
    expect(dueNudge(optedIn as never, { now: DAY_ONE, daysRemaining: 2, lastSeenAt: longDark, storeReady: true })).toBe(
      "closing",
    );
  });

  test("a confirmed tester who has gone quiet mid-window gets the inactivity message", () => {
    const optedIn = { ...member, state: "opted_in" as const, nudgeCount: 0 };
    const quiet = new Date("2026-05-25T05:00:00.000Z");
    expect(dueNudge(optedIn as never, { now: DAY_ONE, daysRemaining: 10, lastSeenAt: quiet, storeReady: true })).toBe(
      "inactive",
    );
  });

  test("a tester we cannot see is never nudged about inactivity", () => {
    // Chasing someone for not signing in, when the app may never ask anyone to sign in, is chasing
    // them for something they did not do wrong.
    const optedIn = { ...member, state: "opted_in" as const, nudgeCount: 0 };
    expect(
      dueNudge(optedIn as never, { now: DAY_ONE, daysRemaining: 10, lastSeenAt: null, storeReady: true }),
    ).toBeNull();
  });

  test("a tester who said yes waits for the store link, and gets it once the developer supplies one", () => {
    // The sequencing the store forces: the opt-in page answers `App not available` until the developer
    // has added that address to the tester list, and the store URL being set is their signal that they
    // have. Sending it early produces a tester who thinks the app is broken.
    const accepted = { ...member, state: "accepted" as const, nudgeCount: 1 };
    const ctx = { now: DAY_ONE, daysRemaining: 14, lastSeenAt: null };
    expect(dueNudge(accepted as never, { ...ctx, storeReady: false })).toBeNull();
    expect(dueNudge(accepted as never, { ...ctx, storeReady: true })).toBe("store");
  });

  test("a lapsed or removed tester is never nudged at all", () => {
    for (const state of ["lapsed", "removed"] as const) {
      expect(
        dueNudge({ ...member, state } as never, { now: DAY_ONE, daysRemaining: 5, lastSeenAt: null, storeReady: true }),
      ).toBeNull();
    }
  });
});

describe("the two-email journey, end to end", () => {
  test("invite → asked → agreed → store link → opted in", async () => {
    // The whole sequence in one test, because each step's correctness depends on the one before it and
    // the order is forced by the store rather than chosen. This is the path a real tester walks.
    const cohort = await makeCohort();
    const invited = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "ada@example.com",
      maxRosterSize: 10,
    });
    const member = invited.member;
    expect(member.optInToken).toHaveLength(43);

    // Day one: the pass asks whether they will test. The store link is NOT sent — they are not on the
    // tester list yet, and it would answer `App not available`.
    const first = await runCohortPass(deps(DAY_ONE), cohort.id);
    expect(first.nudged.confirm).toBe(1);
    expect(first.nudged.store).toBe(0);
    const asked = sent[0]?.payload as { ctaUrl?: string } | undefined;
    expect(asked?.ctaUrl).toContain(`/testers/confirm/${member.optInToken}`);

    // They say yes. Consent, not enrolment — the count must not move.
    const dayTwo = new Date("2026-06-02T05:00:00.000Z");
    await recordAccepted(write(dayTwo), member.id);
    const afterAgreeing = await runCohortPass(deps(dayTwo), cohort.id);
    expect(afterAgreeing.estimatedOptedInCount).toBe(0);

    // Day two's pass sends the store link, now that the cohort has one. Same tester, second message.
    expect(afterAgreeing.nudged.store).toBe(1);
    const linked = sent[1]?.payload as { ctaUrl?: string } | undefined;
    expect(linked?.ctaUrl).toContain(`/testers/opt-in/${member.optInToken}`);

    // They follow it through to the store. Only now does the count move.
    const dayThree = new Date("2026-06-03T05:00:00.000Z");
    await confirmOptIn(write(dayThree), member.id);
    const afterJoining = await runCohortPass(deps(dayThree), cohort.id);
    expect(afterJoining.estimatedOptedInCount).toBe(1);
  });

  test("a cohort with no store link holds the second email rather than sending a dead end", async () => {
    const cohort = await createCohort(write(DAY_ONE), {
      name: "no-store-link",
      targetSize: 2,
      windowDays: 14,
      maxRosterSize: 10,
      targetPlatform: "android",
      storeOptInUrl: null,
      resetPolicy: "reset",
    });
    const invited = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "grace@example.com",
      maxRosterSize: 10,
    });
    await recordAccepted(write(DAY_ONE), invited.member.id);
    const result = await runCohortPass(deps(new Date("2026-06-05T05:00:00.000Z")), cohort.id);
    expect(result.nudged.store).toBe(0);
  });

  test("removing a tester revokes their link, which a signed token could never have done", async () => {
    const cohort = await makeCohort();
    const invited = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "alan@example.com",
      maxRosterSize: 10,
    });
    const before = invited.member.optInToken;
    await removeMember(write(DAY_ONE), invited.member.id);
    const after = await requireMember(testersDatabase(env.DB), invited.member.id);
    expect(after.optInToken).not.toBe(before);
    // And the old token now matches nobody at all — the link in their inbox is dead.
    expect(await findMemberByToken(testersDatabase(env.DB), before)).toBeUndefined();
  });
});

describe("deliverability reconciliation", () => {
  /** Stand up the global suppression table the email capability owns. */
  async function suppressionTable(): Promise<void> {
    await env.DB.exec("DROP TABLE IF EXISTS pithy_email_suppressions");
    await env.DB.prepare(
      `create table pithy_email_suppressions (
        id text primary key, email text unique, reason text, job_id text,
        environment text, detail text, expires_at integer, created_at integer
      )`,
    ).run();
  }

  async function suppress(email: string, expiresAt: number | null): Promise<void> {
    await env.DB.prepare(
      "insert into pithy_email_suppressions (id, email, reason, expires_at, created_at) values (?, ?, ?, ?, ?)",
    )
      .bind(`s-${email}`, email, "hard_bounce", expiresAt, DAY_ONE.getTime())
      .run();
  }

  test("a suppressed address is marked unreachable and counted as a bounce", async () => {
    // The bug this replaces compared `activity.observability === "unreachable"` against the very flag it
    // was reconciling — a value against itself — so no bounce was ever recorded.
    await suppressionTable();
    const cohort = await makeCohort();
    const member = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "bounced@example.com",
      maxRosterSize: 10,
    });
    await suppress("bounced@example.com", null);

    const result = await runCohortPass(deps(DAY_ONE, { suppressionD1: env.DB }), cohort.id);
    expect((await requireMember(testersDatabase(env.DB), member.member.id)).unreachable).toBe(true);
    const stored = await snapshotOn(testersDatabase(env.DB), cohort.id, "2026-06-01");
    expect(stored?.unreachableCount).toBe(1);
    expect(result.nudged.confirm).toBe(0); // and the same pass does not mail them
  });

  test("an expired temporary suppression is not a suppression", async () => {
    // Otherwise a tester whose mailbox was full for an afternoon is stranded for the whole cohort.
    await suppressionTable();
    const cohort = await makeCohort();
    const member = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "recovered@example.com",
      maxRosterSize: 10,
    });
    await suppress("recovered@example.com", DAY_ONE.getTime() - 86_400_000);

    await runCohortPass(deps(DAY_ONE, { suppressionD1: env.DB }), cohort.id);
    expect((await requireMember(testersDatabase(env.DB), member.member.id)).unreachable).toBe(false);
  });

  test("a recovered address is un-marked, so the flag tracks the list rather than latching", async () => {
    await suppressionTable();
    const cohort = await makeCohort();
    const member = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "flaky@example.com",
      maxRosterSize: 10,
    });
    await suppress("flaky@example.com", null);
    await runCohortPass(deps(DAY_ONE, { suppressionD1: env.DB }), cohort.id);
    expect((await requireMember(testersDatabase(env.DB), member.member.id)).unreachable).toBe(true);

    await env.DB.prepare("delete from pithy_email_suppressions").run();
    await runCohortPass(deps(new Date("2026-06-02T05:00:00.000Z"), { suppressionD1: env.DB }), cohort.id);
    expect((await requireMember(testersDatabase(env.DB), member.member.id)).unreachable).toBe(false);
  });

  test("with no suppression database the flags are left alone rather than guessed at", async () => {
    const cohort = await makeCohort();
    const member = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "unknown@example.com",
      maxRosterSize: 10,
    });
    await markUnreachable(write(DAY_ONE), member.member.id, true);
    await runCohortPass(deps(DAY_ONE, { suppressionD1: undefined }), cohort.id);
    expect((await requireMember(testersDatabase(env.DB), member.member.id)).unreachable).toBe(true);
  });
});

describe("a tester is not chased forever", () => {
  test("chasing stops after three unanswered nudges", async () => {
    // The cooldown bounded how *often*; nothing bounded how *many times*, so someone who never answered
    // would have been mailed every three days for the life of the cohort.
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "silent@example.com", maxRosterSize: 10 });
    const days = ["2026-06-01", "2026-06-05", "2026-06-09", "2026-06-13", "2026-06-17"];
    let total = 0;
    for (const day of days) {
      const result = await runCohortPass(deps(new Date(`${day}T05:00:00.000Z`)), cohort.id);
      total += result.nudged.confirm;
    }
    expect(total).toBe(3);
  });

  test("answering clears the count, so a responsive tester is never capped out", async () => {
    const cohort = await makeCohort();
    const invited = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "responsive@example.com",
      maxRosterSize: 10,
    });
    await runCohortPass(deps(DAY_ONE), cohort.id);
    await recordAccepted(write(new Date("2026-06-02T05:00:00.000Z")), invited.member.id);
    expect((await requireMember(testersDatabase(env.DB), invited.member.id)).nudgeCount).toBe(0);
    const result = await runCohortPass(deps(new Date("2026-06-02T06:00:00.000Z")), cohort.id);
    expect(result.nudged.store).toBe(1);
  });
});

describe("every nudge carries a way out", () => {
  test("the opt-out link is on the payload, so a chased tester can always stop it", async () => {
    // Without this the opt-out route was unreachable — a door with no handle on the inside.
    const cohort = await makeCohort();
    const invited = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "ada@example.com",
      maxRosterSize: 10,
    });
    await runCohortPass(deps(DAY_ONE), cohort.id);
    const payload = sent[0]?.payload as { optOutUrl?: string } | undefined;
    expect(payload?.optOutUrl).toContain(`/testers/opt-out/${invited.member.optInToken}`);
  });
});

describe("what the pass sends is what the snapshot records", () => {
  /**
   * Read back from D1, not from the return value.
   *
   * `CohortPassResult.nudged` is the object *before* it reaches the encoder, so asserting on it proves
   * only that the pass counted. The column is `sqliteJson(NudgeTally)`, and Zod strips unknown keys on
   * encode — so a kind missing from that schema vanished between the count and the row, silently, with
   * no error. `store` did exactly that. The chart is drawn from the row, so the row is what has to be
   * asserted.
   */
  async function storedTally(cohortId: string, on: Date) {
    const snapshot = await snapshotOn(testersDatabase(env.DB), cohortId, dayKey(on));
    if (!snapshot) throw new Error("no snapshot written");
    return snapshot.nudgesSent;
  }

  test("a store-link nudge reaches the persisted tally", async () => {
    const cohort = await makeCohort();
    const { member } = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: "ada@example.com",
      maxRosterSize: 10,
    });
    await recordAccepted(write(DAY_ONE), member.id);

    const result = await runCohortPass(deps(DAY_ONE), cohort.id);
    expect(result.nudged.store).toBe(1);
    // The assertion the old test was missing: the same 1, after a round trip through the codec.
    expect(await storedTally(cohort.id, DAY_ONE)).toEqual({ confirm: 0, store: 1, inactive: 0, closing: 0 });
  });

  test("every kind the pass can count has somewhere to be recorded", async () => {
    // A structural check rather than four scenarios: the tally schema and the nudge enum must agree, or
    // a kind added later silently stops being written down the day it ships.
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "grace@example.com", maxRosterSize: 10 });
    await runCohortPass(deps(DAY_ONE), cohort.id);

    expect(Object.keys(await storedTally(cohort.id, DAY_ONE)).sort()).toEqual([...NudgeKind.options].sort());
  });
});

describe("a deployment with no baseUrl still records the day", () => {
  /** The config an adopter gets by composing `testers({})` — `baseUrl` is optional and nothing requires it. */
  const NO_BASE_URL = TestersConfig.parse({});

  test("the pass skips nudging rather than throwing out of the step", async () => {
    // The link builders throw `TestersNotConfiguredError` rather than returning undefined, so the first
    // due nudge took the exception past the step boundary and the snapshot below never ran. The day was
    // lost — and under `runDailyPass`, so was every later cohort's.
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "ada@example.com", maxRosterSize: 10 });

    const result = await runCohortPass(
      deps(DAY_ONE, {
        config: NO_BASE_URL,
        linkFor: () => {
          throw new Error("no baseUrl");
        },
        optOutLinkFor: () => {
          throw new Error("no baseUrl");
        },
      }),
      cohort.id,
    );

    expect(result.snapshotOn).toBe(dayKey(DAY_ONE));
    expect(result.nudged).toEqual({ confirm: 0, store: 0, inactive: 0, closing: 0 });
    expect(sent).toEqual([]);
  });

  test("and says why, so silence is not mistaken for nobody being due", async () => {
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "grace@example.com", maxRosterSize: 10 });

    const skipped = await runCohortPass(deps(DAY_ONE, { config: NO_BASE_URL }), cohort.id);
    expect(skipped.nudgesSkipped).toBe("no_base_url");

    // The configured case says nothing, because there is nothing to say.
    const cohortTwo = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohortTwo.id, email: "alan@example.com", maxRosterSize: 10 });
    const normal = await runCohortPass(deps(DAY_ONE), cohortTwo.id);
    expect(normal.nudgesSkipped).toBeUndefined();
    expect(normal.nudged.confirm).toBe(1);
  });

  test("a later cohort still gets its day, because one cohort cannot abort the run", async () => {
    const first = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: first.id, email: "one@example.com", maxRosterSize: 10 });
    const second = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: second.id, email: "two@example.com", maxRosterSize: 10 });

    const results = await runDailyPass(deps(DAY_ONE, { config: NO_BASE_URL }));
    expect(results.map((r) => r.snapshotOn)).toEqual([dayKey(DAY_ONE), dayKey(DAY_ONE)]);
  });
});

describe("a second pass on a covered day does not erase the first", () => {
  test("the day's send record survives an afternoon re-run", async () => {
    // Every column but two is recomputed from durable state, so a re-run re-derives it identically.
    // `nudgesSent` and `bouncedCount` count only what *this* invocation did — correctly zero on a
    // re-run, because the cooldown suppresses the sends — and the upsert takes every column from
    // `excluded`. So `pithy testers run` in the afternoon overwrote the morning's record with zeros.
    // The mail had gone out. The evidence of it had not survived.
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "ada@example.com", maxRosterSize: 10 });

    await runCohortPass(deps(DAY_ONE), cohort.id);
    const afterMorning = await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_ONE));
    expect(afterMorning?.nudgesSent.confirm).toBe(1);
    expect(sent).toHaveLength(1);

    // Same day, twelve hours later. Nothing new goes out.
    const afternoon = new Date(DAY_ONE.getTime() + 12 * 3_600_000);
    const second = await runCohortPass(deps(afternoon), cohort.id);
    expect(second.nudged.confirm).toBe(0);
    expect(sent).toHaveLength(1);

    const afterAfternoon = await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_ONE));
    expect(afterAfternoon?.nudgesSent.confirm).toBe(1);
  });

  test("and a send later the same day adds to it rather than replacing it", async () => {
    // Accumulating is what makes the column mean "what went out today" rather than "what the last run
    // happened to do".
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "one@example.com", maxRosterSize: 10 });
    await runCohortPass(deps(DAY_ONE), cohort.id);

    // A second tester added after the morning pass, then the operator re-runs.
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "two@example.com", maxRosterSize: 10 });
    const afternoon = new Date(DAY_ONE.getTime() + 12 * 3_600_000);
    await runCohortPass(deps(afternoon), cohort.id);

    const snapshot = await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_ONE));
    expect(snapshot?.nudgesSent.confirm).toBe(2);
    expect(sent).toHaveLength(2);
  });
});

describe("a day is corrected once its day has actually ended", () => {
  /**
   * The pass runs at 05:00 and writes a row keyed to the day it is five hours into. Everything that
   * happened in the other nineteen hours was missing from that row and nothing went back for it — so
   * the stored series contradicted the replay it claims to record, and every post-05:00 opt-in plotted
   * a day late, permanently.
   */
  const DAY_TWO = new Date("2026-06-02T05:00:00.000Z");
  const DAY_THREE = new Date("2026-06-03T05:00:00.000Z");

  async function atTargetCohort() {
    const cohort = await createCohort(write(DAY_ONE), {
      name: `late-${++sequence}`,
      targetSize: 1,
      windowDays: 14,
      maxRosterSize: 10,
      targetPlatform: "android",
      storeOptInUrl: "https://play.google.com/apps/testing/com.example.app",
      resetPolicy: "reset",
    });
    const { member } = await inviteMember(write(DAY_ONE), {
      cohortId: cohort.id,
      email: `late-${++sequence}@example.test`,
      maxRosterSize: 10,
    });
    return { cohort, member };
  }

  test("an opt-in after the pass is recorded on the day it happened, not the day after", async () => {
    const { cohort, member } = await atTargetCohort();
    await runCohortPass(deps(DAY_TWO), cohort.id);

    // 10:00 — five hours after the pass has already written the day.
    await confirmOptIn(write(new Date("2026-06-02T10:00:00.000Z")), member.id);
    const asWritten = await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_TWO));
    expect(asWritten?.estimatedOptedInCount).toBe(0);
    expect(asWritten?.meetsTarget).toBe(false);

    // The next morning's pass replays the finished day and corrects it.
    await runCohortPass(deps(DAY_THREE), cohort.id);
    const corrected = await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_TWO));
    expect(corrected?.estimatedOptedInCount).toBe(1);
    expect(corrected?.meetsTarget).toBe(true);
    expect(corrected?.estimatedWindowStartOn).toBe(dayKey(DAY_TWO));
  });

  test("so the series agrees with itself about when the run began", async () => {
    // The failure this exists to prevent: one row saying a day was below target with no window start,
    // and the next row saying the at-target run began on that very day.
    const { cohort, member } = await atTargetCohort();
    await runCohortPass(deps(DAY_TWO), cohort.id);
    await confirmOptIn(write(new Date("2026-06-02T10:00:00.000Z")), member.id);
    await runCohortPass(deps(DAY_THREE), cohort.id);

    const dayTwo = await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_TWO));
    const dayThree = await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_THREE));
    expect(dayThree?.estimatedWindowStartOn).toBe(dayKey(DAY_TWO));
    expect(dayTwo?.meetsTarget).toBe(true);
    expect(dayThree?.estimatedHeldDays).toBe((dayTwo?.estimatedHeldDays ?? 0) + 1);
  });

  test("a corrected row is marked backfilled, because only half of it was replayable", async () => {
    // `backfilled` was hardcoded false and unreachable while the wire schema documented it as a
    // rendering instruction. This is what it now means: the opt-in figures were rewritten from the
    // event log, the activity figures were not and cannot be, so the chart renders the point dashed.
    const { cohort, member } = await atTargetCohort();
    await runCohortPass(deps(DAY_TWO), cohort.id);
    await confirmOptIn(write(new Date("2026-06-02T10:00:00.000Z")), member.id);
    await runCohortPass(deps(DAY_THREE), cohort.id);

    expect((await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_TWO)))?.backfilled).toBe(true);
    expect((await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_THREE)))?.backfilled).toBe(false);
  });

  test("a day that was already right is left alone rather than restamped", async () => {
    // The common case. Rewriting it would mark an accurate row backfilled and tell every chart to
    // render a dashed point for a measurement that was never reconstructed.
    const { cohort, member } = await atTargetCohort();
    await confirmOptIn(write(new Date("2026-06-01T06:00:00.000Z")), member.id);
    await runCohortPass(deps(DAY_TWO), cohort.id);
    await runCohortPass(deps(DAY_THREE), cohort.id);

    expect((await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_TWO)))?.backfilled).toBe(false);
  });

  test("with no row for yesterday there is nothing to correct, and none is invented", async () => {
    // Inventing one would fabricate an activity reading nobody took.
    const { cohort } = await atTargetCohort();
    await runCohortPass(deps(DAY_THREE), cohort.id);
    expect(await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_TWO))).toBeUndefined();
  });
});

describe("a closed cohort is not passed over", () => {
  test("`run --cohort <closed>` refuses rather than mailing a finished cohort", async () => {
    // `openCohortIds` filters closed cohorts out of the daily run, but it is not the only caller —
    // the CLI's `--cohort` flag reaches `runCohortPass` directly, so the one flag documented as
    // "run one cohort only" was the one path that ignored closure. It mailed and wrote a snapshot.
    const cohort = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: cohort.id, email: "ada@example.com", maxRosterSize: 10 });
    await closeCohort(write(DAY_ONE), cohort.id);

    await expect(runCohortPass(deps(DAY_ONE), cohort.id)).rejects.toThrow(/closed/);
    expect(sent).toEqual([]);
    expect(await snapshotOn(testersDatabase(env.DB), cohort.id, dayKey(DAY_ONE))).toBeUndefined();
  });

  test("and the whole-set pass skips it without failing the run", async () => {
    const open = await makeCohort();
    await inviteMember(write(DAY_ONE), { cohortId: open.id, email: "open@example.com", maxRosterSize: 10 });
    const closed = await makeCohort();
    await closeCohort(write(DAY_ONE), closed.id);

    const results = await runDailyPass(deps(DAY_ONE));
    expect(results.map((r) => r.cohortId)).toEqual([open.id]);
  });
});
