// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration } from "kysely/migration";
import { support_0001_threads } from "./0001_threads";
import { support_0002_assignment } from "./0002_assignment";
import { support_0003_embeddings } from "./0003_embeddings";

/**
 * Every support migration, in order — the set the capability contributes and the one every test that
 * needs today's schema runs. Append-only: a released chain is history.
 *
 * The full-text index is **not** here: it is a provisioned resource `pithy support provision` creates and
 * drops (`store/searchIndex.ts`), so a config flag can never corrupt a migration set shared with every
 * other capability in the database.
 */
export const SUPPORT_MIGRATIONS: Record<string, Migration> = {
  "0001_threads": support_0001_threads,
  "0002_assignment": support_0002_assignment,
  "0003_embeddings": support_0003_embeddings,
};
