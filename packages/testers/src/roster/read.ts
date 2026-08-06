// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type Logger, noopLogger } from "@pithy-sh/core/src/logger/logger";
import { resolveActivity, type TesterActivity } from "../activity/resolve";
import { dayKey, daysSince } from "../clock/days";
import { type CohortClock, readClock } from "../clock/replay";
import type { TestersConfig } from "../config/config";
import { TestersCohort } from "../data/cohort";
import { TestersEvent } from "../data/event";
import { TestersMember } from "../data/member";
import { TestersCohortSnapshot } from "../data/snapshot";
import {
  TESTERS_COHORTS_TABLE,
  TESTERS_EVENTS_TABLE,
  TESTERS_MEMBERS_TABLE,
  TESTERS_SNAPSHOTS_TABLE,
  type TestersDatabase,
} from "../data/tables";
import { TestersCohortNotFoundError } from "../error/errors";
import type { MemberReading } from "../projection/build";
import { lastSignOfLife } from "../projection/build";

/**
 * Reading a cohort: the roster, the replayed clock, and whatever activity we can observe.
 *
 * One module for the read side so the control-plane route, the tester's own status route, the CLI, and
 * the daily Workflow all see the same numbers. A second implementation anywhere would eventually
 * disagree with this one, and the disagreement would show up as a dashboard and a terminal reporting
 * different day counts for the same cohort — which would destroy the credibility of both.
 */

/** Milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

/** Everything read for one cohort. */
export interface CohortReading {
  readonly cohort: TestersCohort;
  readonly clock: CohortClock;
  readonly readings: readonly MemberReading[];
  /**
   * The event log the clock was replayed from.
   *
   * Carried rather than discarded so a caller can replay the same events as of a different moment —
   * the daily pass re-reads the finished previous day this way — without a second query for rows this
   * read has already loaded.
   */
  readonly events: readonly TestersEvent[];
}

/** Load one cohort, or raise the capability's own 404. */
export async function requireCohort(db: TestersDatabase, cohortId: string): Promise<TestersCohort> {
  const row = await db.selectFrom(TESTERS_COHORTS_TABLE).selectAll().where("id", "=", cohortId).executeTakeFirst();
  if (!row) throw new TestersCohortNotFoundError({ detail: `no cohort ${cohortId}` });
  return TestersCohort.parse(row);
}

/** Load every cohort, newest first. */
export async function listCohorts(db: TestersDatabase): Promise<TestersCohort[]> {
  const rows = await db.selectFrom(TESTERS_COHORTS_TABLE).selectAll().orderBy("createdAt", "desc").execute();
  return rows.map((row) => TestersCohort.parse(row));
}

/** Load a cohort's whole roster. */
export async function listMembers(db: TestersDatabase, cohortId: string): Promise<TestersMember[]> {
  const rows = await db
    .selectFrom(TESTERS_MEMBERS_TABLE)
    .selectAll()
    .where("cohortId", "=", cohortId)
    .orderBy("invitedAt", "asc")
    .execute();
  return rows.map((row) => TestersMember.parse(row));
}

/** Load a cohort's whole event history, oldest first — the order the clock replays in. */
export async function listEvents(db: TestersDatabase, cohortId: string): Promise<TestersEvent[]> {
  const rows = await db
    .selectFrom(TESTERS_EVENTS_TABLE)
    .selectAll()
    .where("cohortId", "=", cohortId)
    .orderBy("occurredAt", "asc")
    .execute();
  return rows.map((row) => TestersEvent.parse(row));
}

/** Load the trailing daily snapshots for a cohort, oldest first. */
export async function listSnapshots(
  db: TestersDatabase,
  cohortId: string,
  limit: number,
): Promise<TestersCohortSnapshot[]> {
  const rows = await db
    .selectFrom(TESTERS_SNAPSHOTS_TABLE)
    .selectAll()
    .where("cohortId", "=", cohortId)
    .orderBy("snapshotOn", "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => TestersCohortSnapshot.parse(row)).reverse();
}

/** One snapshot by day, for the trend deltas. */
export async function snapshotOn(
  db: TestersDatabase,
  cohortId: string,
  day: string,
): Promise<TestersCohortSnapshot | undefined> {
  const row = await db
    .selectFrom(TESTERS_SNAPSHOTS_TABLE)
    .selectAll()
    .where("cohortId", "=", cohortId)
    .where("snapshotOn", "=", day)
    .executeTakeFirst();
  return row ? TestersCohortSnapshot.parse(row) : undefined;
}

/** How many snapshots a cohort has. Drives whether a trend can be stated at all. */
export async function countSnapshots(db: TestersDatabase, cohortId: string): Promise<number> {
  const row = await db
    .selectFrom(TESTERS_SNAPSHOTS_TABLE)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("cohortId", "=", cohortId)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * Read one cohort in full: the roster, the replayed clock, and observed activity for every member.
 *
 * The activity lookup is batched across the whole roster rather than run per tester, because this runs
 * inside a request as well as inside a Workflow, and a hundred-member cohort would otherwise be three
 * hundred round trips before the first byte of a response.
 *
 * `log` is the caller's logger, passed straight through to {@link resolveActivity}. An unreadable
 * activity read degrades the whole roster to "never signed in", which is indistinguishable from a
 * genuinely inactive cohort — so the caller's logger is the only thing that says why. Defaults to the
 * no-op so a caller with nothing to log through still reads.
 */
export async function readCohort(
  db: TestersDatabase,
  d1: D1Database,
  cohort: TestersCohort,
  config: TestersConfig,
  now: Date,
  log: Logger = noopLogger,
): Promise<CohortReading> {
  const members = await listMembers(db, cohort.id);
  const events = await listEvents(db, cohort.id);

  const clock = readClock(
    {
      createdAt: cohort.createdAt,
      targetSize: cohort.targetSize,
      windowDays: cohort.windowDays,
      resetPolicy: cohort.resetPolicy,
    },
    events,
    now,
  );

  const unreachable = new Set(members.filter((member) => member.unreachable).map((member) => member.email));
  const activity = await resolveActivity(
    d1,
    members.map((member) => member.email),
    {
      since: new Date(now.getTime() - cohort.windowDays * MS_PER_DAY),
      activeSince: new Date(now.getTime() - config.activeWithinDays * MS_PER_DAY),
      unreachable,
    },
    log,
  );

  const readings: MemberReading[] = members.map((member) => ({
    member,
    activity:
      activity.get(member.email) ??
      ({
        email: member.email,
        userId: null,
        observability: member.unreachable ? "unreachable" : "unobservable",
        state: member.unreachable ? "unreachable" : "never_linked",
        lastAuthenticatedAt: null,
        sessionsInWindow: 0,
        devices: [],
      } satisfies TesterActivity),
  }));

  return { cohort, clock, readings, events };
}

/**
 * How many observed testers first crossed into darkness in the last week.
 *
 * Feeds the trend sentence rather than the direction: "two testers went dark this week" is what a
 * developer can act on, where "the forecast fell 0.07" is what a chart shows.
 */
export function newlyDark(readings: readonly MemberReading[], now: Date, threshold = 3): number {
  return readings.filter((reading) => {
    if (reading.activity.observability !== "observed" || !reading.activity.lastAuthenticatedAt) return false;
    // The same opt-in floor the health score and the darkness histogram apply. This was the one
    // darkness consumer left measuring from the raw last-authentication, so the trend sentence
    // ("two testers went dark") could contradict the histogram on the very same snapshot row.
    const dark = daysSince(lastSignOfLife(reading) ?? reading.activity.lastAuthenticatedAt, now);
    return dark >= threshold && dark <= 7;
  }).length;
}

/** The day key for `now`, so callers and the builder agree on which day they are writing. */
export function todayKey(now: Date): string {
  return dayKey(now);
}

/**
 * Resolve a cohort by id or by name.
 *
 * The CLI takes whichever the developer has to hand, and a name is what they actually remember. Ids
 * are tried first: a cohort deliberately named after another's id is a contrived case, and preferring
 * the id keeps the lookup unambiguous for a management client that only ever has one.
 */
export async function resolveCohortRef(db: TestersDatabase, ref: string): Promise<TestersCohort> {
  const byId = await db.selectFrom(TESTERS_COHORTS_TABLE).selectAll().where("id", "=", ref).executeTakeFirst();
  if (byId) return TestersCohort.parse(byId);
  const byName = await db.selectFrom(TESTERS_COHORTS_TABLE).selectAll().where("name", "=", ref).executeTakeFirst();
  if (byName) return TestersCohort.parse(byName);
  throw new TestersCohortNotFoundError({ detail: `no cohort with id or name ${ref}` });
}
