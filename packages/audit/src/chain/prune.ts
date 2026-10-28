// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import {
  AUDIT_TOMBSTONE_FORMAT,
  type AuditTombstone,
  type ChainLink,
  chainVerifier,
} from "@pithy-sh/core/src/audit/chain";
import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { auditWindowDays, type EffectiveRetention, MS_PER_DAY } from "@pithy-sh/core/src/retention/policy";
import { type Expression, type SqlBool, sql } from "kysely";
import type { AuditDatabase } from "../data/tables";
import { readCheckpoints } from "./checkpoint";
import { type ChainRow, chainedEventOf, readChainHead, readChainLink, readChainRows, whereChain } from "./rows";
import { readTombstones, tombstoneEndingAt, writeTombstone } from "./tombstone";

/**
 * **The retention prune: audit events past their window, removed without breaking the chain.**
 *
 * The Worker's `retention.audit` block says how long each action is kept. An event past its window is removed, and
 * because every chained event names the one before it, a removed run leaves a tombstone in the checkpoint bucket
 * first: the run's positions, the link before it, and the hashes at either end. A verify bridges the gap with it and
 * reads the chain as whole. Without a checkpoint bucket nothing chained is pruned, since nothing could vouch for the
 * gap.
 *
 * - **Runs, not single events.** Windows differ by action, so an event kept longer can sit between two that have
 *   passed theirs. Each maximal run of consecutive positions past their windows is pruned on its own, and the event
 *   kept between two runs stays where it is.
 * - **A run is verified before it goes.** Its links, its hashes and the link before it are checked as a verify would,
 *   and a run that does not verify is left in place and counted as refused: the prune never removes the evidence of a
 *   break. A run whose positions hold any row it did not read, a second row at one position among them, is refused
 *   too, and the delete names the ids of the rows it verified, never a range of positions.
 * - **The head is never pruned.** The next append links to it, so the last event of every chain stays.
 * - **Rows from before the chain** carry no link, and are removed on their own window with nothing to tombstone.
 * - **A page reads only rows past their own windows.** An event kept longer than the shortest window, a floored
 *   control-plane call under a short default, is never read, so however many of them sit at the front of a chain a
 *   page still reaches the events behind them.
 */

/** How many rows one prune step reads. */
export const AUDIT_PRUNE_PAGE = 500;

/** The shortest window any action can have under this policy, in days, or null when nothing is ever pruned. */
export function shortestWindowDays(retention: EffectiveRetention): number | null {
  const days = [
    ...retention.audit.rules.map((rule) => rule.days),
    ...(retention.audit.defaultDays === null ? [] : [retention.audit.defaultDays]),
  ];
  return days.length === 0 ? null : Math.min(...days);
}

/** Whether an event with this action, occurring at `occurredAt` ms, is past its window at `now`. */
export function pastWindow(retention: EffectiveRetention, action: string, occurredAt: number, now: Date): boolean {
  const days = auditWindowDays(retention, action);
  return days !== null && occurredAt < now.getTime() - days * MS_PER_DAY;
}

/** The actions that share one window, and the instant, in stored ms, before which an event with any of them is past it. */
export interface ExpiryCutoff {
  readonly before: number;
  readonly actions: readonly string[];
}

/** The actions grouped by the instant each is past its window at `now`. An action kept forever is in no group. */
export function expiryCutoffs(retention: EffectiveRetention, actions: readonly string[], now: Date): ExpiryCutoff[] {
  const groups = new Map<number, string[]>();
  for (const action of new Set(actions)) {
    const days = auditWindowDays(retention, action);
    if (days === null) continue;
    const before = now.getTime() - days * MS_PER_DAY;
    groups.set(before, [...(groups.get(before) ?? []), action]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([before, grouped]) => ({ before, actions: grouped.sort() }));
}

/**
 * The rows past their own windows, as one condition. Each group's actions travel as one JSON array, so the bound
 * parameters stay two per window however many actions the trail holds.
 */
function pastCutoffs(cutoffs: readonly ExpiryCutoff[]): Expression<SqlBool> {
  return sql<SqlBool>`(${sql.join(
    cutoffs.map(
      (cutoff) =>
        sql`(${sql.ref("action")} in (select value from json_each(${JSON.stringify(cutoff.actions)})) and ${sql.ref("occurredAt")} < ${cutoff.before})`,
    ),
    sql` or `,
  )})`;
}

/** Every maximal run of consecutive positions among `rows` that are all past their windows. */
export function expiredRuns(rows: readonly ChainRow[], retention: EffectiveRetention, now: Date): ChainRow[][] {
  const runs: ChainRow[][] = [];
  let current: ChainRow[] = [];
  for (const row of rows) {
    const expired = pastWindow(retention, row.action, row.occurredAt, now);
    const last = current.at(-1);
    const follows = last !== undefined && row.chainSeq === (last.chainSeq ?? 0) + 1;
    if (!expired || (last && !follows)) {
      if (current.length > 0) runs.push(current);
      current = [];
    }
    if (expired) current.push(row);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** What one page of one chain's prune did. */
export interface ChainPrunePage {
  /** How many events were removed. */
  pruned: number;
  /** How many runs were past their windows and left in place, because they did not verify. */
  refused: number;
  /** The position the next page resumes after, or null when this page reached the end of what is pruneable. */
  next: number | null;
}

/** The link before a run at `fromSeq`: null at the chain's start, else the stored event or a tombstone ending there. */
async function linkBeforeRun(
  db: AuditDatabase,
  tenant: string | null,
  fromSeq: number,
  tombstones: readonly AuditTombstone[],
): Promise<ChainLink | null | undefined> {
  if (fromSeq === 1) return null;
  const stored = await readChainLink(db, tenant, fromSeq - 1);
  if (stored) return stored;
  const run = tombstoneEndingAt(tombstones, fromSeq - 1);
  return run ? { seq: run.throughSeq, hash: run.last } : undefined;
}

/** Whether a run is whole: every link and hash, from the link before it, against the checkpoints covering it. */
async function runVerifies(
  bucket: R2Bucket,
  tenant: string | null,
  run: readonly ChainRow[],
  prior: ChainLink | null,
): Promise<boolean> {
  const from = run[0]?.chainSeq ?? 0;
  const through = run.at(-1)?.chainSeq ?? 0;
  const checkpoints = await readCheckpoints(bucket, tenant, { fromCount: from, throughCount: through });
  const verifier = chainVerifier({ tenant, prior, checkpoints });
  for (const row of run) {
    if (await verifier.push(await chainedEventOf(row, { detail: false }))) return false;
  }
  return true;
}

/** How many rows of this chain sit at positions `fromSeq` through `throughSeq`. */
async function rowsAt(db: AuditDatabase, tenant: string | null, fromSeq: number, throughSeq: number): Promise<number> {
  const row = await whereChain(
    db
      .selectFrom("pithyAuditEvents")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("chainSeq", ">=", fromSeq)
      .where("chainSeq", "<=", throughSeq),
    tenant,
  ).executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * Prune one page of one chain: read up to `limit` chained rows after `afterSeq` that are old enough for the shortest
 * window, and remove every run among them that is past its windows and verifies, tombstone first.
 */
export async function pruneChainPage(
  db: AuditDatabase,
  bucket: R2Bucket,
  options: { tenant: string | null; retention: EffectiveRetention; now: Date; afterSeq: number; limit: number },
): Promise<ChainPrunePage> {
  const { tenant, retention, now } = options;
  const shortest = shortestWindowDays(retention);
  const head = await readChainHead(db, tenant);
  if (shortest === null || !head || head.seq <= 1) return { pruned: 0, refused: 0, next: null };
  const occurredBefore = now.getTime() - shortest * MS_PER_DAY;
  const candidates = await whereChain(
    db
      .selectFrom("pithyAuditEvents")
      .select("action")
      .distinct()
      .where("chainSeq", ">", options.afterSeq)
      .where("chainSeq", "<=", head.seq - 1)
      .where("occurredAt", "<", occurredBefore),
    tenant,
  ).execute();
  const cutoffs = expiryCutoffs(
    retention,
    candidates.map((row) => row.action),
    now,
  );
  if (cutoffs.length === 0) return { pruned: 0, refused: 0, next: null };
  const rows = await readChainRows(db, {
    tenant,
    afterSeq: options.afterSeq,
    limit: options.limit,
    throughSeq: head.seq - 1,
    occurredBefore,
    matching: pastCutoffs(cutoffs),
  });
  const tombstones = await readTombstones(bucket, tenant);
  let pruned = 0;
  let refused = 0;
  for (const run of expiredRuns(rows, retention, now)) {
    const first = run[0] as ChainRow;
    const last = run.at(-1) as ChainRow;
    const fromSeq = first.chainSeq as number;
    if ((await rowsAt(db, tenant, fromSeq, last.chainSeq as number)) !== run.length) {
      refused++;
      continue;
    }
    const prior = await linkBeforeRun(db, tenant, fromSeq, tombstones);
    if (prior === undefined || !(await runVerifies(bucket, tenant, run, prior))) {
      refused++;
      continue;
    }
    const stored = await writeTombstone(bucket, {
      format: AUDIT_TOMBSTONE_FORMAT,
      tenant,
      fromSeq,
      throughSeq: last.chainSeq as number,
      count: run.length,
      prior: prior?.hash ?? null,
      first: first.chainHash as string,
      last: last.chainHash as string,
      prunedAt: now.toISOString(),
    });
    // A retry finds the tombstone an earlier attempt wrote. What it deletes is the run that tombstone names, and only
    // when the rows in hand are the rows it names and no other row shares their positions.
    const end = run.find((row) => row.chainSeq === stored.throughSeq);
    const named = run.filter(
      (row) => (row.chainSeq as number) >= stored.fromSeq && (row.chainSeq as number) <= stored.throughSeq,
    );
    if (
      !end ||
      end.chainHash !== stored.last ||
      first.chainHash !== stored.first ||
      named.length !== stored.count ||
      (await rowsAt(db, tenant, stored.fromSeq, stored.throughSeq)) !== stored.count
    ) {
      refused++;
      continue;
    }
    const fixed = tenant === null ? 2 : 3;
    for (const ids of chunkByBoundParameters(
      named.map((row) => row.id),
      fixed,
    )) {
      await whereChain(
        db
          .deleteFrom("pithyAuditEvents")
          .where("id", "in", ids)
          .where("chainSeq", ">=", stored.fromSeq)
          .where("chainSeq", "<=", stored.throughSeq),
        tenant,
      ).execute();
    }
    tombstones.push(stored);
    pruned += stored.count;
  }
  const lastRead = rows.at(-1);
  return { pruned, refused, next: rows.length === options.limit && lastRead ? (lastRead.chainSeq as number) : null };
}

/** The chains the trail holds: each tenant with a chained event, and null for the untenanted chain. */
export async function chainTenants(db: AuditDatabase): Promise<(string | null)[]> {
  const rows = await db
    .selectFrom("pithyAuditEvents")
    .select("tenant")
    .distinct()
    .where("chainSeq", "is not", null)
    .execute();
  return rows.map((row) => row.tenant ?? null).sort((a, b) => (a ?? "").localeCompare(b ?? ""));
}

/** What one page of the unchained prune did. */
export interface UnchainedPrunePage {
  /** How many rows were removed. */
  deleted: number;
  /** The row id the next page resumes after, or null at the end. */
  next: number | null;
}

/**
 * Prune one page of the rows that carry no chain — written before it began, or by an older recorder since. Each is
 * removed on its own window, unless a hold stands on its tenant's trail, and nothing is tombstoned: no chain names it.
 */
export async function pruneUnchainedPage(
  db: AuditDatabase,
  options: {
    retention: EffectiveRetention;
    now: Date;
    afterId: number;
    limit: number;
    held: (tenant: string | null) => Promise<boolean>;
  },
): Promise<UnchainedPrunePage> {
  const { retention, now } = options;
  const shortest = shortestWindowDays(retention);
  if (shortest === null) return { deleted: 0, next: null };
  const occurredBefore = now.getTime() - shortest * MS_PER_DAY;
  const candidates = await db
    .selectFrom("pithyAuditEvents")
    .select("action")
    .distinct()
    .where("chainSeq", "is", null)
    .where("id", ">", options.afterId)
    .where("occurredAt", "<", occurredBefore)
    .execute();
  const cutoffs = expiryCutoffs(
    retention,
    candidates.map((row) => row.action),
    now,
  );
  if (cutoffs.length === 0) return { deleted: 0, next: null };
  const rows = await db
    .selectFrom("pithyAuditEvents")
    .select(["id", "action", "occurredAt", "tenant"])
    .where("chainSeq", "is", null)
    .where("id", ">", options.afterId)
    .where("occurredAt", "<", occurredBefore)
    .where(pastCutoffs(cutoffs))
    .orderBy("id", "asc")
    .limit(options.limit)
    .execute();
  const holds = new Map<string | null, boolean>();
  const doomed: number[] = [];
  for (const row of rows) {
    if (!pastWindow(retention, row.action, row.occurredAt as number, now)) continue;
    const tenant = row.tenant ?? null;
    if (!holds.has(tenant)) holds.set(tenant, await options.held(tenant));
    if (!holds.get(tenant)) doomed.push(row.id as number);
  }
  if (doomed.length > 0) await db.deleteFrom("pithyAuditEvents").where("id", "in", doomed).execute();
  const lastRead = rows.at(-1);
  return { deleted: doomed.length, next: rows.length === options.limit && lastRead ? (lastRead.id as number) : null };
}
