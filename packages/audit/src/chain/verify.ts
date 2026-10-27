// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import {
  AUDIT_CHAIN_FORMAT,
  AUDIT_EXPORT_FORMAT,
  type AuditChainExport,
  type AuditCheckpoint,
  type ChainBreak,
  type ChainLink,
  chainVerifier,
} from "@pithy-sh/core/src/audit/chain";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { AuditDatabase } from "../data/tables";
import { listCheckpoints, readCheckpoints } from "./checkpoint";
import { chainedEventOf, readChainHead, readChainLink, readChainRows, whereChain } from "./rows";

/**
 * **The verify and export reads over one tenant's chain (#822).**
 *
 * A range is asked for in time and walked in chain order. `since` resolves to the first position whose event
 * occurred at or after it, `until` to the last at or before it, and everything between is walked — including an
 * event whose `occurredAt` an emitter set outside the window, because a chain is contiguous in position and a
 * walk that skipped one would report the gap as a break.
 */

/** How many rows one read of the walk takes. */
const WALK_PAGE = 500;

/** One tenant's chain over a window of time. */
export interface ChainRangeQuery {
  /** The tenant whose chain is read, or null for the untenanted chain. */
  tenant: string | null;
  /** The window's inclusive start, or omitted for the chain's start. */
  since?: Date;
  /** The window's inclusive end, or omitted for the chain's head. */
  until?: Date;
}

/** A window resolved to positions. */
interface ResolvedRange {
  /** The first position in the window. */
  fromSeq: number;
  /** The last position in the window. Below `fromSeq` when the window holds no chained event. */
  throughSeq: number;
  /** Whether the window runs to the head, so a checkpoint past its end is a truncation. */
  toHead: boolean;
}

async function resolveRange(db: AuditDatabase, query: ChainRangeQuery): Promise<ResolvedRange> {
  const head = await readChainHead(db, query.tenant);
  let fromSeq = 1;
  if (query.since) {
    const first = await whereChain(
      db
        .selectFrom("pithyAuditEvents")
        .select((eb) => eb.fn.min("chainSeq").as("seq"))
        .where("chainSeq", "is not", null)
        .where("occurredAt", ">=", SQLiteDate.encode(query.since)),
      query.tenant,
    ).executeTakeFirst();
    fromSeq = typeof first?.seq === "number" ? first.seq : (head?.seq ?? 0) + 1;
  }
  let throughSeq = head?.seq ?? 0;
  if (query.until) {
    const last = await whereChain(
      db
        .selectFrom("pithyAuditEvents")
        .select((eb) => eb.fn.max("chainSeq").as("seq"))
        .where("chainSeq", "is not", null)
        .where("occurredAt", "<=", SQLiteDate.encode(query.until)),
      query.tenant,
    ).executeTakeFirst();
    throughSeq = typeof last?.seq === "number" ? last.seq : 0;
  }
  return { fromSeq, throughSeq, toHead: query.until === undefined };
}

/** The id of the chain's first row, or null when the tenant has no chained event yet. */
async function chainStartId(db: AuditDatabase, tenant: string | null): Promise<number | null> {
  const start = await whereChain(
    db
      .selectFrom("pithyAuditEvents")
      .select((eb) => eb.fn.min("id").as("id"))
      .where("chainSeq", "is not", null),
    tenant,
  ).executeTakeFirst();
  return typeof start?.id === "number" ? start.id : null;
}

/** The id of the first row holding a position, or null when none does. */
async function idAt(db: AuditDatabase, tenant: string | null, seq: number): Promise<number | null> {
  const row = await whereChain(
    db
      .selectFrom("pithyAuditEvents")
      .select((eb) => eb.fn.min("id").as("id"))
      .where("chainSeq", "=", seq),
    tenant,
  ).executeTakeFirst();
  return typeof row?.id === "number" ? row.id : null;
}

/** How many of the tenant's events in the window were written before the chain began. */
async function countBeforeChain(db: AuditDatabase, query: ChainRangeQuery, startId: number | null): Promise<number> {
  let builder = whereChain(
    db
      .selectFrom("pithyAuditEvents")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("chainSeq", "is", null),
    query.tenant,
  );
  if (startId !== null) builder = builder.where("id", "<", startId);
  if (query.since) builder = builder.where("occurredAt", ">=", SQLiteDate.encode(query.since));
  if (query.until) builder = builder.where("occurredAt", "<=", SQLiteDate.encode(query.until));
  return Number((await builder.executeTakeFirst())?.n ?? 0);
}

/**
 * How many rows carrying no chain were written after the chain began, among the range's positions. A recorder from
 * before the chain writes them — a Worker not yet redeployed, an isolate still serving the old version while a new
 * one rolls out, a rollback, an older CLI emitting into the same database — and Cloudflare deploys no two of those
 * together, so such a row is no evidence of tampering and no break. It carries no evidence of anything: counted here,
 * and marked `chainSeq: null` in the listing, so an auditor sees it. An insert dressed as a chained row is the walk's.
 *
 * A row sits at one past the last chained event recorded before it, so the range's rows lie between the row at the
 * position before `fromSeq` and the row at `throughSeq`, by id — or past it, for a range that runs to the head.
 */
async function countOutsideChain(
  db: AuditDatabase,
  tenant: string | null,
  range: ResolvedRange,
  startId: number | null,
): Promise<number> {
  if (startId === null) return 0;
  if (!range.toHead && range.throughSeq < range.fromSeq) return 0;
  const lowerId = (await idAt(db, tenant, Math.max(range.fromSeq - 1, 1))) ?? startId;
  let builder = whereChain(
    db
      .selectFrom("pithyAuditEvents")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("chainSeq", "is", null)
      .where("id", ">", lowerId),
    tenant,
  );
  if (!range.toHead) {
    const upperId = await idAt(db, tenant, range.throughSeq);
    if (upperId !== null) builder = builder.where("id", "<", upperId);
  }
  return Number((await builder.executeTakeFirst())?.n ?? 0);
}

/** What the verify read found. */
export interface ChainRangeVerification {
  /** Whether the range is whole. */
  intact: boolean;
  /** How many chained events were checked before the first break, or all of them. */
  checked: number;
  /** How many checkpoints the walk was held to. */
  checkpoints: number;
  /** How many of the tenant's events in the window were written before the chain, and so are not in it. */
  beforeChain: number;
  /** How many rows in the range carry no chain though written after it began: an older recorder's, not a break. */
  outsideChain: number;
  /** The first break, or null. */
  break: ChainBreak | null;
  /** The last position the walk reached intact, or null when it reached none. */
  head: ChainLink | null;
}

/**
 * Walk a range: every link, every hash, and the checkpoints covering it. `pageSize` is how many rows one read
 * takes, and is a test's to set, so a page boundary can be put where a test needs it.
 */
export async function verifyChainRange(
  db: AuditDatabase,
  bucket: R2Bucket | null,
  query: ChainRangeQuery,
  options: { pageSize?: number } = {},
): Promise<ChainRangeVerification> {
  const pageSize = options.pageSize ?? WALK_PAGE;
  // Checkpoints first: one written after the head is read would count past it, and read as a truncation.
  const listing = bucket ? await listCheckpoints(bucket, query.tenant) : null;
  const range = await resolveRange(db, query);
  const startId = await chainStartId(db, query.tenant);
  const beforeChain = await countBeforeChain(db, query, startId);
  const outsideChain = await countOutsideChain(db, query.tenant, range, startId);
  const prior = range.fromSeq > 1 ? await readChainLink(db, query.tenant, range.fromSeq - 1) : null;
  const checkpoints =
    bucket && listing
      ? await readCheckpoints(
          bucket,
          query.tenant,
          { fromCount: range.fromSeq, ...(range.toHead ? {} : { throughCount: range.throughSeq }) },
          listing,
        )
      : [];
  const result = (found: ChainBreak | null, checked: number, head: ChainLink | null, held: number) => ({
    intact: found === null,
    checked,
    checkpoints: held,
    beforeChain,
    outsideChain,
    break: found,
    head,
  });
  if (range.fromSeq > 1 && !prior) {
    return result(
      {
        eventId: null,
        position: range.fromSeq - 1,
        reason: "missing",
        detail: `The event at position ${range.fromSeq - 1}, before the range, is missing.`,
      },
      0,
      null,
      0,
    );
  }

  const verifier = chainVerifier({ tenant: query.tenant, prior, checkpoints });
  let found: ChainBreak | null = null;
  // Resumed by position and id together, so a second row at the position a page ended on is the next page's first.
  let after: { seq: number; id?: number } = { seq: range.fromSeq - 1 };
  walk: while (range.throughSeq >= range.fromSeq) {
    const rows = await readChainRows(db, {
      tenant: query.tenant,
      afterSeq: after.seq,
      ...(after.id !== undefined ? { afterId: after.id } : {}),
      limit: pageSize,
      throughSeq: range.throughSeq,
    });
    for (const row of rows) {
      found = await verifier.push(await chainedEventOf(row, { detail: false }));
      if (found) break walk;
    }
    const last = rows.at(-1);
    if (rows.length < pageSize || !last) break;
    after = { seq: last.chainSeq ?? range.throughSeq, id: last.id };
  }
  found ??= verifier.finish(range.toHead);
  return result(found, verifier.checked, verifier.head, verifier.checkpoints);
}

/** One page of an export. */
export interface ChainExportOptions {
  /** Whether the personal values and their salt travel with the commitments. */
  detail: boolean;
  /** Where the previous page ended — its last position and row id — from its `nextCursor`. */
  cursor?: string;
  /** How many events one page carries. */
  limit: number;
  /** When the export is taken. */
  now: Date;
}

/**
 * One page of a range as an export document: its events in canonical form with their hashes, the link before
 * the page, and the checkpoints covering it. Each page verifies on its own from its `prior`, so an auditor can
 * check a page without the ones before it.
 */
export async function exportChainRange(
  db: AuditDatabase,
  bucket: R2Bucket | null,
  query: ChainRangeQuery,
  options: ChainExportOptions,
): Promise<AuditChainExport> {
  // Checkpoints first, as in the verify: one written after the rows are read would count past the last of them.
  const listing = bucket ? await listCheckpoints(bucket, query.tenant) : null;
  const range = await resolveRange(db, query);
  const startId = await chainStartId(db, query.tenant);
  const resumed = parseExportCursor(options.cursor);
  const after: { seq: number; id?: number } =
    resumed && resumed.seq >= range.fromSeq - 1 ? resumed : { seq: range.fromSeq - 1 };
  const afterSeq = after.seq;
  // One row past the page says whether there is a next one, without a count.
  const read =
    range.throughSeq >= range.fromSeq
      ? await readChainRows(db, {
          tenant: query.tenant,
          afterSeq,
          ...(after.id !== undefined ? { afterId: after.id } : {}),
          limit: options.limit + 1,
          throughSeq: range.throughSeq,
        })
      : [];
  const more = read.length > options.limit;
  const rows = read.slice(0, options.limit);
  const events = await Promise.all(rows.map((row) => chainedEventOf(row, { detail: options.detail })));
  const lastSeq = events.at(-1)?.seq ?? afterSeq;
  const lastRow = rows.at(-1);
  const prior = afterSeq > 0 ? await readChainLink(db, query.tenant, afterSeq) : null;
  const complete = range.toHead && !more;
  const checkpoints: AuditCheckpoint[] =
    bucket && listing
      ? await readCheckpoints(bucket, query.tenant, { fromCount: afterSeq + 1, throughCount: lastSeq }, listing)
      : [];
  return {
    format: AUDIT_EXPORT_FORMAT,
    chain: AUDIT_CHAIN_FORMAT,
    tenant: query.tenant,
    since: query.since?.toISOString() ?? null,
    until: query.until?.toISOString() ?? null,
    exportedAt: options.now.toISOString(),
    detail: options.detail,
    prior,
    events,
    // The latest checkpoint rides along with every page, and only the last page of a range that runs to the head
    // may be held to it: a checkpoint past an earlier page's end is the next page's, not a truncation.
    checkpoints,
    complete,
    beforeChain: await countBeforeChain(db, query, startId),
    outsideChain: await countOutsideChain(db, query.tenant, range, startId),
    nextCursor: more && lastRow ? exportCursor(lastSeq, lastRow.id) : null,
  };
}

/** An export page's `nextCursor`: the last row's position and id, so the next page resumes after that one row. */
function exportCursor(seq: number, id: number): string {
  return `${seq}:${id}`;
}

/** A `nextCursor` read back, or null when it is not one — a malformed cursor is a first page. */
export function parseExportCursor(cursor: string | undefined): { seq: number; id: number } | null {
  const match = cursor === undefined ? null : /^(\d{1,15}):(\d{1,15})$/.exec(cursor);
  if (!match) return null;
  return { seq: Number(match[1]), id: Number(match[2]) };
}
