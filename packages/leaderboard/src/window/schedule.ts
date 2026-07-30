// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Cron } from "croner";
import { LeaderboardInvalidScheduleError } from "../error/errors";

/**
 * Window keys. A board's `window` is a CRON expression; the window a score falls into is keyed by the
 * instant that CRON last fired at or before the score. Omitting the schedule means one all-time window.
 *
 * CRON — rather than a fixed `daily|weekly|monthly|all-time` enum — is what lets a board align to the
 * calendar. Apple caps leaderboard recurrence at 30 days and expresses it as a fixed duration, so a
 * calendar month (28/29/30/31 days) is not expressible there and a calendar year is impossible; Google
 * Play Games Services ships daily/weekly/all-time and no monthly at all. `0 0 1 * *` and `0 0 1 1 *`
 * cost us nothing extra because `rank: { materialize: <cron> }` already needs a parser.
 *
 * Every derivation is UTC-anchored. The host's local timezone must never move a window boundary, or the
 * same submission would key differently on two Workers.
 */

/** The window key for a board with no schedule: one window, open forever. */
export const ALL_TIME_WINDOW = "all";

/**
 * Lookback rungs for {@link lastFireAtOrBefore}, smallest first.
 *
 * croner can only walk *forward* (`nextRun`); its `previousRun` reports a live job's last execution, not
 * a historical period start, so finding the window a past instant falls into means searching back. The
 * ladder keeps that search cheap for every cadence: a rung is tried only if the finer one found no fire,
 * so a per-minute board settles on the first rung after one step and a yearly board reaches the last rung
 * having walked one. That bounds the forward walk to roughly one period per rung instead of letting a
 * frequent board enumerate a year of fires. The final rung spans four years: `0 0 29 2 *` — a leap-day
 * board — only fires when February has 29 days.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const LOOKBACK_LADDER_MS = [MINUTE_MS, HOUR_MS, DAY_MS, 8 * DAY_MS, 40 * DAY_MS, 400 * DAY_MS, 1500 * DAY_MS];

/** How far ahead {@link assertValidSchedule} looks for a fire before calling an expression dead. */
const NEVER_FIRES_HORIZON = LOOKBACK_LADDER_MS[LOOKBACK_LADDER_MS.length - 1] as number;

function compile(schedule: string): Cron {
  try {
    // `timezone: "UTC"` is the anchor: without it croner resolves against the host zone and a board
    // boundary would drift by the deployment's offset.
    return new Cron(schedule, { timezone: "UTC" });
  } catch (cause) {
    throw new LeaderboardInvalidScheduleError(
      { detail: `Board schedule ${JSON.stringify(schedule)} is not a valid CRON expression.` },
      { cause },
    );
  }
}

/**
 * The latest fire at or before `at`, or null if the ladder's deepest rung found none.
 *
 * An instant exactly on a boundary belongs to the window it opens, not the one it closes — hence
 * `<= target` rather than `<`. Off by one here and a score landing precisely on the boundary files into
 * the window that just closed.
 */
function lastFireAtOrBefore(cron: Cron, at: Date): Date | null {
  const target = at.getTime();
  for (const lookback of LOOKBACK_LADDER_MS) {
    let candidate: Date | null = null;
    let cursor: Date | null = cron.nextRun(new Date(target - lookback));
    while (cursor && cursor.getTime() <= target) {
      candidate = cursor;
      cursor = cron.nextRun(cursor);
    }
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Validate a board's schedule at config time, so a typo fails at assembly rather than on the first
 * submission. An expression that parses but never fires (`0 0 30 2 *` — February 30) is rejected too:
 * it would strand every score with no window to key it to.
 */
export function assertValidSchedule(schedule: string): void {
  const cron = compile(schedule);
  if (!cron.nextRun(new Date(Date.now() - NEVER_FIRES_HORIZON))) {
    throw new LeaderboardInvalidScheduleError({
      message: "That board's window schedule never fires.",
      detail: `Board schedule ${JSON.stringify(schedule)} parses but never fires, so no window could ever open.`,
    });
  }
}

/** The key of the window `at` falls into: the ISO instant the board's CRON last fired at or before it. */
export function windowKeyAt(schedule: string | undefined, at: Date): string {
  if (schedule === undefined) return ALL_TIME_WINDOW;
  const start = lastFireAtOrBefore(compile(schedule), at);
  if (!start) {
    throw new LeaderboardInvalidScheduleError({
      detail: `Board schedule ${JSON.stringify(schedule)} has no fire at or before ${at.toISOString()}.`,
    });
  }
  return start.toISOString();
}

/**
 * The keys of the `count` windows closed behind the one `at` falls into, newest first. Retention prunes
 * everything older than the last of these.
 */
export function previousWindowKeys(schedule: string | undefined, at: Date, count: number): string[] {
  if (schedule === undefined || count <= 0) return [];
  const cron = compile(schedule);
  const keys: string[] = [];
  let cursor = lastFireAtOrBefore(cron, at);
  for (let i = 0; i < count; i++) {
    if (!cursor) break;
    // Step one millisecond behind this window's start to land inside the window before it.
    cursor = lastFireAtOrBefore(cron, new Date(cursor.getTime() - 1));
    if (cursor) keys.push(cursor.toISOString());
  }
  return keys;
}
