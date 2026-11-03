// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { decodeCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { Organization } from "../data/organization";
import { ORGANIZATIONS_TABLE, type OrganizationDatabase } from "../data/tables";
import type { OrganizationStanding } from "./state";

/** What a page of every organization may be narrowed by, and where it resumes. */
export interface OrganizationListQuery {
  /** Where the organization stands, judged at `now` exactly as `organizationStanding` judges it. */
  state?: OrganizationStanding["state"];
  /** The instant `state` is judged at. Defaults to the moment of the read. */
  now?: Date;
  /** Where to resume, from the previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped by `pageLimit`. */
  limit?: number;
}

/** One page of organizations, newest first, and where the next one starts. Null at the end. */
export interface OrganizationPage {
  items: Organization[];
  nextCursor: string | null;
}

/**
 * Every organization, newest first, keyset-paged on `(createdAt, id)`.
 *
 * `state` is one predicate over the four lifecycle columns that reads them as {@link organizationStanding} does:
 * deleted outranks suspended, and a suspension ends at the instant its `suspendedUntil` names.
 */
export async function listOrganizations(
  db: OrganizationDatabase,
  query: OrganizationListQuery = {},
): Promise<OrganizationPage> {
  const limit = pageLimit(query.limit);
  let selection = db
    .selectFrom(ORGANIZATIONS_TABLE)
    .selectAll()
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);

  const state = query.state;
  if (state !== undefined) {
    const at = SQLiteDate.encode(query.now ?? new Date());
    selection = selection.where((eb) => {
      if (state === "deleted") return eb("deletedAt", "is not", null);
      const inForce = eb.and([
        eb("suspendedAt", "is not", null),
        eb.or([eb("suspendedUntil", "is", null), eb("suspendedUntil", ">", at)]),
      ]);
      return eb.and([eb("deletedAt", "is", null), state === "suspended" ? inForce : eb.not(inForce)]);
    });
  }

  const cursor = decodeCursor(query.cursor);
  if (cursor && typeof cursor.sort === "number" && typeof cursor.id === "string") {
    const { sort, id } = cursor;
    selection = selection.where((eb) =>
      eb.or([eb("createdAt", "<", sort), eb.and([eb("createdAt", "=", sort), eb("id", "<", id)])]),
    );
  }

  const rows = await selection.execute();
  return toPage(
    rows.map((row) => Organization.parse(row)),
    limit,
    (organization) => ({ sort: organization.createdAt.getTime(), id: organization.id }),
  );
}
