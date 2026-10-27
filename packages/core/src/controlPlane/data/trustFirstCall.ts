// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { sql } from "kysely";
import { CONTROL_PLANE_CONNECTIONS_TABLE, type ControlPlaneDatabase } from "./tables";

/**
 * Record the first call a trust answered (#722), so a listing stops saying *awaiting a first call*.
 *
 * **One statement that touches one field, never a read-modify-write of the column.** The verifier read the row
 * moments ago, and an operator may have revoked the trust since. Writing back the whole `trusts` array as the
 * verifier saw it would resurrect that trust — a revocation undone by the very call it was meant to stop. So the
 * write is `json_set` on the matching element's `firstCallAt` alone, and only while that element is still
 * unrevoked and still uncalled: a revoked trust is left exactly as revoked, and a second first call changes nothing.
 *
 * The instant is written as ISO-8601, the shape `JsonDate` stores inside the column.
 */
export async function recordTrustFirstCall(
  db: ControlPlaneDatabase,
  connectionId: string,
  trustId: string,
  at: Date,
): Promise<void> {
  const trusts = sql.ref("trusts");
  const uncalled = (alias: string) =>
    sql`json_extract(${sql.ref(`${alias}.value`)}, '$.trustId') = ${trustId}
      and json_extract(${sql.ref(`${alias}.value`)}, '$.revokedAt') is null
      and json_extract(${sql.ref(`${alias}.value`)}, '$.firstCallAt') is null`;
  await db
    .updateTable(CONTROL_PLANE_CONNECTIONS_TABLE)
    .set({
      trusts: sql<string>`json_set(${trusts}, '$[' || (select ${sql.ref("t.key")} from json_each(${trusts}) as t where ${uncalled("t")} limit 1) || '].firstCallAt', ${at.toISOString()})`,
    })
    .where("id", "=", connectionId)
    .where(sql<boolean>`exists (select 1 from json_each(${trusts}) as u where ${uncalled("u")})`)
    .execute();
}
