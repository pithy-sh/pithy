// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { messageOf, PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { CohortPassResult } from "./daily";

/**
 * What the daily pass says about itself: its tally, and each cohort it could not finish.
 *
 * Both are pure functions of a logger and a value, and both used to live in `worker.ts` beside the
 * Workflow class that calls them. That module imports `cloudflare:workers`, which resolves in workerd
 * and nowhere else, so everything it exported was reachable only from inside the Workers runtime — a
 * Node-side caller taking one of these would have taken the whole runtime module with it and failed
 * with `Could not load pithy.config.ts`, naming the config rather than the import.
 *
 * That is #172 and #180, twice, and neither was noticed until somebody accepted the offer. The shape
 * both were fixed into is this one: a sibling module with no runtime import, which the runtime module
 * imports from. `configEntrypoints.test.ts` states the invariant and holds every runtime module to it.
 *
 * Nothing here needs a binding, a request, or a Workers global, which is why its tests are node tests.
 */

/**
 * The pass's outcome, as one record. The run's only visible output: a pass whose findings are invisible
 * is a pass nobody can tell has stopped working.
 *
 * Two levels, and the distinction is the whole reason this is not one flat `info`. A cohort carrying
 * `nudgesSkipped` advanced its state and wrote its day but mailed nobody — the pass *looks* healthy and
 * nobody is being chased, which is the one failure mode this capability cannot afford, because silence
 * is also what success looks like. Everything else is routine, and a daily job that reports routine at
 * `warn` teaches an operator to stop reading it.
 */
export function logPassComplete(log: Logger, results: readonly CohortPassResult[]): void {
  const skipped = results.filter((result) => result.nudgesSkipped !== undefined).length;
  log[skipped > 0 ? "warn" : "info"]("daily pass complete", { cohorts: results.length, skipped, results });
}

/**
 * One cohort's failure, with its payload intact.
 *
 * A `PithyError` goes in the reserved `error` field so the record carries its code, its status and its
 * throw-site `detail` — a log is an internal surface, the inverse of the HTTP codec that strips it.
 * Anything else takes `reason`: a plain `Error`'s `message` and `stack` are non-enumerable, so the
 * reserved field would serialize it to `{}` and lose the only thing it had to say.
 */
export function logCohortFailure(log: Logger, cohortId: string, error: unknown): void {
  log.error("cohort pass failed", {
    cohort: cohortId,
    ...(error instanceof PithyError ? { error } : { reason: messageOf(error) }),
  });
}
