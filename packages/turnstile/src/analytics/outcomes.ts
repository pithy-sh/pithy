// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { TurnstileOutcomes } from "../http/responses";

/**
 * **What Cloudflare's Turnstile event types mean, in the terms an operator asks about (#731).**
 *
 * The types are the ones Cloudflare documents for its Turnstile events
 * (https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/turnstile_events/), the same
 * event stream `turnstileAdaptiveGroups` counts. A challenge is issued, then solved or not; a solved token is
 * then checked by this Worker's siteverify call, which accepts or refuses it. Unsolved is issued less solved,
 * which is how Cloudflare reports it too: an abandoned challenge emits no event of its own.
 */

/** A challenge was presented to a visitor. */
const ISSUED = ["challenge_issued"];

/** A visitor solved a challenge, with or without interacting. */
const SOLVED = ["challenge_non_interactive_solved", "challenge_interactive_solved"];

/** Siteverify accepted a solved token. */
const SITEVERIFY_PASSED = [
  "challenge_non_interactive_siteverify_solved",
  "challenge_interactive_siteverify_solved",
  "challenge_clearance_siteverify_solved",
];

/** Siteverify refused a token: spent twice, invalid, otherwise failed, or rate-limited. */
const SITEVERIFY_REFUSED = [
  "challenge_siteverify_failed_double_redemption",
  "challenge_siteverify_failed_invalid_token",
  "challenge_siteverify_failed_other",
  "challenge_siteverify_ratelimited",
];

/** The total of the event types named. */
function total(events: ReadonlyMap<string, number>, types: readonly string[]): number {
  return types.reduce((sum, type) => sum + (events.get(type) ?? 0), 0);
}

/**
 * One widget's events, as outcomes. Every type is also listed as Cloudflare counted it, most first, so a type
 * Cloudflare adds after this was written is reported rather than dropped.
 *
 * The dataset samples adaptively, so the counts are estimates and solves can exceed issues in a thin window.
 * Unsolved is held at zero and the rate at one rather than reported as a negative.
 */
export function summarizeOutcomes(events: ReadonlyMap<string, number>): TurnstileOutcomes {
  const issued = total(events, ISSUED);
  const solved = total(events, SOLVED);
  return {
    issued,
    solved,
    unsolved: Math.max(0, issued - solved),
    solveRate: issued === 0 ? null : Math.min(1, solved / issued),
    siteverify: { passed: total(events, SITEVERIFY_PASSED), refused: total(events, SITEVERIFY_REFUSED) },
    events: [...events]
      .map(([eventType, count]) => ({ eventType, count }))
      .sort((a, b) => b.count - a.count || a.eventType.localeCompare(b.eventType)),
  };
}
