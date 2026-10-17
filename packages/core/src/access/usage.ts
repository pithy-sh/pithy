// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, type RawBuilder, sql } from "kysely";
import { z } from "zod";

/**
 * What an account is holding — records and bytes, per owner and per organization — for the control plane.
 *
 * ## A per-owner figure is always an organization's figure
 *
 * **A report run by an organization for user X filters by that organization's id**, because the
 * organization must never learn that the same person holds an account in another one. The number alone
 * leaks it: a per-user total summed across organizations discloses that the user exists elsewhere, with no
 * name attached and no row shown — the figure simply does not reconcile with what the organization can
 * see. So an unscoped per-owner read is not a convenience this offers. It is a read that does not exist:
 * {@link UsageQuery} refuses `groupBy: "owner"` and an `ownerId` filter unless an organization is named,
 * and every per-owner row is keyed by the organization it was counted in.
 *
 * Duplicate detection is the same disclosure in different clothes — *does anybody hold this file* against
 * *how much does this person hold* — and both are closed by the same column. Neither consults an
 * adopter's permission hook: a hook that widened a per-subject total would reopen exactly this.
 *
 * ## The organization is the column, not a join
 *
 * Counted by the `organizationId` written on each record, which is the fact at the time of the write. A
 * join through current membership would re-attribute last quarter's bytes the moment somebody changed
 * organization. Only stored records count — a pending upload holds nothing yet, and a failed one never
 * will.
 *
 * ## Indexed
 *
 * The tables carry `(organizationId, createdAt)` and `(ownerId, createdAt)`, so an organization's slice
 * over a window is one index range and a grouping by organization walks the index rather than sorting.
 */

/** The sentinel that names records written with no organization in force — a query string cannot say null. */
export const NO_ORGANIZATION = "none";

const Id = z.string().min(1).max(128);

/** What a usage read asks. */
export const UsageQuery = z
  .object({
    groupBy: z
      .enum(["owner", "organization"])
      .describe(
        "`organization` is one row per organization; `owner` is one row per owner within the organization named, never across organizations.",
      ),
    organizationId: Id.optional().describe(
      "Restrict to one organization. Required with `groupBy=owner` and with `ownerId`, because a per-owner figure is only ever an organization's. `none` is the records written with no organization in force.",
    ),
    ownerId: Id.optional().describe("Restrict to one owner, within the organization named."),
    since: z.iso.datetime().optional().describe("Count records created at or after this instant, ISO-8601."),
    until: z.iso.datetime().optional().describe("Count records created before this instant, ISO-8601."),
    limit: z.coerce.number().int().min(1).max(500).optional().describe("The most rows to return. 100 by default."),
  })
  .describe("A request for records and bytes held, grouped by owner or by organization.")
  .check((ctx) => {
    if (ctx.value.organizationId !== undefined) return;
    if (ctx.value.groupBy !== "owner" && ctx.value.ownerId === undefined) return;
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      path: ["organizationId"],
      message: `A per-owner read names its organization. Pass organizationId, or \`${NO_ORGANIZATION}\` for records written with none.`,
    });
  });
export type UsageQuery = z.output<typeof UsageQuery>;

/** One row of a usage read. */
export const UsageRow = z
  .object({
    organizationId: z
      .string()
      .nullable()
      .describe("The organization these records were written under. Null for records written with none."),
    ownerId: z
      .string()
      .nullable()
      .optional()
      .describe("The owner, on a per-owner read. Null for system-owned records. Absent on a per-organization read."),
    records: z.number().int().nonnegative().describe("How many stored records."),
    bytes: z.number().int().nonnegative().describe("Their total size in bytes. A record of unknown size counts zero."),
  })
  .describe("Records and bytes held by one organization, or by one owner within one organization.");
export type UsageRow = z.infer<typeof UsageRow>;

/** What a usage read answers. */
export const UsageResponse = z
  .object({
    rows: z.array(UsageRow).describe("Largest first. Capped at the requested limit."),
    truncated: z.boolean().describe("Whether more rows matched than were returned."),
  })
  .describe("Records and bytes held, grouped as asked.");
export type UsageResponse = z.infer<typeof UsageResponse>;

/** The default page of a usage read. */
const DEFAULT_LIMIT = 100;

/** Rows as SQLite returns them, before the counts are made numbers. */
export interface RawUsageRow {
  organizationId: string | null;
  ownerId?: string | null;
  records: number | string;
  bytes: number | string | null;
}

/**
 * The statement a usage read runs, over one record table — `pithyMediaAssets`, `pithyStorageObjects` —
 * carrying `ownerId`, `organizationId`, `size`, `status` and `createdAt`. Exported so a test can ask SQLite
 * how it plans the very statement {@link usageRollup} executes. Every value is a bound parameter.
 */
export function usageStatement(table: string, query: UsageQuery): RawBuilder<RawUsageRow> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const organization = sql.ref("organizationId");
  const owner = sql.ref("ownerId");
  const filters = [sql`${sql.ref("status")} = 'stored'`];
  if (query.organizationId === NO_ORGANIZATION) filters.push(sql`${organization} is null`);
  else if (query.organizationId !== undefined) filters.push(sql`${organization} = ${query.organizationId}`);
  if (query.ownerId !== undefined) filters.push(sql`${owner} = ${query.ownerId}`);
  if (query.since !== undefined) filters.push(sql`${sql.ref("createdAt")} >= ${Date.parse(query.since)}`);
  if (query.until !== undefined) filters.push(sql`${sql.ref("createdAt")} < ${Date.parse(query.until)}`);

  const keys = query.groupBy === "owner" ? sql`${organization}, ${owner}` : sql`${organization}`;
  return sql<RawUsageRow>`select ${keys}, count(*) as records, coalesce(sum(${sql.ref("size")}), 0) as bytes from ${sql.table(table)} where ${sql.join(filters, sql` and `)} group by ${keys} order by bytes desc limit ${limit + 1}`;
}

/** Read usage off one record table through any Kysely over D1 with the `CamelCasePlugin`. */
export async function usageRollup(db: Kysely<unknown>, table: string, query: UsageQuery): Promise<UsageResponse> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const result = await usageStatement(table, query).execute(db);
  const byOwner = query.groupBy === "owner";
  const rows = result.rows.slice(0, limit).map((row) => ({
    organizationId: row.organizationId ?? null,
    ...(byOwner ? { ownerId: row.ownerId ?? null } : {}),
    records: Number(row.records),
    bytes: Number(row.bytes ?? 0),
  }));
  return { rows, truncated: result.rows.length > limit };
}
