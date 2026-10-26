// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration } from "kysely/migration";
import { matchmaking_0001_matchmaking } from "./0001_matchmaking";
import { matchmaking_0002_invite_moderation } from "./0002_invite_moderation";

/**
 * Matchmaking's migration chain for the app database, in order. One list, read by `matchmaking()` and by every
 * suite that builds the tables, so a test database is always the schema a deployed one is migrated to.
 * Append-only: matchmaking has shipped, and each key is history.
 */
export const MATCHMAKING_MIGRATIONS: Record<string, Migration> = {
  "0001_matchmaking": matchmaking_0001_matchmaking,
  "0002_invite_moderation": matchmaking_0002_invite_moderation,
};
