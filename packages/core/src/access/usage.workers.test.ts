// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createDatabase } from "../data/db";
import { NO_ORGANIZATION, UsageQuery, usageRollup, usageStatement } from "./usage";

const Item = z
  .object({
    id: z.string().describe("Id."),
    ownerId: z.string().nullable().describe("Owner."),
    organizationId: z.string().nullable().describe("Organization."),
    size: z.number().nullable().describe("Bytes."),
    status: z.string().describe("Lifecycle."),
    createdAt: z.number().describe("Created, ms-epoch."),
  })
  .describe("A record carrying the usage columns.");

function database() {
  return createDatabase(env.DB, { usageItems: Item });
}

/** One person, two organizations — the case the non-disclosure rule exists for. */
const ROWS = [
  { id: "a1", ownerId: "u-shared", organizationId: "org-a", size: 10, status: "stored", createdAt: 1_000 },
  { id: "a2", ownerId: "u-shared", organizationId: "org-a", size: 5, status: "stored", createdAt: 2_000 },
  { id: "a3", ownerId: "u-local", organizationId: "org-a", size: 7, status: "stored", createdAt: 3_000 },
  { id: "a4", ownerId: "u-local", organizationId: "org-a", size: 999, status: "pending", createdAt: 3_500 },
  { id: "b1", ownerId: "u-shared", organizationId: "org-b", size: 20, status: "stored", createdAt: 4_000 },
  { id: "n1", ownerId: "u-shared", organizationId: null, size: 3, status: "stored", createdAt: 5_000 },
  { id: "s1", ownerId: null, organizationId: null, size: null, status: "stored", createdAt: 6_000 },
];

beforeEach(async () => {
  const db = database();
  await db.schema.dropTable("usageItems").ifExists().execute();
  await sql`create table usage_items (id text primary key, owner_id text, organization_id text, size integer, status text not null, created_at integer not null)`.execute(
    db,
  );
  await sql`create index usage_items_owner_created_idx on usage_items (owner_id, created_at)`.execute(db);
  await sql`create index usage_items_organization_created_idx on usage_items (organization_id, created_at)`.execute(db);
  for (const row of ROWS) await db.insertInto("usageItems").values(row).execute();
});

const rollup = (query: Record<string, unknown>) =>
  usageRollup(database() as unknown as Kysely<unknown>, "usageItems", UsageQuery.parse(query));

describe("usageRollup", () => {
  test("per organization: stored records and bytes, a null organization its own row", async () => {
    const { rows, truncated } = await rollup({ groupBy: "organization" });
    expect(truncated).toBe(false);
    expect(rows).toEqual([
      { organizationId: "org-a", records: 3, bytes: 22 },
      { organizationId: "org-b", records: 1, bytes: 20 },
      { organizationId: null, records: 2, bytes: 3 },
    ]);
  });

  test("per owner within one organization", async () => {
    const { rows } = await rollup({ groupBy: "owner", organizationId: "org-a" });
    expect(rows).toEqual([
      { organizationId: "org-a", ownerId: "u-shared", records: 2, bytes: 15 },
      { organizationId: "org-a", ownerId: "u-local", records: 1, bytes: 7 },
    ]);
  });

  test("the records written with no organization are named, not reached by omission", async () => {
    const { rows } = await rollup({ groupBy: "owner", organizationId: NO_ORGANIZATION });
    expect(rows).toEqual([
      { organizationId: null, ownerId: "u-shared", records: 1, bytes: 3 },
      { organizationId: null, ownerId: null, records: 1, bytes: 0 },
    ]);
  });

  test("a window is a createdAt range", async () => {
    const { rows } = await rollup({
      groupBy: "owner",
      organizationId: "org-a",
      since: new Date(1_500).toISOString(),
      until: new Date(3_000).toISOString(),
    });
    expect(rows).toEqual([{ organizationId: "org-a", ownerId: "u-shared", records: 1, bytes: 5 }]);
  });

  test("a limit truncates, and says so", async () => {
    const { rows, truncated } = await rollup({ groupBy: "organization", limit: 1 });
    expect(rows).toHaveLength(1);
    expect(truncated).toBe(true);
  });
});

describe("an organization cannot learn that one of its users holds an account elsewhere", () => {
  test("no row — and no total — for the shared user carries another organization's bytes", async () => {
    const forUser = await rollup({ groupBy: "owner", organizationId: "org-a", ownerId: "u-shared" });
    // 15, never 35 (with org-b) nor 38 (with the no-organization record).
    expect(forUser.rows).toEqual([{ organizationId: "org-a", ownerId: "u-shared", records: 2, bytes: 15 }]);
  });

  test("every per-owner figure reconciles with the organization's own total", async () => {
    const owners = await rollup({ groupBy: "owner", organizationId: "org-a" });
    const organization = await rollup({ groupBy: "organization", organizationId: "org-a" });
    const summed = owners.rows.reduce((sum, row) => sum + row.bytes, 0);
    expect(summed).toBe(organization.rows[0]?.bytes);
    expect(owners.rows.reduce((sum, row) => sum + row.records, 0)).toBe(organization.rows[0]?.records);
  });

  test("there is no way to ask for an unscoped per-owner read", () => {
    expect(UsageQuery.safeParse({ groupBy: "owner" }).success).toBe(false);
    expect(UsageQuery.safeParse({ groupBy: "organization", ownerId: "u-shared" }).success).toBe(false);
    const refused = UsageQuery.safeParse({ groupBy: "owner" });
    expect(refused.error?.issues[0]?.message).toContain("names its organization");
  });
});

describe("the grouped reads use the indexes rather than scanning the table", () => {
  async function plan(query: Record<string, unknown>): Promise<string> {
    const statement = usageStatement("usageItems", UsageQuery.parse(query));
    const result = await sql<{ detail: string }>`explain query plan ${statement}`.execute(
      database() as unknown as Kysely<unknown>,
    );
    return result.rows.map((row) => row.detail).join("\n");
  }

  test("one organization's owners: an index search on the organization", async () => {
    const detail = await plan({ groupBy: "owner", organizationId: "org-a" });
    expect(detail).toMatch(/SEARCH usage_items USING INDEX usage_items_organization_created_idx/);
  });

  test("every organization: the organization index, walked in order — no bare table scan, no grouping sort", async () => {
    const detail = await plan({ groupBy: "organization" });
    expect(detail).toContain("USING INDEX usage_items_organization_created_idx");
    // The one sort left is of the grouped rows, by bytes, for the answer — never of the table to group it.
    expect(detail).not.toContain("USE TEMP B-TREE FOR GROUP BY");
    expect(detail).not.toMatch(/SCAN usage_items(?! USING)/);
  });
});
