// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { MIGRATION_TABLE } from "@pithy-sh/core/src/migrations/bookkeeping";
import { rollbackMigration } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import type { AUTH_MIGRATIONS } from "../migrations/set";

/**
 * Roll the auth chain back until `key` is no longer applied, so a migration's own `down` is reached however many
 * migrations were appended after it. Throws when `key` was never applied.
 */
export async function rollbackThrough(
  d1: D1Database,
  provider: MigrationProvider,
  key: keyof typeof AUTH_MIGRATIONS,
): Promise<void> {
  const applied = async () =>
    (await d1.prepare(`select name from ${MIGRATION_TABLE} where name like ? limit 1`).bind(`%auth_${key}`).first()) !==
    null;
  if (!(await applied())) throw new Error(`auth migration ${key} is not applied`);
  while (await applied()) await rollbackMigration(d1, provider);
}
