// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { MULTIPLAYER_MIGRATION_ORDER } from "../capability";
import { MULTIPLAYER_MIGRATIONS } from "../migrations/chain";

/** The tables a multiplayer suite rebuilds: its own, and the migration runner's. */
const TABLES = [
  "pithy_multiplayer_results",
  "pithy_multiplayer_sessions",
  "pithy_multiplayer_void_keys",
  "pithy_migrations",
  "pithy_migrations_lock",
];

/**
 * Drop and re-migrate multiplayer's tables through the real chain, so a suite's database is always the schema a
 * deployed one is migrated to. Test scaffolding, never shipped.
 */
export async function freshMultiplayerDatabase(d1: D1Database): Promise<void> {
  for (const table of TABLES) await d1.exec(`DROP TABLE IF EXISTS ${table}`);
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "multiplayer",
      order: MULTIPLAYER_MIGRATION_ORDER,
      migrations: MULTIPLAYER_MIGRATIONS,
    },
  ]);
  const provider = registry.app;
  if (!provider) throw new Error("no app provider");
  await runMigrations(d1, provider);
}
