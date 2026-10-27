// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { supportDatabase } from "../data/tables";
import { reindexAll } from "./search";
import {
  createSearchIndex,
  dropSearchIndex,
  SEARCH_OBJECTS,
  type SearchIndexAction,
  searchIndexAction,
  searchIndexState,
} from "./searchIndex";

/**
 * **Bring one database's full-text index into line with `search.fts`, and say what that took.**
 *
 * The body of `pithy support provision`'s search step, and of `pithy restore`'s rebuild of the index a
 * backup leaves out (#848). One function for both, because the two have to agree: a restore that rebuilt
 * the index some other way would be a second definition of a provisioned index, and the first time the
 * triggers changed it would restore the old ones.
 *
 * It reads `sqlite_master` for the table and its triggers, decides with {@link searchIndexAction}, and
 * applies the decision. A create and a repair backfill from `pithy_support_messages` straight away: an
 * index that exists and is empty answers "no matches" for a word plainly in a message, because the `LIKE`
 * fallback only fires while the table is absent. A drop takes the triggers first, then the table.
 *
 * Every statement is idempotent, so a re-run is a no-op that answers `none`.
 */
export async function provisionSearchIndex(database: D1Database, wanted: boolean): Promise<SearchIndexAction> {
  const listed = await database
    .prepare(`SELECT name FROM sqlite_master WHERE name IN (${SEARCH_OBJECTS.map(() => "?").join(", ")})`)
    .bind(...SEARCH_OBJECTS)
    .all<{ name: string }>();
  const action = searchIndexAction(searchIndexState((listed.results ?? []).map((row) => row.name)), wanted);
  if (action === "none") return action;
  const db = supportDatabase(database);
  if (action === "drop") {
    await dropSearchIndex(db);
    return action;
  }
  await createSearchIndex(db);
  await reindexAll(db);
  return action;
}
