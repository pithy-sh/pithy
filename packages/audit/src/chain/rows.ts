// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { type ChainedEvent, type ChainedEventFields, type ChainLink, commitment } from "@pithy-sh/core/src/audit/chain";
import type { AuditDatabase } from "../data/tables";

/**
 * **Reading a tenant's chain out of `pithy_audit_events` (#822).**
 *
 * One chain per tenant, and one for the events with no tenant. Every read here names which, through
 * {@link whereChain}, because `tenant = null` matches nothing in SQL and the untenanted chain would read as empty.
 *
 * Rows are read raw — the `z.input` side, `occurredAt` as its stored ms and `metadata` as its stored JSON text —
 * because the hash covers the bytes as stored. Decoding the metadata and encoding it again would hash a value the
 * row does not hold the first time the two serializations differ.
 */

/** The columns a chain read selects: every hashed field, the link, and the personal values with their salt. */
const CHAIN_COLUMNS = [
  "id",
  "eventId",
  "occurredAt",
  "action",
  "outcome",
  "severity",
  "actorType",
  "actorId",
  "actorKind",
  "sessionId",
  "resourceType",
  "resourceId",
  "requestId",
  "tenant",
  "project",
  "environment",
  "worker",
  "version",
  "ip",
  "userAgent",
  "metadata",
  "chainSeq",
  "chainPrev",
  "chainHash",
  "chainSalt",
] as const;

/** One stored row of a chain, raw. */
export interface ChainRow {
  id: number;
  eventId: string;
  occurredAt: number;
  action: string;
  outcome: string;
  severity: string;
  actorType: string;
  actorId: string | null;
  actorKind: string | null;
  sessionId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  requestId: string | null;
  tenant: string | null;
  project: string | null;
  environment: string | null;
  worker: string | null;
  version: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: string | null;
  chainSeq: number | null;
  chainPrev: string | null;
  chainHash: string | null;
  chainSalt: string | null;
}

/** A query builder narrowed to one chain: one tenant's, or the untenanted one. */
// biome-ignore lint/suspicious/noExplicitAny: Kysely's builders share no exported interface for `.where`.
export function whereChain<Q extends { where: (...args: any[]) => Q }>(query: Q, tenant: string | null): Q {
  return tenant === null ? query.where("tenant", "is", null) : query.where("tenant", "=", tenant);
}

/** The chain's head — its last position and that event's hash — or null when it holds no event. */
export async function readChainHead(db: AuditDatabase, tenant: string | null): Promise<ChainLink | null> {
  const row = await whereChain(
    db
      .selectFrom("pithyAuditEvents")
      .select(["chainSeq", "chainHash"])
      .where("chainSeq", "is not", null)
      .orderBy("chainSeq", "desc")
      .limit(1),
    tenant,
  ).executeTakeFirst();
  return linkOf(row);
}

/**
 * A selected link, or null. The type check is not decoration: SQLite reads an unknown double-quoted identifier as a
 * string literal, so on a database without `audit_0005_chain` the column comes back as the text `chain_seq`.
 */
function linkOf(row: { chainSeq: unknown; chainHash: unknown } | undefined): ChainLink | null {
  return typeof row?.chainSeq === "number" && typeof row.chainHash === "string"
    ? { seq: row.chainSeq, hash: row.chainHash }
    : null;
}

/** The link at one position, or null when no event holds it. */
export async function readChainLink(db: AuditDatabase, tenant: string | null, seq: number): Promise<ChainLink | null> {
  const row = await whereChain(
    db.selectFrom("pithyAuditEvents").select(["chainSeq", "chainHash"]).where("chainSeq", "=", seq).limit(1),
    tenant,
  ).executeTakeFirst();
  return linkOf(row);
}

/**
 * A page of one chain in chain order — by position, then id — never past `throughSeq`. It resumes after
 * `afterSeq`, or, given `afterId`, after that one row: a page that resumed from a bare position would skip a second
 * row holding the position the last page ended on, and that second row is exactly the insert a walk must see.
 */
export async function readChainRows(
  db: AuditDatabase,
  options: { tenant: string | null; afterSeq: number; afterId?: number; limit: number; throughSeq?: number },
): Promise<ChainRow[]> {
  const { afterSeq, afterId } = options;
  let query = db
    .selectFrom("pithyAuditEvents")
    .select([...CHAIN_COLUMNS])
    .where((eb) =>
      afterId === undefined
        ? eb("chainSeq", ">", afterSeq)
        : eb.or([eb("chainSeq", ">", afterSeq), eb.and([eb("chainSeq", "=", afterSeq), eb("id", ">", afterId)])]),
    )
    .orderBy("chainSeq", "asc")
    .orderBy("id", "asc")
    .limit(options.limit);
  if (options.throughSeq !== undefined) query = query.where("chainSeq", "<=", options.throughSeq);
  return (await whereChain(query, options.tenant).execute()) as ChainRow[];
}

/** The hashed fields of a stored row, its personal values committed under its salt. */
export async function chainFieldsOf(
  row: Omit<ChainRow, "id" | "chainSeq" | "chainPrev" | "chainHash">,
  salt: string,
): Promise<ChainedEventFields> {
  return {
    eventId: row.eventId,
    occurredAt: row.occurredAt,
    action: row.action,
    outcome: row.outcome,
    severity: row.severity,
    actorType: row.actorType,
    actorId: row.actorId,
    actorKind: row.actorKind,
    sessionId: row.sessionId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    requestId: row.requestId,
    tenant: row.tenant,
    project: row.project,
    environment: row.environment,
    worker: row.worker,
    version: row.version,
    ipCommitment: await commitment(salt, row.ip),
    userAgentCommitment: await commitment(salt, row.userAgent),
    metadataCommitment: await commitment(salt, row.metadata),
  };
}

/**
 * One stored row as an export carries it. Its commitments are recomputed from the values it holds now, so a value
 * edited in place changes its commitment and the hash no longer matches. The values and the salt travel only with
 * `detail`; without it the commitments are all a reader gets.
 */
export async function chainedEventOf(row: ChainRow, options: { detail: boolean }): Promise<ChainedEvent> {
  const salt = row.chainSalt ?? "";
  const fields = await chainFieldsOf(row, salt);
  return {
    ...fields,
    seq: row.chainSeq ?? 0,
    prev: row.chainPrev,
    hash: row.chainHash ?? "",
    ...(options.detail ? { salt, ip: row.ip, userAgent: row.userAgent, metadata: row.metadata } : {}),
  };
}

/**
 * The stored rows for a set of event ids, raw, in no particular order (#824). What the shipping consumer builds each
 * delivery from: the row as stored now, read at delivery rather than carried on the queue, so no personal value
 * ever sits in a queue message. An id with no row is simply absent from the answer.
 */
export async function readRowsByEventId(db: AuditDatabase, eventIds: readonly string[]): Promise<ChainRow[]> {
  if (eventIds.length === 0) return [];
  return (await db
    .selectFrom("pithyAuditEvents")
    .select([...CHAIN_COLUMNS])
    .where("eventId", "in", [...eventIds])
    .execute()) as ChainRow[];
}
