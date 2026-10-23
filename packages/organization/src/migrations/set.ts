// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { organization_0001_init } from "./0001_init";
import { organization_0002_seat_limit } from "./0002_seat_limit";

/**
 * Every migration `@pithy-sh/organization` ships, keyed as `pithy migrate` composes them.
 *
 * **One definition, many readers.** `capability.ts` composes these into the live registry, and every
 * workers suite stands its schema up from the same set. Each of them had written
 * `{ "0001_init": organization_0001_init }` out by hand, which was correct for exactly as long as there was
 * one migration — `@pithy-sh/auth` found that out when its `0002` left five harnesses a column short.
 * `migrations.workers.test.ts` is deliberately not a reader: its subject is each migration's own `up` and
 * `down`, so it names them directly.
 */
export const ORGANIZATION_MIGRATIONS = {
  "0001_init": organization_0001_init,
  "0002_seat_limit": organization_0002_seat_limit,
} as const;
