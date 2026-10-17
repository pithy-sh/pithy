// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createDatabase } from "../data/db";
import { type AccessCaller, type AccessRecord, defaultAllows, readablePredicate } from "./access";
import type { ActingOrganization } from "./acting";
import { RecordVisibility } from "./visibility";

/**
 * The list predicate is the rules in SQL, so it has to agree with the rules in TypeScript. Every row
 * below is judged both ways, for every caller, and the two answers must match — except that a list adds
 * public rows only when asked, which is the one place the two are meant to differ.
 */

const Item = z
  .object({
    id: z.string().describe("Id."),
    ownerId: z.string().nullable().describe("Owner."),
    organizationId: z.string().nullable().describe("Organization."),
    visibility: RecordVisibility,
  })
  .describe("A record carrying the access columns.");

function database() {
  return createDatabase(env.DB, { accessItems: Item });
}

function acting(organizationId: string, ...powers: string[]): ActingOrganization {
  return { organizationId, roleAllows: (power) => powers.includes(power) };
}

const ROWS: AccessRecord[] = [];
for (const ownerId of ["u-1", "u-2", null]) {
  for (const organizationId of ["org-a", "org-b", null]) {
    for (const visibility of ["private", "organization", "public"] as const) {
      ROWS.push({ id: `${ownerId}-${organizationId}-${visibility}`, ownerId, organizationId, visibility });
    }
  }
}

const CALLERS: Record<string, AccessCaller> = {
  "u-1 in org-a": { userId: "u-1", acting: acting("org-a") },
  "u-1 in org-b": { userId: "u-1", acting: acting("org-b") },
  "u-1 nowhere": { userId: "u-1", acting: null },
  "u-2 in org-a": { userId: "u-2", acting: acting("org-a") },
  "manager in org-a": { userId: "u-9", acting: acting("org-a", "media:manage") },
  anonymous: { userId: null, acting: null },
};

beforeEach(async () => {
  const db = database();
  await db.schema.dropTable("accessItems").ifExists().execute();
  await sql`create table access_items (id text primary key, owner_id text, organization_id text, visibility text not null)`.execute(
    db,
  );
  // One row per statement: D1 caps a statement's bound parameters, and the fixture is the whole grid.
  for (const row of ROWS) await db.insertInto("accessItems").values(row).execute();
});

async function listed(caller: AccessCaller, includePublic: boolean): Promise<string[]> {
  const rows = await database()
    .selectFrom("accessItems")
    .select("id")
    .where(readablePredicate(caller, { managePower: "media:manage", includePublic }))
    .orderBy("id")
    .execute();
  return rows.map((row) => row.id);
}

describe("readablePredicate agrees with the rules", () => {
  for (const [name, caller] of Object.entries(CALLERS)) {
    test(`${name}: includePublic lists exactly what the rules let them read`, async () => {
      const expected = ROWS.filter((row) => defaultAllows("read", row, caller, "media:manage"))
        .map((row) => row.id)
        .sort();
      expect(await listed(caller, true)).toEqual(expected);
    });

    test(`${name}: without includePublic, nothing public that is not theirs or their organization's`, async () => {
      const organizationId = caller.acting?.organizationId ?? null;
      const expected = ROWS.filter((row) => defaultAllows("read", row, caller, "media:manage"))
        .filter(
          (row) =>
            row.visibility !== "public" ||
            (caller.userId !== null && row.ownerId === caller.userId && row.organizationId === organizationId) ||
            (organizationId !== null && row.organizationId === organizationId),
        )
        .map((row) => row.id)
        .sort();
      expect(await listed(caller, false)).toEqual(expected);
    });
  }

  test("an anonymous caller lists nothing unless public is asked for", async () => {
    expect(await listed(CALLERS.anonymous as AccessCaller, false)).toEqual([]);
  });
});
