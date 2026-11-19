// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { RouteMount } from "../http/lazyRoutes";

/**
 * A routes module that counts its own evaluation, for the test that proves `createBackend` evaluates a
 * capability's routes module on the first request that reaches it and not before.
 */

/** The key the evaluation count lives under, on `globalThis`, so the test reads it without importing this. */
export const LAZY_PROBE_EVALUATIONS = Symbol.for("pithy.test.lazyProbeEvaluations");

const counter = globalThis as { [LAZY_PROBE_EVALUATIONS]?: number };
counter[LAZY_PROBE_EVALUATIONS] = (counter[LAZY_PROBE_EVALUATIONS] ?? 0) + 1;

/** One route, `GET /probe`, answering how many times this module has been evaluated. */
export const mountProbe: RouteMount = (app) => {
  app.get("/probe", (c) => c.json({ evaluations: counter[LAZY_PROBE_EVALUATIONS] ?? 0 }));
};
