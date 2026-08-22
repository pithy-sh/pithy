// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The exact distribution of "how many of these testers are still opted in when the window closes".
 *
 * Each tester has their own survival probability — a tester who opens the app daily and one who has
 * been dark for nine days are not the same coin — so the count of survivors is Poisson-binomial rather
 * than binomial, and there is no closed form for it.
 *
 * **Exact dynamic programming, not a normal approximation and not Monte Carlo.** The DP is one
 * convolution per tester, so a hundred-person roster is about ten thousand multiply-adds: fast enough
 * to run inside a request, and it buys three things an approximation would not. It is deterministic,
 * so the same roster always yields the same number and a test can assert an exact value rather than a
 * tolerance. It is exact in the tail, which is the only region anyone cares about — "at least twelve of
 * fourteen" is a tail question, and the normal approximation is at its worst there, on small n with
 * heterogeneous and near-one probabilities, which describes every cohort this package will ever see.
 * And it is explainable in one sentence: we roll each tester's chance of lasting the remaining days into
 * the exact odds that at least twelve of them do. A developer can audit that. Nobody can audit a seed.
 */

/**
 * The full distribution: `result[k]` is the probability that exactly `k` of the given testers survive.
 *
 * The array is `probabilities.length + 1` long, because zero survivors is an outcome too — and for a
 * cohort of four people trying to hold twelve, it is not even an unlikely one.
 */
export function survivorDistribution(probabilities: readonly number[]): number[] {
  // The empty roster has exactly one outcome: nobody survives, with certainty.
  let distribution = [1];
  for (const probability of probabilities) {
    const next = new Array<number>(distribution.length + 1).fill(0);
    for (let survivors = 0; survivors < distribution.length; survivors++) {
      const mass = distribution[survivors] ?? 0;
      if (mass === 0) continue;
      // This tester either lasts, moving the mass one place up, or does not, leaving it where it is.
      next[survivors] = (next[survivors] ?? 0) + mass * (1 - probability);
      next[survivors + 1] = (next[survivors + 1] ?? 0) + mass * probability;
    }
    distribution = next;
  }
  return distribution;
}

/**
 * The probability that at least `atLeast` of these testers survive.
 *
 * Summed from the top down rather than as `1 - P(fewer)`, because the interesting answers live in the
 * upper tail and subtracting two near-equal numbers there loses precision exactly where the result
 * matters most.
 */
export function probabilityAtLeast(probabilities: readonly number[], atLeast: number): number {
  // Needing none of them is certain; needing more of them than exist is impossible. Both are worth
  // answering directly rather than letting the sum arrive at them, so the caller never has to reason
  // about an empty range.
  if (atLeast <= 0) return 1;
  if (atLeast > probabilities.length) return 0;

  const distribution = survivorDistribution(probabilities);
  let total = 0;
  for (let survivors = distribution.length - 1; survivors >= atLeast; survivors--) {
    total += distribution[survivors] ?? 0;
  }
  // Floating-point accumulation over a hundred convolutions can land a hair outside [0,1]; a
  // probability that renders as 1.0000000000000002 is a bug report waiting to happen.
  return Math.min(1, Math.max(0, total));
}

/**
 * How many testers we expect to survive — the sum of the individual probabilities.
 *
 * The most interpretable number the model produces, and the one that goes on the card: "we expect 11.3
 * of your 14 to still be in on day fourteen" is a sentence a developer can act on, where a percentage
 * is a sentence they can only feel something about.
 */
export function expectedSurvivors(probabilities: readonly number[]): number {
  return probabilities.reduce((total, probability) => total + probability, 0);
}

/**
 * A tester's chance of lasting `days` more days, at a given per-day survival rate.
 *
 * Independence across days is assumed and stated. It is not quite true — a tester who uninstalls is
 * gone for every subsequent day, not independently gone each day — but the per-day rate is already
 * calibrated against that behavior rather than against a memoryless process, and a hazard model would
 * add parameters nobody can audit to a number that is a declared prior in the first place.
 */
export function survivalOverDays(dailySurvival: number, days: number): number {
  if (days <= 0) return 1;
  return dailySurvival ** days;
}
