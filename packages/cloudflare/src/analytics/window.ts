// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";
import type { DatasetLimits } from "./analyticsManager";

/**
 * **The window an analytics read covers, and the limits it is held to (#728, #731).**
 *
 * Written once for every capability that reads Cloudflare's GraphQL Analytics. The rules are the same for
 * each: the last {@link DEFAULT_WINDOW_DAYS} days by default, a window that ends before it starts refused,
 * and a window past the dataset's retention or wider than one read may ask for refused, naming the cap in
 * days. The refusal is each caller's own code, so it is handed to a factory rather than thrown here.
 */

/** The default window, in days, ending now. Fits every dataset the kit reads. */
export const DEFAULT_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** A resolved window: `since` inclusive, `until` exclusive. */
export interface AnalyticsWindow {
  since: Date;
  until: Date;
}

/** Why a window was refused, in the fields a caller's error class takes. */
export interface WindowRefusal {
  /** The sentence the caller reads. */
  message: string;
  /** The cap and the dataset, for a client that translates. */
  params?: MessageParams;
  /** The numbers behind it, for the log. */
  detail: string;
}

/** Builds the caller's own error for a refused window. */
export type RefuseWindow = (refusal: WindowRefusal) => Error;

/** One dataset as a read names it: the GraphQL node, and how an operator would say it. */
export interface MeasuredDataset {
  dataset: string;
  label: string;
}

/** Whole days in a span of seconds, for a cap stated to a person. */
function days(seconds: number): number {
  return Math.floor(seconds / 86_400);
}

/**
 * The window a request asks for: the last {@link DEFAULT_WINDOW_DAYS} days by default, a `since` alone
 * running to now, and an `until` alone reaching back the default span. A window that ends before it
 * starts is refused.
 */
export function resolveAnalyticsWindow(
  input: { since?: Date; until?: Date },
  now: Date,
  refuse: RefuseWindow,
): AnalyticsWindow {
  const until = input.until ?? now;
  const since = input.since ?? new Date(until.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (since.getTime() >= until.getTime()) {
    throw refuse({
      message: "That window ends before it starts. Put since before until.",
      detail: `since ${since.toISOString()} is not before until ${until.toISOString()}`,
    });
  }
  return { since, until };
}

/**
 * Hold a window to one dataset's limits, read from the account's own settings rather than assumed. The
 * refusal names the cap in days, so a caller can pick a window that works.
 */
export function checkAnalyticsWindow(
  window: AnalyticsWindow,
  limits: DatasetLimits,
  measured: MeasuredDataset,
  now: Date,
  refuse: RefuseWindow,
): void {
  const reach = (now.getTime() - window.since.getTime()) / 1000;
  if (reach > limits.notOlderThan) {
    const maxDays = days(limits.notOlderThan);
    throw refuse({
      message: `That window starts ${days(reach)} days ago. Cloudflare keeps ${measured.label} for ${maxDays} days.`,
      params: { maxDays, dataset: measured.dataset },
      detail: `${measured.dataset} notOlderThan ${limits.notOlderThan}s; window reaches ${Math.round(reach)}s`,
    });
  }
  const span = (window.until.getTime() - window.since.getTime()) / 1000;
  if (span > limits.maxDuration) {
    const maxDays = days(limits.maxDuration);
    throw refuse({
      message: `That window spans ${days(span)} days. Cloudflare answers at most ${maxDays} days of ${measured.label} at once.`,
      params: { maxDays, dataset: measured.dataset },
      detail: `${measured.dataset} maxDuration ${limits.maxDuration}s; window spans ${Math.round(span)}s`,
    });
  }
}
