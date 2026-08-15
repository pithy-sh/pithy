// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { reportFixtureEstate } from "./fixtures";
import { loadIntegrationCreds } from "./harness";
import { reapAllStaleTestResources } from "./reap";

/**
 * The Vitest `globalSetup` every `vitest.integration.config.ts` points at — one fixture report and one
 * debris sweep per integration run, before a single suite is collected.
 *
 * **A `globalSetup` is the only place either can correctly live.** Reaping used to happen in a suite's
 * `beforeAll`, and Vitest runs no hooks inside a `describe.skipIf(true)` — so each reaper was gated on
 * exactly the credential whose absence lets debris pile up, and a package with no live suite of its own
 * reaped nothing however much it created. `globalSetup` runs before collection, so no suite's gate can
 * switch it off, and it runs once per project rather than once per file.
 *
 * The fixture report is the same argument about a different thing. A suite that skips for want of a
 * Turnstile widget prints "skipped" and nothing else, and the one place that can say *which* fixture and
 * *where to make it* is a place no suite's gate reaches. So it runs first, and it runs **before the
 * credentials check** — a contributor with no account is exactly who needs to be told why the run went
 * quiet, and gating the explanation on the thing being explained is how it goes silent for them.
 *
 * Never throws. Housekeeping that fails the run it was meant to help is worse than the debris: a missing
 * or unprivileged token must skip the sweep and let the suites make their own skip decision, exactly as
 * they did before.
 */
export default async function setup(): Promise<void> {
  reportFixtureEstate();

  const creds = loadIntegrationCreds();
  if (!creds.hasCreds) return;

  try {
    await reapAllStaleTestResources(creds);
  } catch (error) {
    // Deliberately swallowed, and reported. The sweep is a courtesy to the next run; a run that cannot
    // sweep is still a run worth having.
    console.warn(`stale test resources could not be swept: ${error instanceof Error ? error.message : String(error)}`);
  }
}
