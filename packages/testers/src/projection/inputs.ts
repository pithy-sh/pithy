// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type DayKey, dayKey, daysBetween } from "../clock/days";
import type { TestersMember } from "../data/member";

/**
 * The two forecast inputs derived from the roster rather than passed in, in one place.
 *
 * `forecastCohort` has two callers — `buildSnapshot`, which writes the daily row, and `toCohortView`,
 * which answers `GET /testers/cohorts` — and they must hand it identical inputs or the card and the
 * chart give a developer two different completion dates for the same cohort on the same morning. They
 * did. The view passed `medianConversionDays: null, conversionSampleSize: 0`, which can never clear
 * the five-conversion evidence gate, so every live read used the three-day default prior no matter how
 * many conversions the cohort had actually measured; and it computed the cohort's age from elapsed
 * milliseconds while the builder used UTC day keys, so the two disagreed by one for most of any day.
 *
 * Both are now derived here, and both callers call these functions. Divergence is a change to this
 * file rather than something that can happen by omission.
 */

/** The measured invite-to-opt-in latency, and how much evidence stands behind it. */
export interface ConversionLatency {
  /** The median days from invitation to opt-in, or null when nobody has converted yet. */
  readonly medianConversionDays: number | null;
  /** How many conversions that median is drawn from — the forecast gates on this before trusting it. */
  readonly conversionSampleSize: number;
}

/** The middle value, rounded on an even count. Shared, because the health series takes a median too. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/**
 * How long this cohort's own testers take to go from invited to opted in.
 *
 * Day keys rather than elapsed milliseconds, so an invitation at 23:00 and an opt-in at 01:00 counts
 * as one day rather than zero. Negative spans are dropped rather than clamped: they mean the two
 * timestamps disagree, and a corrupt row should not pull the median toward zero.
 */
export function conversionLatency(members: readonly TestersMember[]): ConversionLatency {
  const conversions = members
    .filter((member) => member.optedInAt !== null)
    .map((member) => daysBetween(dayKey(member.invitedAt), dayKey(member.optedInAt as Date)))
    .filter((days) => days >= 0);
  return { medianConversionDays: median(conversions), conversionSampleSize: conversions.length };
}

/**
 * How old the cohort is, in whole UTC days.
 *
 * Day keys, because the forecast reads this at two hard thresholds — seven days for `high` confidence,
 * zero days for a `no_history` basis — and an hour of drift either side of a threshold is a different
 * answer on the wire. The whole package indexes on UTC day keys for exactly this reason.
 */
export function cohortAgeDays(createdAt: Date, today: DayKey): number {
  return Math.max(0, daysBetween(dayKey(createdAt), today));
}
