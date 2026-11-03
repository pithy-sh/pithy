// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { ControlPlaneAuditActions } from "@pithy-sh/core/src/controlPlane/audit/actions";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { sql } from "kysely";
import { z } from "zod";
import type { AuditDatabase } from "./data/tables";

/**
 * Which scopes a control-plane connection exercised, and which it was refused — `#812` — for one connection or every
 * connection at once.
 *
 * Every admitted call writes `controlplane/call_allowed`, and every verified call refused a scope writes
 * `controlplane/call_denied`, both against the connection as `resourceId` and both naming the scope and key in
 * `metadata`. Answering "granted twelve, used three" from the listing would take one forensic read per event, behind
 * the scope that also discloses the client IP; this reads the same rows in SQL and returns counts.
 *
 * **One connection, or every one.** Over-grant — scopes a credential holds and never used — is a question over every
 * connection on the Worker, so leaving the connection out counts them all in the same statement, grouped by connection
 * first. A connection that made no call in the window has no row: the caller joins against the connection listing.
 *
 * **One statement for the aggregate, never a page walk.** A dashboard connection makes thousands of calls a day, and a
 * handler that paged them to count would be the largest read on the surface. The `GROUP BY` runs in D1, over rows
 * `pithyAuditEventsCallIdx` (`audit_0003_call_index`) finds by action, connection and time.
 *
 * **Nothing personal leaves this function.** It reads the scope, the key id, and the method and path of the last
 * allowed call out of `metadata`, and no other key, and never the IP or the user-agent. Those four are the management
 * client's own footprint.
 */

/** What to count: one connection, or every connection, over an inclusive window. */
export interface ControlPlaneUsageFilter {
  /** The connection whose calls are counted — the rows' `resourceId`. Absent, every connection's calls are. */
  connectionId?: string;
  /** Inclusive lower bound on `occurredAt`. */
  since: Date;
  /** Inclusive upper bound on `occurredAt`. */
  until: Date;
}

/** The two actions that record a call the gate decided. */
const CALL_ACTIONS = [ControlPlaneAuditActions.callAllowed, ControlPlaneAuditActions.callDenied];

/** The resource type every attributed call row carries. */
const CONNECTION_RESOURCE = "controlplane_connection";

/**
 * One `(scope, keyId)` a connection exercised, decoded from the aggregate's row.
 *
 * Internal: the wire shape is `ControlPlaneUsageView` in `http/responses.ts`, and `http/views.ts` projects this into it.
 */
export const ControlPlaneUsageRow = z
  .object({
    connectionId: z.string().describe("The connection that made the calls — the rows' `resourceId`."),
    scope: z
      .string()
      .describe(
        "The scope exercised: what an allowed call's token carried, or what a refused call required — `metadata.required` from the gate, `metadata.scope` from a handler.",
      ),
    keyId: z
      .string()
      .nullable()
      .describe("The registered key that signed the calls. Null for a row that recorded none."),
    allowed: z.number().int().describe("How many `controlplane/call_allowed` events in the window."),
    denied: z.number().int().describe("How many `controlplane/call_denied` events in the window."),
    lastAllowedAt: SQLiteDate.nullable().describe("When the last allowed call landed. Null when none was allowed."),
    lastAllowedMethod: z.string().nullable().describe("The HTTP method of the last allowed call, or null."),
    lastAllowedPath: z.string().nullable().describe("The path of the last allowed call, or null."),
    lastDeniedAt: SQLiteDate.nullable().describe("When the last refusal landed. Null when none was refused."),
  })
  .describe("One scope and key a control-plane connection exercised in a window, with its counts.");
export type ControlPlaneUsageRow = z.output<typeof ControlPlaneUsageRow>;

/** The oldest event the trail holds, decoded. */
const OldestEvent = z
  .object({
    oldest: SQLiteDate.nullable().describe("The smallest `occurredAt` in the trail, or null when it is empty."),
  })
  .describe("How far back the trail reaches.");

/** What {@link controlPlaneUsage} answers. */
export interface ControlPlaneUsage {
  /** One row per `(connectionId, scope, keyId)` exercised, ordered by connection, then scope, then key. */
  usage: ControlPlaneUsageRow[];
  /** The oldest event the trail holds, or null on an empty trail. */
  oldestEventAt: Date | null;
}

/**
 * The aggregate, as one Kysely statement — exported so a test can read its query plan.
 *
 * Three steps, in one statement:
 *
 * 1. **`calls`** — the connection's call rows in the window, or every connection's when none is named, with the
 *    connection beside the scope, key, method and path lifted out of `metadata`. The scope is read from where each writer puts it: an allowed row carries the token's `scope`; a gate
 *    refusal names the scope it required as `required`, and a handler's refusal as `scope`, so a denied row reads
 *    `required` first. A row with no scope at all is nobody's usage and is dropped.
 * 2. **`ranked`** — each row's recency within its `(connectionId, scope, keyId, action)`, newest first, `id`
 *    breaking a tie. Rank 1 of the allowed rows is the last allowed call, whose method and path the answer carries.
 * 3. **The group** — counts and last instants per `(connectionId, scope, keyId)`.
 *
 * Both shapes seek `pithyAuditEventsCallIdx` the same way: each action, then a connection, then the window as a range.
 * Named, the connection is the one asked for. Unnamed, it is each connection that has a call row at all, listed off the
 * same index without reading a row, so the window still bounds every connection's read and the table is never
 * scanned. A row with no connection — an unverified refusal — is nobody's usage in either.
 */
export function controlPlaneUsageStatement(db: AuditDatabase, filter: ControlPlaneUsageFilter) {
  const allowed = ControlPlaneAuditActions.callAllowed;
  const denied = ControlPlaneAuditActions.callDenied;
  return db
    .with("calls", (q) =>
      q
        .selectFrom("pithyAuditEvents")
        .select((eb) => [
          "id",
          "action",
          "occurredAt",
          eb.ref("resourceId").as("connectionId"),
          sql<string | null>`case when ${eb.ref("action")} = ${denied}
            then coalesce(json_extract(${eb.ref("metadata")}, '$.required'), json_extract(${eb.ref("metadata")}, '$.scope'))
            else json_extract(${eb.ref("metadata")}, '$.scope') end`.as("scope"),
          sql<string | null>`json_extract(${eb.ref("metadata")}, '$.keyId')`.as("keyId"),
          sql<string | null>`json_extract(${eb.ref("metadata")}, '$.method')`.as("method"),
          sql<string | null>`json_extract(${eb.ref("metadata")}, '$.path')`.as("path"),
        ])
        // In `pithyAuditEventsCallIdx`'s column order: the actions, the connection, then the window.
        .where("action", "in", CALL_ACTIONS)
        .$call((q) =>
          filter.connectionId === undefined
            ? // Every connection that ever made a call, read off the same index without touching a row, so the
              // window below is still a range inside each connection rather than a filter over every call.
              q.where("resourceId", "in", (eb) =>
                eb
                  .selectFrom("pithyAuditEvents")
                  .select("resourceId")
                  .where("action", "in", CALL_ACTIONS)
                  .where("resourceId", "is not", null),
              )
            : q.where("resourceId", "=", filter.connectionId),
        )
        .where("occurredAt", ">=", SQLiteDate.encode(filter.since))
        .where("occurredAt", "<=", SQLiteDate.encode(filter.until))
        .where("resourceType", "=", CONNECTION_RESOURCE),
    )
    .with("ranked", (q) =>
      q
        .selectFrom("calls")
        .selectAll()
        .select(
          sql<number>`row_number() over (
            partition by ${sql.ref("connectionId")}, ${sql.ref("scope")}, ${sql.ref("keyId")}, ${sql.ref("action")}
            order by ${sql.ref("occurredAt")} desc, ${sql.ref("id")} desc)`.as("recency"),
        )
        .where("scope", "is not", null),
    )
    .selectFrom("ranked")
    .select((eb) => [
      "connectionId",
      "scope",
      "keyId",
      sql<number>`sum(case when ${eb.ref("action")} = ${allowed} then 1 else 0 end)`.as("allowed"),
      sql<number>`sum(case when ${eb.ref("action")} = ${denied} then 1 else 0 end)`.as("denied"),
      sql<number | null>`max(case when ${eb.ref("action")} = ${allowed} then ${eb.ref("occurredAt")} end)`.as(
        "lastAllowedAt",
      ),
      sql<string | null>`max(case when ${eb.ref("action")} = ${allowed} and ${eb.ref("recency")} = 1
        then ${eb.ref("method")} end)`.as("lastAllowedMethod"),
      sql<string | null>`max(case when ${eb.ref("action")} = ${allowed} and ${eb.ref("recency")} = 1
        then ${eb.ref("path")} end)`.as("lastAllowedPath"),
      sql<number | null>`max(case when ${eb.ref("action")} = ${denied} then ${eb.ref("occurredAt")} end)`.as(
        "lastDeniedAt",
      ),
    ])
    .groupBy(["connectionId", "scope", "keyId"])
    .orderBy("connectionId")
    .orderBy("scope")
    .orderBy("keyId");
}

/**
 * Count one connection's calls by scope and key, or every connection's by connection, scope and key, over an
 * inclusive window.
 *
 * `oldestEventAt` is the oldest event the trail holds at all, for any connection or none. Retention prunes the trail
 * by time, never per connection, so this is how far back any connection's answer can reach: a window starting before
 * it was not fully covered, and a client can say so rather than read a short count as a quiet connection. Read through
 * `pithyAuditEventsOccurredAtIdx`, so it costs one index probe however large the trail is.
 */
export async function controlPlaneUsage(
  db: AuditDatabase,
  filter: ControlPlaneUsageFilter,
): Promise<ControlPlaneUsage> {
  const rows = await controlPlaneUsageStatement(db, filter).execute();
  const oldest = await db
    .selectFrom("pithyAuditEvents")
    .select((eb) => eb.fn.min("occurredAt").as("oldest"))
    .executeTakeFirst();
  return {
    usage: rows.map((row) => ControlPlaneUsageRow.parse(row)),
    oldestEventAt: OldestEvent.parse({ oldest: oldest?.oldest ?? null }).oldest,
  };
}
