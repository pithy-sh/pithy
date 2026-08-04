// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { loadIntegrationCreds } from "./harness";
import { reapAllStaleTestResources } from "./reap";

/**
 * The Vitest `globalSetup` every `vitest.integration.config.ts` points at — one debris sweep per
 * integration run, before a single suite is collected.
 *
 * **A `globalSetup` is the only place this can correctly live.** Reaping used to happen in a suite's
 * `beforeAll`, and Vitest runs no hooks inside a `describe.skipIf(true)` — so each reaper was gated on
 * exactly the credential whose absence lets debris pile up, and a package with no live suite of its own
 * reaped nothing however much it created. `globalSetup` runs before collection, so no suite's gate can
 * switch it off, and it runs once per project rather than once per file.
 *
 * Never throws. Housekeeping that fails the run it was meant to help is worse than the debris: a missing
 * or unprivileged token must skip the sweep and let the suites make their own skip decision, exactly as
 * they did before.
 */
export default async function setup(): Promise<void> {
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
