// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ResetPolicy } from "../config/config";
import type { MemberState } from "../data/enums";
import type { TestersEvent } from "../data/event";
import { addDays, type DayKey, dayKey, dayRange, endOfDay } from "./days";

/**
 * The clock: roster state and the estimated continuous-day streak, replayed from the event log.
 *
 * **Nothing here reads a stored counter, and that is the design.** A counter can only be overwritten,
 * which means a correction destroys both the old value and the evidence that it changed. Replaying
 * makes a correction an insert: add the event that was missing, recompute, and every snapshot written
 * before it survives as an accurate record of what Pithy believed on that day. A trend chart is
 * claiming to show exactly that, so it has to be true.
 *
 * **This module computes Pithy's estimate. It is not Google's number and cannot be.** Google's opt-in
 * streak is computed by Play Console and exposed by no API — not the count, not the streak, not a
 * tester's opt-out. What is replayed here is our own record of who followed our own confirmation link,
 * which is a well-informed estimate of Google's figure and diverges from it whenever a tester opts out
 * without telling anyone. Every field this module produces is named `estimated*` for that reason.
 */

/** One member's opt-in history, reduced to the transitions the count depends on. */
interface MemberTimeline {
  memberId: string;
  /** Every state-moving event, ascending. `nudged` and `reinvited` are dropped — they move nothing. */
  transitions: { at: Date; kind: "invited" | "accepted" | "opted_in" | "lapsed" | "removed" }[];
}

/** The event kinds that move a member's state. The other two are outreach history. */
const STATE_MOVING = new Set(["invited", "accepted", "opted_in", "lapsed", "removed"]);

/**
 * Group events into per-member timelines, ordered by when they *happened* rather than when they were
 * written.
 *
 * The distinction is not pedantic. An opt-in confirmed on a phone with a stale clock, or a backfill
 * that lands a week late, arrives with an `occurredAt` earlier than its `createdAt` — and replaying by
 * insertion order would file it under the wrong day, which for a continuous-days counter is the
 * difference between a completed window and a reset one.
 */
export function buildTimelines(events: readonly TestersEvent[]): Map<string, MemberTimeline> {
  const timelines = new Map<string, MemberTimeline>();
  for (const event of events) {
    if (!STATE_MOVING.has(event.kind)) continue;
    const timeline = timelines.get(event.memberId) ?? { memberId: event.memberId, transitions: [] };
    timeline.transitions.push({
      at: event.occurredAt,
      kind: event.kind as MemberTimeline["transitions"][number]["kind"],
    });
    timelines.set(event.memberId, timeline);
  }
  for (const timeline of timelines.values()) {
    timeline.transitions.sort((a, b) => a.at.getTime() - b.at.getTime());
  }
  return timelines;
}

/**
 * A member's state as of the end of a given UTC day.
 *
 * The rule is "the last state-moving transition at or before this day wins", which is what makes
 * re-opting-in work correctly: a tester who opted in, lapsed, and opted in again is counted from the
 * second confirmation, and the days between do not count. Google's rule is the same — it explicitly
 * does not credit fourteen non-consecutive days — so this is one of the few places the two models are
 * known to agree.
 */
export function stateOn(timeline: MemberTimeline, day: DayKey): MemberState | undefined {
  const cutoff = endOfDay(day).getTime();
  let state: MemberState | undefined;
  for (const transition of timeline.transitions) {
    if (transition.at.getTime() > cutoff) break;
    state = transition.kind;
  }
  return state;
}

/** How many members were opted in at the end of a given UTC day — Pithy's estimate of Google's count. */
export function optedInOn(timelines: Map<string, MemberTimeline>, day: DayKey): number {
  let count = 0;
  for (const timeline of timelines.values()) {
    if (stateOn(timeline, day) === "opted_in") count++;
  }
  return count;
}

/** What the clock reads for one cohort, as of one day. Every figure is an estimate. */
export interface CohortClock {
  /** The day this reading describes. */
  readonly on: DayKey;
  /** Pithy's estimate of the opted-in count on this day. */
  readonly estimatedOptedInCount: number;
  /** Whether the estimate reached the target on this day. */
  readonly meetsTarget: boolean;
  /** Estimated count minus target. Zero means one lapse from a reset; it can go negative. */
  readonly headroom: number;
  /** The estimated unbroken run of at-target days ending on this day. */
  readonly estimatedHeldDays: number;
  /** The day the current run began, or null while below target. */
  readonly estimatedWindowStartOn: DayKey | null;
  /** Window days still to hold, floored at zero. */
  readonly estimatedDaysRemaining: number;
  /** How many times the run has broken since the cohort started. */
  readonly resetCount: number;
  /** Whether the run broke on this day — the annotation a cohort chart most needs. */
  readonly resetToday: boolean;
  /** The full daily series the reading was computed from, oldest first. Feeds the chart and the tests. */
  readonly series: readonly { day: DayKey; optedIn: number; meetsTarget: boolean }[];
}

/** What `readClock` needs to know about the cohort it is reading. */
export interface ClockInput {
  /** The cohort's creation moment — the first day of the series. */
  readonly createdAt: Date;
  /** The target in force. Read from the cohort row, not from config: the row's copy is frozen. */
  readonly targetSize: number;
  /** The window in force, in days. */
  readonly windowDays: number;
  /** What a dip below target does to the run. Pithy's assumption, not Google's documented behaviour. */
  readonly resetPolicy: ResetPolicy;
}

/**
 * Read the clock for a cohort as of `now`.
 *
 * **On `resetPolicy`.** We do not know whether Play pauses or restarts the counter when a cohort dips
 * to eleven. `reset` is the default and it is the pessimistic reading: it says you have further to go
 * than `pause` would. That asymmetry is deliberate. A developer told they are on day fourteen when
 * they are really on day three applies for production access, gets rejected, and blames the tool; a
 * developer told day three when they were really on day fourteen waits an extra week and shrugs. Only
 * one of those is worth defending against.
 */
export function readClock(input: ClockInput, events: readonly TestersEvent[], now: Date): CohortClock {
  const timelines = buildTimelines(events);
  const today = dayKey(now);
  const start = dayKey(input.createdAt);
  // A cohort created later than `now` (a clock skew, a seeded fixture) would otherwise produce an empty
  // range and a series with no `today` in it, so the range is clamped to at least the current day.
  const days = dayRange(start > today ? today : start, today);

  const series = days.map((day) => {
    const optedIn = optedInOn(timelines, day);
    return { day, optedIn, meetsTarget: optedIn >= input.targetSize };
  });

  let resetCount = 0;
  for (let index = 1; index < series.length; index++) {
    // A break is a fall from at-target to below it. The first day of a cohort cannot be a break, and a
    // cohort that has never reached target has never broken — it has simply not started.
    if (series[index - 1]?.meetsTarget === true && series[index]?.meetsTarget === false) resetCount++;
  }

  const last = series[series.length - 1];
  const meetsTarget = last?.meetsTarget ?? false;
  const optedIn = last?.optedIn ?? 0;

  let heldDays = 0;
  if (input.resetPolicy === "pause") {
    // Pause: every at-target day ever banked counts, whatever happened between them.
    heldDays = series.filter((entry) => entry.meetsTarget).length;
  } else {
    // Reset: only the unbroken tail counts. Walk backwards until the run breaks.
    for (let index = series.length - 1; index >= 0; index--) {
      if (series[index]?.meetsTarget !== true) break;
      heldDays++;
    }
  }

  // The run's start is only meaningful under `reset`, where the tail is contiguous. Under `pause` the
  // banked days need not be adjacent, so there is no single day the run "began" — reporting one would
  // be inventing a fact to fill a field.
  const windowStartOn = input.resetPolicy === "reset" && heldDays > 0 ? addDays(today, -(heldDays - 1)) : null;

  const previous = series[series.length - 2];

  return {
    on: today,
    estimatedOptedInCount: optedIn,
    meetsTarget,
    headroom: optedIn - input.targetSize,
    estimatedHeldDays: heldDays,
    estimatedWindowStartOn: windowStartOn,
    estimatedDaysRemaining: Math.max(0, input.windowDays - heldDays),
    resetCount,
    resetToday: previous?.meetsTarget === true && !meetsTarget,
    series,
  };
}
