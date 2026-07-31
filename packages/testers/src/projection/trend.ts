// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { TrendDirection } from "../data/enums";

/**
 * The trend: which way a cohort is heading, and one sentence saying why.
 *
 * **A published rule, not a fit.** Three inputs, evaluated in a fixed order, with the thresholds
 * written down. A developer looking at a red arrow can work out exactly what produced it, which is the
 * whole difference between a signal they will act on and one they will learn to ignore.
 *
 * **The deltas are precomputed onto the snapshot row rather than derived on read.** That is what lets a
 * summary card render from one row — no client-side series arithmetic, and therefore no way for the
 * card and the chart to disagree about the same cohort. It also means the delta recorded on a day is
 * the delta as it was computed on that day, which survives a later correction to history.
 *
 * **`fragile` is deliberately not a direction.** A cohort can be improving and fragile at the same
 * time — three new opt-ins this week and still sitting at exactly twelve with someone dark for nine
 * days — and collapsing that into one enum would lose whichever of the two is more urgent. It gets its
 * own boolean and earns its own badge.
 */

/** Fewer snapshots than this and there is no trend, only noise. */
const MIN_SNAPSHOTS_FOR_TREND = 3;

/** A forecast move of at least this much over a week is a direction rather than a wobble. */
const SIGNIFICANT_PROBABILITY_DELTA = 0.05;

/** One earlier snapshot, reduced to what the trend rule reads. */
export interface TrendPoint {
  readonly estimatedOptedInCount: number;
  readonly activeCount: number;
  readonly successProbability: number | null;
}

/** Today's position, plus the history to measure it against. */
export interface TrendInput {
  readonly today: TrendPoint;
  /** Yesterday's snapshot, or null if there is none. */
  readonly yesterday: TrendPoint | null;
  /** The snapshot from seven days ago, or null if the cohort is younger than that. */
  readonly weekAgo: TrendPoint | null;
  /** How many snapshots exist in total, including today's. */
  readonly snapshotCount: number;
  /** Whether the cohort is at target with zero headroom right now. */
  readonly atTargetWithNoHeadroom: boolean;
  /** How many currently opted-in testers are at-risk or critical. */
  readonly weakMemberCount: number;
  /** How many testers went dark in the last week — for the sentence, not the direction. */
  readonly newlyDarkCount: number;
}

/** The computed trend: the deltas, the direction, the fragility flag, and the sentence. */
export interface Trend {
  readonly optedInDelta1d: number | null;
  readonly optedInDelta7d: number | null;
  readonly activeDelta7d: number | null;
  readonly successProbabilityDelta1d: number | null;
  readonly successProbabilityDelta7d: number | null;
  readonly direction: TrendDirection;
  readonly fragile: boolean;
  /** One brand-voice sentence explaining the direction, for rendering beside the arrow. */
  readonly reason: string;
}

/** A difference, or null when either end is missing. */
function delta(current: number | null, previous: number | null | undefined): number | null {
  if (current === null || previous === null || previous === undefined) return null;
  return current - previous;
}

/** Compute the trend. */
export function computeTrend(input: TrendInput): Trend {
  const optedInDelta1d = input.yesterday
    ? input.today.estimatedOptedInCount - input.yesterday.estimatedOptedInCount
    : null;
  const optedInDelta7d = input.weekAgo ? input.today.estimatedOptedInCount - input.weekAgo.estimatedOptedInCount : null;
  const activeDelta7d = input.weekAgo ? input.today.activeCount - input.weekAgo.activeCount : null;
  const probabilityDelta1d = delta(input.today.successProbability, input.yesterday?.successProbability);
  const probabilityDelta7d = delta(input.today.successProbability, input.weekAgo?.successProbability);

  const fragile = input.atTargetWithNoHeadroom && input.weakMemberCount > 0;

  // The week is the preferred window, and yesterday is the fallback rather than an addition. A cohort
  // with three to seven snapshots has no `weekAgo` at all — the lookup is an exact-day match — so the
  // weekly deltas are null through the whole first week, and a rule reading only them had nothing to
  // read for half the window it exists to watch.
  const window: TrendWindow =
    optedInDelta7d !== null || probabilityDelta7d !== null
      ? { span: "week", optedIn: optedInDelta7d, probability: probabilityDelta7d }
      : { span: "day", optedIn: optedInDelta1d, probability: probabilityDelta1d };

  const { direction, reason } = classify(input, window, fragile);

  return {
    optedInDelta1d,
    optedInDelta7d,
    activeDelta7d,
    successProbabilityDelta1d: probabilityDelta1d,
    successProbabilityDelta7d: probabilityDelta7d,
    direction,
    fragile,
    reason,
  };
}

/** Whichever comparison the rule had data for, and how to say it. */
interface TrendWindow {
  readonly span: "week" | "day";
  readonly optedIn: number | null;
  readonly probability: number | null;
}

/** The rule itself, evaluated in order, with the sentence each branch produces. */
function classify(
  input: TrendInput,
  window: TrendWindow,
  fragile: boolean,
): { direction: TrendDirection; reason: string } {
  // Two points make a straight line through noise. Say so rather than draw it.
  if (input.snapshotCount < MIN_SNAPSHOTS_FOR_TREND) {
    return { direction: "unknown", reason: "Not enough history yet." };
  }

  // Neither window had an end to measure against. `steady` is a claim, and the deltas go null
  // specifically so that absent data never renders as "no change" — the direction has to obey the same
  // rule the numbers do.
  if (window.optedIn === null && window.probability === null) {
    return { direction: "unknown", reason: "Not enough history yet." };
  }

  const since = window.span === "week" ? "this week" : "since yesterday";
  const optedInDelta7d = window.optedIn;
  const probabilityDelta7d = window.probability;

  const losingTesters = optedInDelta7d !== null && optedInDelta7d < 0;
  const losingConfidence = probabilityDelta7d !== null && probabilityDelta7d <= -SIGNIFICANT_PROBABILITY_DELTA;

  if (losingTesters || losingConfidence) {
    if (losingTesters) {
      const lost = Math.abs(optedInDelta7d as number);
      return {
        direction: "declining",
        reason: lost === 1 ? `One tester dropped out ${since}.` : `${lost} testers dropped out ${since}.`,
      };
    }
    if (input.newlyDarkCount > 0) {
      // Not `since` — this one is not a windowed delta. `newlyDark` counts testers whose darkness is
      // *currently* between three and seven days, measured against now alone, so every one of them
      // went quiet at least three days ago. Saying "since yesterday" about that would be false by
      // construction on any cohort young enough to take the daily window.
      return {
        direction: "declining",
        reason:
          input.newlyDarkCount === 1
            ? "One tester has gone quiet this week."
            : `${input.newlyDarkCount} testers have gone quiet this week.`,
      };
    }
    return { direction: "declining", reason: `The forecast has fallen ${since}.` };
  }

  const gainingTesters = optedInDelta7d !== null && optedInDelta7d > 0;
  const gainingConfidence = probabilityDelta7d !== null && probabilityDelta7d >= SIGNIFICANT_PROBABILITY_DELTA;

  if (gainingTesters || gainingConfidence) {
    if (gainingTesters) {
      const gained = optedInDelta7d as number;
      return {
        direction: "improving",
        reason: gained === 1 ? `One more opt-in ${since}.` : `${gained} more opt-ins ${since}.`,
      };
    }
    return { direction: "improving", reason: `The forecast has risen ${since}.` };
  }

  // Steady is the residual, and it still has two flavours worth distinguishing: holding comfortably,
  // and holding with nothing to spare. The second reads as fine on a count and is one lapse from a
  // reset, which is exactly the state a developer needs told rather than left to infer.
  if (fragile) {
    return { direction: "steady", reason: "Holding at target. No headroom." };
  }
  return { direction: "steady", reason: `Steady ${since}.` };
}
