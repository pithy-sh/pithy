// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import type { ExpressionBuilder } from "kysely";
import { addDays, type DayKey, dayKey, daysSince, endOfDay } from "../clock/days";
import { readClock } from "../clock/replay";
import { isStoreOptInUrl, type TestersConfig } from "../config/config";
import { NudgeKind } from "../data/enums";
import type { TestersMember } from "../data/member";
import { type NudgeTally, TestersCohortSnapshot } from "../data/snapshot";
import { TESTERS_COHORTS_TABLE, TESTERS_SNAPSHOTS_TABLE, type TestersDatabase } from "../data/tables";
import { TestersCohortClosedError } from "../error/errors";
import { answersRecentAction, chasedOut, mayNudge } from "../nudge/cooldown";
import { type EnqueueNudge, sendNudge } from "../nudge/send";
import { buildSnapshot } from "../projection/build";
import { type CohortReading, countSnapshots, newlyDark, readCohort, requireCohort, snapshotOn } from "../roster/read";
import { markUnreachable, recordNudge, type WriteDeps } from "../roster/write";

/**
 * The daily pass — advance what has changed, chase who needs chasing, and record the day's position.
 *
 * **Why a Workflow rather than a scheduled Worker handler.** A Worker invocation is wall-clock bounded;
 * a Workflow step is not. A project running several cohorts of a hundred testers each resolves activity
 * against auth, scores every member, and enqueues nudges — and the pass that matters most is the one on
 * the busiest project. Per-cohort steps also mean a cohort whose activity read fails is retried on its
 * own rather than taking the rest of the day's cohorts down with it.
 *
 * **The snapshot is written last, deliberately.** State transitions and nudges happen first, so the row
 * records the day's *settled* position rather than a mid-pass one — a snapshot claiming twelve opted-in
 * testers while the pass was still about to record the thirteenth would put a wrong point on a chart
 * that nothing later corrects.
 *
 * **Everything here is idempotent, because a Workflow step can re-run.** The snapshot upserts on
 * `(cohortId, snapshotOn)`, `recordAccepted` is a no-op for anyone past `invited`, and the nudge
 * cooldown makes a replay silent rather than duplicative. A retried pass changes nothing it has already
 * done.
 */

/** Milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

/** How long after an invitation to start chasing an unconfirmed tester. */
const CONFIRM_NUDGE_AFTER_DAYS = 2;

/** How many days of silence before an opted-in tester is worth nudging about it. */
const INACTIVE_NUDGE_AFTER_DAYS = 5;

/** How many days from the end of the window the closing nudge goes out. */
const CLOSING_NUDGE_WITHIN_DAYS = 3;

/** What one pass needs. Every dependency injected, so the pass is testable without a Worker. */
export interface DailyPassDeps {
  readonly db: TestersDatabase;
  readonly d1: D1Database;
  readonly config: TestersConfig;
  readonly now: Date;
  readonly newId: () => string;
  /** The email enqueue seam. Absent means state still advances and the snapshot is still written. */
  readonly enqueue: EnqueueNudge | undefined;
  /**
   * The global email-suppression database, for reconciling deliverability.
   *
   * A separate binding because suppression is global rather than per environment — an unsubscribe in
   * production must stop staging too. Absent means the flag is left alone rather than guessed at.
   */
  readonly suppressionD1: D1Database | undefined;
  /**
   * The link a nudge of each kind should carry, or undefined to send no linked nudges.
   *
   * Takes the kind because the two linked kinds point at different routes: `confirm` asks whether they
   * will test, `store` sends them on once the developer has added them to the tester list.
   */
  readonly linkFor: ((kind: NudgeKind, member: TestersMember) => string | undefined) | undefined;
  /** The tester's own way out, carried on every nudge this pass sends. */
  readonly optOutLinkFor: ((member: TestersMember) => string) | undefined;
}

/** What one cohort's pass did. Returned so the Workflow can log it and a test can assert it. */
export interface CohortPassResult {
  readonly cohortId: string;
  readonly snapshotOn: string;
  readonly nudged: Record<NudgeKind, number>;
  readonly estimatedOptedInCount: number;
  readonly estimatedHeldDays: number;
  readonly trendDirection: string;
  readonly pruned: number;
  /**
   * Why nothing was sent, when nothing was sent for a reason worth reporting.
   *
   * `undefined` means the pass nudged normally (which may still be nobody, if nobody was due).
   */
  readonly nudgesSkipped?: "no_base_url";
}

/**
 * Correct yesterday's row from the event log, now that yesterday has actually ended.
 *
 * The pass runs at `snapshotHourUtc` — 05:00 by default — and writes a row keyed to the day it is five
 * hours into. Every state-moving event in the remaining nineteen hours was therefore missing from that
 * row, and nothing ever went back for it: a cohort reaching its twelfth opt-in at 10:00 was recorded
 * that day as below target with no window start, while the *next* day's row — replayed from the same
 * events — said the at-target run had begun the day before and already held two days. The stored
 * series contradicted the replay it claims to record, and every post-05:00 opt-in plotted a day late,
 * permanently.
 *
 * Only the opt-in clock is corrected, and the split is the one the package already states: the clock
 * can always be replayed from events, the activity figures cannot — sessions rotate and expire, so a
 * tester who was quiet yesterday leaves nothing behind today to prove it. So the estimated columns are
 * rewritten from a replay of the finished day and the observed columns are left exactly as sampled,
 * which is precisely what `backfilled` exists to tell a chart: render the point dashed, the opt-in
 * figures are exact and the activity figures are a floor.
 *
 * Yesterday only. In steady state that is every day, corrected once, the morning after — bounded work
 * and a guarantee that is easy to state. A day nobody ran a pass for has no row to correct, and
 * inventing one would fabricate an activity reading nobody took.
 */
async function reconcilePreviousDay(
  deps: DailyPassDeps,
  cohortId: string,
  reading: CohortReading,
  today: DayKey,
): Promise<void> {
  const day = addDays(today, -1);
  const existing = await snapshotOn(deps.db, cohortId, day);
  if (!existing) return;

  // Replayed as of the end of that day, so the reading covers all of it rather than the five hours the
  // original pass saw.
  const settled = readClock(
    {
      createdAt: reading.cohort.createdAt,
      targetSize: reading.cohort.targetSize,
      windowDays: reading.cohort.windowDays,
      resetPolicy: reading.cohort.resetPolicy,
    },
    reading.events,
    endOfDay(day),
  );

  const corrected: TestersCohortSnapshot = {
    ...existing,
    estimatedOptedInCount: settled.estimatedOptedInCount,
    meetsTarget: settled.meetsTarget,
    headroom: settled.headroom,
    estimatedHeldDays: settled.estimatedHeldDays,
    estimatedWindowStartOn: settled.estimatedWindowStartOn,
    estimatedDaysRemaining: settled.estimatedDaysRemaining,
    resetCount: settled.resetCount,
    resetToday: settled.resetToday,
    // The opt-in half was rewritten from a replay; the observed half was not and cannot be.
    backfilled: true,
  };

  // Nothing to say if the day was already right, which is the common case — the pass usually runs on a
  // day whose events all landed before 05:00 the following morning.
  if (
    corrected.estimatedOptedInCount === existing.estimatedOptedInCount &&
    corrected.estimatedHeldDays === existing.estimatedHeldDays &&
    corrected.estimatedWindowStartOn === existing.estimatedWindowStartOn &&
    corrected.resetToday === existing.resetToday
  ) {
    return;
  }

  await upsertSnapshot(deps.db, corrected);
}

/** Add this pass's nudge counts to whatever the day had already recorded. */
function addTallies(existing: NudgeTally | undefined, added: Record<NudgeKind, number>): Record<NudgeKind, number> {
  if (!existing) return added;
  return Object.fromEntries(NudgeKind.options.map((kind) => [kind, (existing[kind] ?? 0) + added[kind]])) as Record<
    NudgeKind,
    number
  >;
}

/**
 * Which nudge, if any, this tester is due today.
 *
 * Returns at most one. A tester who is both unconfirmed and quiet gets the confirmation nudge, because
 * confirming is the thing that actually moves the count and asking for two things at once gets neither.
 */
export function dueNudge(
  member: TestersMember,
  context: { now: Date; daysRemaining: number; lastSeenAt: Date | null; storeReady: boolean },
): NudgeKind | null {
  // Step one: will you help test? Sent promptly the first time — a tester added from the CLI has been
  // put on the roster but not actually told, and making them wait two days for the email is the
  // difference between a capability that works without a dashboard and one that only appears to.
  // Stop chasing someone who has not answered three times. "Answer" means accepting the invitation or
  // confirming the opt-in — the two replies this capability asks for — and either clears the counter.
  // Opening the app does not, deliberately: activity is a separate signal with its own penalties, and
  // a tester who installs but never replies is exactly who the cap is for. The consequence worth
  // knowing is that an already-opted-in tester has no reply left to give, so three unanswered
  // `inactive` or `closing` nudges stop their chasing for the life of the cohort. That is the intended
  // trade — they stay on the roster and stay visible, they simply stop being mailed.
  if (chasedOut(member)) return null;

  if (member.state === "invited") {
    if (member.nudgeCount === 0) return "confirm";
    return daysSince(member.lastInvitedAt, context.now) >= CONFIRM_NUDGE_AFTER_DAYS ? "confirm" : null;
  }

  // Step two: they said yes, and the developer has supplied the store's opt-in link — which is their
  // signal that this address is now on the tester list. Without that link the store page would answer
  // `App not available`, so we hold the email rather than send someone to a dead end.
  if (member.state === "accepted") {
    if (!context.storeReady) return null;
    return "store";
  }

  if (member.state !== "opted_in") return null;

  // The window is nearly up and they are still in. One message, so the last thing they hear is not a
  // complaint about their engagement.
  if (context.daysRemaining > 0 && context.daysRemaining <= CLOSING_NUDGE_WITHIN_DAYS) return "closing";

  // Only an observed tester can be nudged about inactivity. Nudging someone who simply never signs in —
  // because the app never asks them to — would be chasing them for something they did not do wrong.
  if (context.lastSeenAt && daysSince(context.lastSeenAt, context.now) >= INACTIVE_NUDGE_AFTER_DAYS) {
    return "inactive";
  }
  return null;
}

/**
 * Which of these addresses the email capability is suppressing, or `undefined` when it cannot be asked.
 *
 * A guarded dynamic import over an optional binding: a project can run cohorts without the suppression
 * database bound, and the honest answer then is to leave the flag alone rather than infer a bounce from
 * its own absence.
 */
async function readSuppressed(deps: DailyPassDeps, emails: readonly string[]): Promise<Set<string> | undefined> {
  if (!deps.suppressionD1 || emails.length === 0) return undefined;
  try {
    const { emailSuppressionDatabase } = await import("@pithy-sh/email/src/data/tables");
    const db = emailSuppressionDatabase(deps.suppressionD1);
    const found = new Set<string>();
    for (const chunk of chunkByBoundParameters([...new Set(emails)], 0)) {
      const rows = await db
        .selectFrom("pithyEmailSuppressions")
        .select(["email", "expiresAt"])
        .where("email", "in", chunk)
        .execute();
      for (const row of rows) {
        // A row whose `expiresAt` has passed is a lapsed temporary suppression, not a live one — the
        // same rule `@pithy-sh/email`'s own `isSuppressed` applies. Treating every row as suppressing
        // would strand a tester for the whole cohort because their mailbox was full one afternoon.
        const expiresAt =
          row.expiresAt === null || row.expiresAt === undefined ? null : new Date(Number(row.expiresAt));
        if (expiresAt === null || expiresAt > deps.now) found.add(String(row.email).toLowerCase());
      }
    }
    return found;
  } catch (error) {
    console.warn("testers: suppression list unreadable, leaving deliverability flags alone", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Run the pass for one cohort. */
export async function runCohortPass(deps: DailyPassDeps, cohortId: string): Promise<CohortPassResult> {
  const write: WriteDeps = { db: deps.db, now: deps.now, newId: deps.newId };
  const cohort = await requireCohort(deps.db, cohortId);
  // Checked here rather than only in `openCohortIds`, because that filter is not the only caller.
  // `pithy testers run --cohort <closed>` reaches this function directly — the flag documented as
  // "run one cohort only" was the one path that ignored closure — and it mailed a finished cohort's
  // testers and wrote them a fresh snapshot. `close` prints "Nothing further is sent."
  if (cohort.closedAt !== null) {
    throw new TestersCohortClosedError({
      detail: `cohort ${cohort.id} was closed at ${cohort.closedAt.toISOString()}`,
    });
  }

  const reading = await readCohort(deps.db, deps.d1, cohort, deps.config, deps.now);

  // 1. Reconcile deliverability against the suppression list — the only place that fact actually lives.
  //    Comparing `activity.observability === "unreachable"` here would compare the flag with itself:
  //    `readCohort` builds that value FROM `member.unreachable`, so the condition could never fire and
  //    no bounce was ever recorded.
  const suppressed = await readSuppressed(
    deps,
    reading.readings.map((entry) => entry.member.email),
  );
  let bounced = 0;
  if (suppressed) {
    for (const entry of reading.readings) {
      const isSuppressed = suppressed.has(entry.member.email);
      if (isSuppressed !== entry.member.unreachable) {
        await markUnreachable(write, entry.member.id, isSuppressed);
        if (isSuppressed) bounced++;
        // Reflected in the reading too, so the nudge loop and the snapshot below both see what this
        // pass just learned. Without it, an address discovered to be bouncing this morning is still
        // mailed this morning, and the snapshot records it as reachable.
        (entry as { member: TestersMember }).member = { ...entry.member, unreachable: isSuppressed };
      }
    }
  }

  // 2. Chase whoever is due, subject to the cooldown. The cooldown is checked here rather than trusted
  //    to the caller, because this is a caller — a cron that ran twice would otherwise mail twice.
  const nudged: Record<NudgeKind, number> = { confirm: 0, store: 0, inactive: 0, closing: 0 };

  // No `baseUrl` means no link can be built, and the link builders throw rather than returning
  // undefined — so without this the first due nudge threw `TestersNotConfiguredError` out of the loop,
  // past the step boundary, and the snapshot below never ran. Under `runDailyPass` the outer loop
  // aborted too, so every later cohort lost its day as well. The chart the capability exists to draw
  // gained a permanent gap whose only symptom was a failed Workflow instance nobody watches.
  //
  // Skipping is the right answer rather than sending anyway: every nudge must carry the tester's own
  // way out, and that link needs the same `baseUrl`. Recording the day still happens, because the
  // day's position is true whether or not any mail went out.
  const canLink = deps.config.baseUrl !== undefined;
  if (deps.enqueue && canLink) {
    for (const entry of reading.readings) {
      const kind = dueNudge(entry.member, {
        now: deps.now,
        daysRemaining: reading.clock.estimatedDaysRemaining,
        lastSeenAt: entry.activity.lastAuthenticatedAt,
        // The same test the route applies, not merely "a value is present". These two disagreeing is
        // the worst failure this capability has: the pass reads a non-null junk URL as ready and mails
        // the store email, the tester follows it, `confirmOptIn` moves them to `opted_in` — so the
        // estimate climbs — and only then does the route's host check fail and drop them on the
        // "the developer will be in touch" page. Nobody is enrolled with Google, and the number says
        // otherwise.
        storeReady: cohort.storeOptInUrl !== null && isStoreOptInUrl(cohort.storeOptInUrl),
      });
      if (!kind) continue;
      if (entry.member.unreachable) continue;
      // The cooldown stops repeated chasing; it must not delay a reply. A tester who just agreed and is
      // waiting for the link is waiting on us, and holding it for three days is how a cohort loses the
      // people who were most willing.
      const isReply = kind === "store" && answersRecentAction(entry.member);
      if (!isReply && !mayNudge(entry.member, deps.config.nudges.cooldownHours, deps.now)) continue;

      const ctaUrl = deps.linkFor?.(kind, entry.member);
      // A linked nudge with no link is just nagging. Skip it rather than send a message asking someone
      // to click something that is not there.
      if ((kind === "confirm" || kind === "store") && !ctaUrl) continue;

      const sent = await sendNudge(deps.enqueue, {
        member: entry.member,
        kind,
        supplied: undefined,
        ctaUrl,
        optOutUrl: deps.optOutLinkFor?.(entry.member),
      });
      await recordNudge(write, {
        memberId: entry.member.id,
        nudgeKind: kind,
        jobId: sent.jobId,
        copySource: "default",
      });
      nudged[kind]++;
    }
  }

  // 3. Record the day. Last, so it describes the settled position.
  const today = dayKey(deps.now);
  const yesterday = await snapshotOn(deps.db, cohortId, addDays(today, -1));
  const weekAgo = await snapshotOn(deps.db, cohortId, addDays(today, -7));
  const existing = await snapshotOn(deps.db, cohortId, today);

  const snapshot = buildSnapshot({
    cohort: reading.cohort,
    config: deps.config,
    clock: reading.clock,
    readings: reading.readings,
    yesterday: yesterday
      ? {
          estimatedOptedInCount: yesterday.estimatedOptedInCount,
          activeCount: yesterday.activeCount,
          successProbability: yesterday.successProbability,
        }
      : null,
    weekAgo: weekAgo
      ? {
          estimatedOptedInCount: weekAgo.estimatedOptedInCount,
          activeCount: weekAgo.activeCount,
          successProbability: weekAgo.successProbability,
        }
      : null,
    yesterdayMetTarget: yesterday?.meetsTarget ?? null,
    snapshotCount: (await countSnapshots(deps.db, cohortId)) + (existing ? 0 : 1),
    // Added to what the day already recorded, not substituted for it. These two are the only columns
    // on the row derived from what happened *during* this invocation rather than from durable state —
    // every other one is recomputed from events, member rows and activity, so a re-run re-derives it
    // identically. `nudged` and `bounced` on a re-run of a covered day are correctly zero (the cooldown
    // suppresses the sends, the suppression flags already agree), and the upsert takes every column
    // from `excluded` — so an operator running `pithy testers run` in the afternoon overwrote the
    // morning's record of three sends and a bounce with zeros. The mail had gone out. The evidence of
    // it had not survived, and `snapshot.ts` is explicit that what is not written down on the day is
    // gone for good.
    nudgesSent: addTallies(existing?.nudgesSent, nudged),
    bouncedCount: (existing?.bouncedCount ?? 0) + bounced,
    newlyDarkCount: newlyDark(reading.readings, deps.now),
    now: deps.now,
  });

  await upsertSnapshot(deps.db, snapshot);
  await reconcilePreviousDay(deps, cohortId, reading, today);
  const pruned = await pruneSnapshots(deps.db, cohortId, deps.config.snapshotRetentionDays, deps.now);

  return {
    cohortId,
    snapshotOn: snapshot.snapshotOn,
    nudged,
    estimatedOptedInCount: snapshot.estimatedOptedInCount,
    estimatedHeldDays: snapshot.estimatedHeldDays,
    trendDirection: snapshot.trendDirection,
    pruned,
    // Reported rather than silent. A pass that mailed nobody because it could not build a link looks
    // identical to a pass where nobody was due, and those are very different states to be in on day 9.
    ...(deps.enqueue && !canLink ? { nudgesSkipped: "no_base_url" as const } : {}),
  };
}

/**
 * Write one day's snapshot, replacing any existing row for that day.
 *
 * The upsert is what makes a re-run safe: a retried Workflow step, a manual backfill, and two crons
 * firing a second apart all rewrite the day rather than appending a second version of it. A duplicated
 * day would put two points at one x-coordinate, and every delta computed from it afterwards would be
 * wrong in a way nothing later notices.
 */
export async function upsertSnapshot(db: TestersDatabase, snapshot: TestersCohortSnapshot): Promise<void> {
  const row = TestersCohortSnapshot.encode(snapshot);
  const { id: _generated, ...insertable } = row;

  // The update half references `excluded` rather than re-binding every column, and that is a
  // correctness fix rather than a tidiness one. A snapshot has fifty-eight columns; binding them once
  // for the insert and again for the update is a hundred and sixteen bound parameters, and **D1 rejects
  // any statement over one hundred**. Written the obvious way, the very first daily pass fails with
  // `too many SQL variables` — in a cron, at 05:00, where nobody is watching. `excluded` binds nothing.
  const updateFromExcluded = (eb: ExpressionBuilder<Record<string, Record<string, unknown>>, string>) =>
    Object.fromEntries(Object.keys(insertable).map((column) => [column, eb.ref(`excluded.${column}`)]));

  await db
    .insertInto(TESTERS_SNAPSHOTS_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
    .values(insertable as any)
    .onConflict((oc) =>
      oc.columns(["cohortId", "snapshotOn"]).doUpdateSet(
        // biome-ignore lint/suspicious/noExplicitAny: the column map is built from the same z.input side.
        updateFromExcluded as any,
      ),
    )
    .execute();
}

/** Drop snapshots older than the retention window. Returns how many went. */
export async function pruneSnapshots(
  db: TestersDatabase,
  cohortId: string,
  retentionDays: number,
  now: Date,
): Promise<number> {
  const cutoff = dayKey(new Date(now.getTime() - retentionDays * MS_PER_DAY));
  const result = await db
    .deleteFrom(TESTERS_SNAPSHOTS_TABLE)
    .where("cohortId", "=", cohortId)
    .where("snapshotOn", "<", cutoff)
    .executeTakeFirst();
  return Number(result?.numDeletedRows ?? 0);
}

/** Run the pass for every open cohort. A closed cohort keeps its history and accrues nothing new. */
export async function openCohortIds(db: DailyPassDeps["db"]): Promise<string[]> {
  const rows = await db.selectFrom(TESTERS_COHORTS_TABLE).select(["id"]).where("closedAt", "is", null).execute();
  return rows.map((row) => String(row.id));
}

/**
 * Run the pass for every open cohort.
 *
 * Kept for the CLI and for tests, where one process runs the lot. **The Workflow does not use this** —
 * it enumerates with {@link openCohortIds} and gives each cohort its own `step.do`, so a cohort that
 * throws is retried on its own rather than taking the rest of the day's cohorts down with it. That
 * distinction is the whole reason this function is not what the worker calls.
 *
 * Here, a throw still aborts the remaining cohorts. That is the right shape for a foreground command
 * where somebody is reading the error.
 */
export async function runDailyPass(deps: DailyPassDeps): Promise<CohortPassResult[]> {
  const results: CohortPassResult[] = [];
  for (const cohortId of await openCohortIds(deps.db)) {
    results.push(await runCohortPass(deps, cohortId));
  }
  return results;
}
