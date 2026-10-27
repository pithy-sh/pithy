// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import { AUDIT_CHECKPOINT_FORMAT, AuditCheckpoint } from "@pithy-sh/core/src/audit/chain";
import type { AuditDatabase } from "../data/tables";
import { readChainLink } from "./rows";

/**
 * **Checkpoints: each chain's length and head, written outside the database (#822).**
 *
 * A chain alone proves no row was changed *unless the whole chain was recomputed* — and anybody with write access to
 * the D1 can recompute it. So on a schedule each tenant's head and count go to the checkpoint bucket, one object per
 * checkpoint, never overwritten: the key carries the count, and the write is conditional on the key being new. A
 * rewritten chain then disagrees with a checkpoint it cannot reach, and a truncated one ends before a checkpoint
 * says it did.
 *
 * **Object lock is what makes the bucket evidence.** Without it whoever can write the bucket can rewrite the
 * checkpoints too. The lock is a bucket rule (`AUDIT_CHECKPOINT_LOCK_PREFIX`, indefinite retention) set on the
 * account, and `pithy doctor` says whether it is in force — the Worker cannot see it through its binding.
 */

/** The binding the checkpoint bucket is bound as, in the app Worker and in the checkpoint host. */
export const AUDIT_CHECKPOINT_BINDING = "AUDIT_CHECKPOINTS";

/** Every checkpoint object lives under this prefix, and the lock rule names it. */
export const AUDIT_CHECKPOINT_LOCK_PREFIX = "checkpoints/";

/** The zero-padded width of a count in a key, so keys list in count order. */
const COUNT_WIDTH = 15;

/** The key prefix of one chain's checkpoints. A tenant id is encoded, so no id can reach another's prefix. */
export function checkpointPrefix(tenant: string | null): string {
  return tenant === null
    ? `${AUDIT_CHECKPOINT_LOCK_PREFIX}untenanted/`
    : `${AUDIT_CHECKPOINT_LOCK_PREFIX}tenant/${encodeURIComponent(tenant)}/`;
}

/** The key of one checkpoint: its chain's prefix and its count. */
export function checkpointKey(tenant: string | null, count: number): string {
  return `${checkpointPrefix(tenant)}${String(count).padStart(COUNT_WIDTH, "0")}.json`;
}

/** The count a key names, or null when the key is not a checkpoint's. */
function countOf(key: string, prefix: string): number | null {
  const match = /^(\d+)\.json$/.exec(key.slice(prefix.length));
  return match ? Number(match[1]) : null;
}

/** What one checkpoint run did. */
export interface CheckpointRun {
  /** Chains whose head was new, and so got a checkpoint. */
  written: number;
  /** Chains whose head was already checkpointed. */
  unchanged: number;
}

/**
 * Write a checkpoint for every chain whose head moved since its last one. Idempotent: a head already checkpointed
 * is a key that exists, and the conditional write refuses to replace it.
 */
export async function writeCheckpoints(db: AuditDatabase, bucket: R2Bucket, now: Date): Promise<CheckpointRun> {
  const heads = await db
    .selectFrom("pithyAuditEvents")
    .select(["tenant", (eb) => eb.fn.max("chainSeq").as("count")])
    .where("chainSeq", "is not", null)
    .groupBy("tenant")
    .execute();
  const run: CheckpointRun = { written: 0, unchanged: 0 };
  for (const { tenant, count } of heads) {
    if (typeof count !== "number") continue;
    const link = await readChainLink(db, tenant, count);
    if (!link) continue;
    const key = checkpointKey(tenant, link.seq);
    if (await bucket.head(key)) {
      run.unchanged++;
      continue;
    }
    const checkpoint: AuditCheckpoint = {
      format: AUDIT_CHECKPOINT_FORMAT,
      tenant,
      count: link.seq,
      head: link.hash,
      takenAt: now.toISOString(),
    };
    // `etagDoesNotMatch: "*"` is "only if no object has this key": a run racing another never replaces one.
    const put = await bucket.put(key, JSON.stringify(AuditCheckpoint.parse(checkpoint)), {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    });
    if (put) run.written++;
    else run.unchanged++;
  }
  return run;
}

/** Which of a chain's checkpoints a read wants: those within a range of positions, and the latest overall. */
export interface CheckpointRange {
  /** The first position the read covers. */
  fromCount: number;
  /** The last position the read covers, or omitted for the chain's head. */
  throughCount?: number;
}

/** The checkpoint keys one chain held when it was listed: a snapshot, read before the chain it is held against. */
export interface CheckpointListing {
  /** The chain the keys are under. */
  tenant: string | null;
  /** Each checkpoint's key and the count it names. */
  entries: { key: string; count: number }[];
}

/**
 * List one chain's checkpoint keys. A verify or an export lists them **before** it reads the chain's head or rows, so
 * a checkpoint written while the read runs counts at most the head the read then sees. Listed after, it could count
 * an event the read never reached, and an intact chain would read as truncated.
 */
export async function listCheckpoints(bucket: R2Bucket, tenant: string | null): Promise<CheckpointListing> {
  const prefix = checkpointPrefix(tenant);
  const entries: { key: string; count: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      const count = countOf(object.key, prefix);
      if (count !== null) entries.push({ key: object.key, count });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { tenant, entries };
}

/**
 * Every checkpoint of one chain whose count falls in the range, and the latest one whatever its count — the one a
 * truncated tail is caught against. An object that does not parse, or whose body names another chain or count than
 * its key, is skipped: a checkpoint is trusted for what it says only where it says it.
 *
 * Pass a `listing` taken before the chain was read; without one the keys are listed now.
 */
export async function readCheckpoints(
  bucket: R2Bucket,
  tenant: string | null,
  range: CheckpointRange,
  listing?: CheckpointListing,
): Promise<AuditCheckpoint[]> {
  const { entries } = listing && listing.tenant === tenant ? listing : await listCheckpoints(bucket, tenant);
  const wanted: { key: string; count: number }[] = [];
  let latest: { key: string; count: number } | null = null;
  for (const entry of entries) {
    if (!latest || entry.count > latest.count) latest = entry;
    if (entry.count >= range.fromCount && (range.throughCount === undefined || entry.count <= range.throughCount)) {
      wanted.push(entry);
    }
  }
  if (latest && !wanted.some((entry) => entry.key === latest?.key)) wanted.push(latest);

  const checkpoints: AuditCheckpoint[] = [];
  for (const { key, count } of wanted.sort((a, b) => a.count - b.count)) {
    const object = await bucket.get(key);
    if (!object) continue;
    let body: unknown;
    try {
      body = JSON.parse(await object.text());
    } catch {
      continue;
    }
    const parsed = AuditCheckpoint.safeParse(body);
    if (!parsed.success || parsed.data.tenant !== tenant || parsed.data.count !== count) continue;
    checkpoints.push(parsed.data);
  }
  return checkpoints;
}
