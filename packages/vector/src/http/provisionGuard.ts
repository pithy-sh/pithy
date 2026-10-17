// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyReadinessGuard } from "@pithy-sh/core/src/capability/capability";
import { type AmbientEnv, compositionEnvironment } from "@pithy-sh/core/src/env/ambient";
import type { VectorConfig } from "../config/config";
import { assertProvisionedMetadataIndexes, readProvisionRecord } from "../index/provisioned";

/**
 * The boot check, as a readiness guard: compare the filterable fields this config declares against what
 * `pithy vector provision` last observed, and refuse to serve if they disagree.
 *
 * **Why per request and not the `compose` hook.** `compose` is the obvious home — it fires once when
 * `createBackend` assembles the backend — but it is handed the composed capabilities and nothing else,
 * because in Workers there *is* no `env` at assembly. Bindings and vars arrive per request. The record lives
 * in a var, so the earliest moment it can be read is the first request. That is exactly why core's own
 * `validateBindings` runs there too, memoized, rather than at module load: "in Workers `env` is per-request,
 * so there is no env to check until a request arrives." First request is what boot means here.
 *
 * **It gates every route, not just the vector ones — except the admin surface.** Same precedent, same
 * reasoning: a missing binding fails the whole app rather than the capability that needed it, because a
 * Worker deployed against the wrong configuration should be unmistakably broken, not subtly wrong. Two
 * things answer anyway. `GET /health` is registered before any capability middleware, so an orchestrator's
 * health probe still gets a response and the deploy fails on real traffic, where a human is reading the
 * error. And every composed capability's `adminRoutes`, the control plane's own included, are exempt,
 * because this is a readiness guard and `createBackend` skips those on the admin surface. A management
 * client must be able to reach a drifted Worker, or it cannot tell drift from a Worker that is down (#763).
 *
 * The result is memoized only on success. A failure leaves the check armed, so it re-runs and re-throws on
 * the next request instead of collapsing into a bare 500 with no explanation.
 */
export function provisionGuard(config: VectorConfig): PithyReadinessGuard {
  let verified = false;
  return async (c, next) => {
    if (!verified) {
      const env = c.env as Record<string, unknown>;
      assertProvisionedMetadataIndexes(config, readProvisionRecord(env), compositionEnvironment(env as AmbientEnv));
      verified = true;
    }
    await next();
  };
}
