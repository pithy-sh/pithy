// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { reportFixtureEstate } from "./fixtures";

/**
 * The `globalSetup` for an integration config whose suites **create nothing** — the fixture report, and
 * no debris sweep.
 *
 * `integrationSetup.ts` beside this does both, and it is the right entry point for a package that mints
 * a Worker, a database or a bucket. A package whose live suites only *read* a third party — a token
 * endpoint, a siteverify — has nothing to reclaim, and pointing it at the sweeping setup would mean
 * every run of it deleted stale resources across the whole account on behalf of suites it does not run.
 * That is somebody else's housekeeping, done at a surprising moment, and it costs a run half a minute
 * of REST calls that answer nothing about the code under test.
 *
 * The report half is not optional either way, which is the whole reason this file exists rather than
 * the config simply declaring no `globalSetup`. Vitest runs no hooks inside a `describe.skipIf(true)`,
 * so a suite that skips for want of a fixture is exactly the suite that cannot say which fixture — see
 * the long note in `fixtures.ts`. A config with no `globalSetup` gets a silent skip, and a silent skip
 * is the failure mode #106 exists to remove.
 *
 * **Switch a config to `integrationSetup` the moment one of its suites creates a Cloudflare resource.**
 * A suite that mints and a run that never sweeps is how debris becomes permanent.
 *
 * Never throws, for the same reason its neighbor does not: a report that fails the run it was meant to
 * explain is worse than no report.
 */
export default function setup(): void {
  reportFixtureEstate();
}
