// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration } from "kysely/migration";
import { leaderboard_0001_entries } from "./0001_entries";
import { leaderboard_0002_control_plane } from "./0002_control_plane";

/**
 * The leaderboard's migration chain, in order. Append-only: the capability has shipped, so every key here
 * is a row in somebody's `pithy_migrations`, and a new schema change is a new key at the end.
 *
 * One map, read by the capability and by every suite that builds a database, so a suite can never run
 * against a schema the capability does not ship.
 */
export const LEADERBOARD_MIGRATIONS: Record<string, Migration> = {
  "0001_entries": leaderboard_0001_entries,
  "0002_control_plane": leaderboard_0002_control_plane,
};
