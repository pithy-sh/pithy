// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { auth_0001_init } from "./0001_init";
import { auth_0002_session_authenticated_at } from "./0002_session_authenticated_at";
import { auth_0003_account_issuer_nullable } from "./0003_account_issuer_nullable";
import { auth_0004_user_lifecycle } from "./0004_user_lifecycle";
import { auth_0005_purge_once } from "./0005_purge_once";
import { auth_0006_verification_outcomes } from "./0006_verification_outcomes";
import { auth_0007_erasure_record } from "./0007_erasure_record";

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
 * `0003` through `0007` appended here and reached every reader, which is the point. `0001_init.workers.test.ts` is deliberately not a reader:
 * its subject is that one migration's own `up` and `down`, so it names it directly.
 */
export const AUTH_MIGRATIONS = {
  "0001_init": auth_0001_init,
  "0002_session_authenticated_at": auth_0002_session_authenticated_at,
  "0003_account_issuer_nullable": auth_0003_account_issuer_nullable,
  "0004_user_lifecycle": auth_0004_user_lifecycle,
  "0005_purge_once": auth_0005_purge_once,
  "0006_verification_outcomes": auth_0006_verification_outcomes,
  "0007_erasure_record": auth_0007_erasure_record,
} as const;
