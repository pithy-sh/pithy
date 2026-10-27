// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration } from "kysely/migration";
import { multiplayer_0001_results } from "./0001_results";
import { multiplayer_0002_session_index } from "./0002_session_index";

/**
 * Multiplayer's migration chain for the app database, in order. One list, read by `multiplayer()` and by every
 * suite that builds the tables, so a test database is always the schema a deployed one is migrated to.
 * Append-only: multiplayer has shipped, and each key is history.
 */
export const MULTIPLAYER_MIGRATIONS: Record<string, Migration> = {
  "0001_results": multiplayer_0001_results,
  "0002_session_index": multiplayer_0002_session_index,
};
