// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * UTC day keys — the `YYYY-MM-DD` strings the clock and the snapshot series are indexed by.
 *
 * **Why a string day rather than a timestamp.** Google's continuous-days counter runs on a day
 * boundary that is neither documented nor readable, so Pithy picks one, uses it everywhere, and says
 * which one it picked. UTC is the choice. Storing the day as text makes that choice total: the unique
 * index on `(cohortId, snapshotOn)` is exact, day arithmetic never picks up an hour of drift from a
 * server's locale, and two snapshots can never disagree about which day they describe because there is
 * no timezone left in the value to disagree about.
 *
 * The consequence a developer must know, and the docs say so plainly: Pithy's day fourteen may not be
 * Google's day fourteen. Which is one more reason not to start trusting the estimate on day thirteen.
 */

/** Milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

/** A UTC day key: `YYYY-MM-DD`. */
export type DayKey = string;

/** The UTC day a moment falls in. */
export function dayKey(at: Date): DayKey {
  return at.toISOString().slice(0, 10);
}

/** Midnight UTC at the start of a day key — the instant the day begins. */
export function startOfDay(day: DayKey): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The last instant of a day key, inclusive. Everything at or before this happened on or before `day`. */
export function endOfDay(day: DayKey): Date {
  return new Date(startOfDay(day).getTime() + MS_PER_DAY - 1);
}

/** The day key `count` days after `day`. Negative counts go backwards. */
export function addDays(day: DayKey, count: number): DayKey {
  return dayKey(new Date(startOfDay(day).getTime() + count * MS_PER_DAY));
}

/**
 * Whole days from `from` to `to`, signed. Exact rather than approximate, because both ends are
 * midnight UTC by construction — no DST, no leap-second rounding, no off-by-one on the last day of a
 * cohort.
 */
export function daysBetween(from: DayKey, to: DayKey): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / MS_PER_DAY);
}

/** Every day key from `from` to `to`, inclusive, ascending. Empty when `to` precedes `from`. */
export function dayRange(from: DayKey, to: DayKey): DayKey[] {
  const span = daysBetween(from, to);
  if (span < 0) return [];
  const days: DayKey[] = [];
  for (let offset = 0; offset <= span; offset++) days.push(addDays(from, offset));
  return days;
}

/**
 * Whole days a moment is in the past, relative to `now`, floored at zero.
 *
 * Floored deliberately: a clock skew that puts a session's timestamp a few seconds in the future should
 * read as "seen just now", not as negative days dark, which would score a tester as impossibly healthy.
 */
export function daysSince(at: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / MS_PER_DAY));
}
