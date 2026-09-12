// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { auth_0001_init } from "./0001_init";
import { auth_0002_session_authenticated_at } from "./0002_session_authenticated_at";

/**
 * Every migration `@pithy-sh/auth` ships, keyed as `pithy migrate` composes them.
 *
 * **One definition, many readers, and the reason is a real failure.** `capability.ts` composes these into
 * the live registry, and five test harnesses each build a set to stand a schema up against — `liveApp`,
 * the route suites, the schema-drift gate, the admin suites. Every one of them had written
 * `{ "0001_init": auth_0001_init }` out by hand, which was correct for exactly as long as there was one
 * migration. Adding a `0002` turned all five into a schema one column short of the code, and the symptom
 * was `table pithy_auth_sessions has no column named authenticated_at` in thirteen unrelated tests.
 *
 * A `0003` appends here and reaches every reader. `0001_init.workers.test.ts` is deliberately not a reader:
 * its subject is that one migration's own `up` and `down`, so it names it directly.
 */
export const AUTH_MIGRATIONS = {
  "0001_init": auth_0001_init,
  "0002_session_authenticated_at": auth_0002_session_authenticated_at,
} as const;
