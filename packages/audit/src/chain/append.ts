// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { chainHash, newChainSalt } from "@pithy-sh/core/src/audit/chain";
import { type D1RetryOptions, withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import type { AuditDatabase, AuditEventInsert } from "../data/tables";
import { AuditWriteFailedError } from "../error/errors";
import { chainFieldsOf, readChainHead, whereChain } from "./rows";

/**
 * How long one append keeps contending for its chain's next position before it gives up, in ms. Every lost race
 * means another event landed, so a burst of appends to one tenant all land, one position at a time: the bound is on
 * time, not on how many appends overtake this one, so no burst size drops an event. It exists only to end a request
 * that a chain somebody is writing wrong would hold forever.
 */
export const CHAIN_APPEND_DEADLINE_MS = 30_000;

/**
 * How many lost races in a row may find the head where it was. A race is lost because an event took the position,
 * so the head moves; one that does not move is a chain this append cannot join, and retrying it is spinning.
 */
export const CHAIN_APPEND_STALLS = 3;

/** The longest one back-off after a lost race waits, in ms. Each wait is a random fraction of a growing ceiling. */
const BACKOFF_CEILING_MS = 50;

/** How one append contends for its chain. Every field has a default; tests narrow them. */
export interface ChainAppendOptions {
  /** How a transient D1 fault on the insert is retried. */
  retry?: D1RetryOptions;
  /** How long the append keeps contending, in ms. Defaults to {@link CHAIN_APPEND_DEADLINE_MS}. */
  deadlineMs?: number;
  /** The longest back-off between attempts, in ms. Defaults to 50; 0 retries at once. */
  backoffCeilingMs?: number;
}

/** Wait a random time under a ceiling that doubles with each lost race, so contenders stop retrying in lockstep. */
async function backOff(lost: number, ceilingMs: number): Promise<void> {
  const ceiling = Math.min(ceilingMs, 2 ** Math.min(lost, 10));
  if (ceiling <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
}

/**
 * **Append one event to its tenant's chain, without forking it (#822).**
 *
 * Read the head, compute this event's link and hash, then insert in **one statement that refuses when the head has
 * moved**: `INSERT … SELECT … WHERE NOT EXISTS (an event at or past this position in this chain)`. D1 runs one
 * statement at a time, so the check and the write cannot be split by another append. A loser inserts nothing,
 * backs off a random moment, re-reads the head and tries again, so two concurrent appends never share a position
 * and never name the same predecessor, and a burst of them all lands. The partial unique indexes from
 * `audit_0005_chain` sit under it as a backstop.
 *
 * `withD1Retry` still rides out a transient fault on the insert. A retry after a write that landed inserts nothing
 * here rather than tripping the unique index, so it is told apart from a lost race by asking whether the event's
 * own id is already in the table.
 */
export async function appendChained(
  db: AuditDatabase,
  record: AuditEventInsert,
  options: ChainAppendOptions = {},
): Promise<void> {
  const tenant = record.tenant ?? null;
  const deadline = Date.now() + (options.deadlineMs ?? CHAIN_APPEND_DEADLINE_MS);
  const ceilingMs = options.backoffCeilingMs ?? BACKOFF_CEILING_MS;
  // The salt and the commitments do not depend on the position, so a lost race recomputes only the link.
  const salt = newChainSalt();
  const fields = await chainFieldsOf(
    {
      eventId: record.eventId,
      occurredAt: record.occurredAt as number,
      action: record.action,
      outcome: record.outcome,
      severity: record.severity ?? "info",
      actorType: record.actorType,
      actorId: record.actorId ?? null,
      actorKind: record.actorKind ?? null,
      sessionId: record.sessionId ?? null,
      resourceType: record.resourceType ?? null,
      resourceId: record.resourceId ?? null,
      requestId: record.requestId ?? null,
      tenant,
      project: record.project ?? null,
      environment: record.environment ?? null,
      worker: record.worker ?? null,
      version: record.version ?? null,
      ip: record.ip ?? null,
      userAgent: record.userAgent ?? null,
      metadata: (record.metadata as string | null | undefined) ?? null,
      chainSalt: salt,
    },
    salt,
  );
  let lost = 0;
  let stalls = 0;
  let lastSeq: number | null = null;
  for (;;) {
    const head = await readChainHead(db, tenant);
    const seq = (head?.seq ?? 0) + 1;
    if (lastSeq !== null) {
      stalls = seq > lastSeq ? 0 : stalls + 1;
      if (stalls >= CHAIN_APPEND_STALLS) {
        throw new AuditWriteFailedError({
          detail: `The ${chainName(tenant)} chain refused position ${seq} ${CHAIN_APPEND_STALLS} times without moving.`,
        });
      }
    }
    lastSeq = seq;
    const prev = head?.hash ?? null;
    const hash = await chainHash({ seq, prev }, fields);
    const row = {
      ...record,
      tenant,
      chainSeq: seq,
      chainPrev: prev,
      chainHash: hash,
      chainSalt: salt,
    };
    const columns = Object.keys(row) as (keyof typeof row)[];
    const result = await withD1Retry(
      () =>
        db
          .insertInto("pithyAuditEvents")
          .columns(columns)
          .expression(
            db
              .selectNoFrom((eb) => columns.map((column) => eb.val(row[column]).as(column)))
              .where(({ not, exists, selectFrom }) =>
                not(
                  exists(whereChain(selectFrom("pithyAuditEvents").select("id").where("chainSeq", ">=", seq), tenant)),
                ),
              ),
          )
          .executeTakeFirst(),
      options.retry,
    );
    if (Number(result?.numInsertedOrUpdatedRows ?? 0n) > 0) return;
    // Nothing inserted: either a retry found this event already landed, or another append took the position.
    const landed = await db
      .selectFrom("pithyAuditEvents")
      .select("id")
      .where("eventId", "=", record.eventId)
      .executeTakeFirst();
    if (landed) return;
    if (Date.now() >= deadline) {
      throw new AuditWriteFailedError({
        detail: `The ${chainName(tenant)} chain moved under one append for ${options.deadlineMs ?? CHAIN_APPEND_DEADLINE_MS}ms.`,
      });
    }
    await backOff(++lost, ceilingMs);
  }
}

function chainName(tenant: string | null): string {
  return tenant === null ? "untenanted" : `"${tenant}"`;
}

/** Whether a failed write failed because the database has not taken `audit_0005_chain` yet. */
export function isUnmigratedChain(error: unknown): boolean {
  return error instanceof Error && /(no column named|no such column:) chain_(seq|prev|hash|salt)/.test(error.message);
}
