// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import { AuditTombstone } from "@pithy-sh/core/src/audit/chain";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { checkpointPrefix } from "./checkpoint";

/**
 * **Tombstones: the runs of a chain the retention prune removed, kept beside its checkpoints.**
 *
 * One object per pruned run, under the chain's checkpoint prefix, so the bucket's object-lock rule covers it as it
 * covers the checkpoints. The key carries the run's first position and the write is conditional on the key being
 * new, so a run is tombstoned once and a prune retried after a failed delete finds the tombstone it already wrote.
 *
 * A checkpoint listing skips these keys: a checkpoint's key is a bare count, and a tombstone's is under `tombstones/`.
 */

/** The zero-padded width of a position in a key, so keys list in chain order. */
const SEQ_WIDTH = 15;

/** The key prefix of one chain's tombstones. */
export function tombstonePrefix(tenant: string | null): string {
  return `${checkpointPrefix(tenant)}tombstones/`;
}

/** The key of one run's tombstone: its chain's prefix and its first position. */
export function tombstoneKey(tenant: string | null, fromSeq: number): string {
  return `${tombstonePrefix(tenant)}${String(fromSeq).padStart(SEQ_WIDTH, "0")}.json`;
}

/** The first position a key names, or null when the key is not a tombstone's. */
function fromSeqOf(key: string, prefix: string): number | null {
  const match = /^(\d+)\.json$/.exec(key.slice(prefix.length));
  return match ? Number(match[1]) : null;
}

/** A stored tombstone, or null when the object does not parse or names another chain or position than its key. */
async function parseTombstone(text: string, tenant: string | null, fromSeq: number): Promise<AuditTombstone | null> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = AuditTombstone.safeParse(body);
  if (!parsed.success || parsed.data.tenant !== tenant || parsed.data.fromSeq !== fromSeq) return null;
  return parsed.data;
}

/**
 * Write a run's tombstone, or hand back the one already written at its key. What the prune deletes is the run the
 * stored tombstone names, never the one it meant to write, so a retry cannot delete past what the bucket records.
 */
export async function writeTombstone(bucket: R2Bucket, tombstone: AuditTombstone): Promise<AuditTombstone> {
  const key = tombstoneKey(tombstone.tenant, tombstone.fromSeq);
  // `etagDoesNotMatch: "*"` is "only if no object has this key": a tombstone is never replaced.
  const put = await bucket.put(key, JSON.stringify(AuditTombstone.parse(tombstone)), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  if (put) return tombstone;
  const existing = await bucket.get(key);
  const stored = existing ? await parseTombstone(await existing.text(), tombstone.tenant, tombstone.fromSeq) : null;
  if (!stored) {
    throw new InternalError({
      message: "The audit prune found a tombstone it cannot read, and pruned nothing there.",
      action: "Inspect the object in the checkpoint bucket; the prune leaves that run in place until it reads.",
      detail: `tombstone ${key} exists but does not parse as one`,
    });
  }
  return stored;
}

/**
 * Every tombstone of one chain, in chain order. An object that does not parse, or names another chain or position
 * than its key, is skipped: a tombstone bridges a gap only where it says it does.
 */
export async function readTombstones(bucket: R2Bucket, tenant: string | null): Promise<AuditTombstone[]> {
  const prefix = tombstonePrefix(tenant);
  const keys: { key: string; fromSeq: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      const fromSeq = fromSeqOf(object.key, prefix);
      if (fromSeq !== null) keys.push({ key: object.key, fromSeq });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const tombstones: AuditTombstone[] = [];
  for (const { key, fromSeq } of keys.sort((a, b) => a.fromSeq - b.fromSeq)) {
    const object = await bucket.get(key);
    if (!object) continue;
    const parsed = await parseTombstone(await object.text(), tenant, fromSeq);
    if (parsed) tombstones.push(parsed);
  }
  return tombstones;
}

/** The tombstone whose run ends at `throughSeq`, or null: the link a range starting after a pruned run begins from. */
export function tombstoneEndingAt(tombstones: readonly AuditTombstone[], throughSeq: number): AuditTombstone | null {
  return tombstones.find((tombstone) => tombstone.throughSeq === throughSeq) ?? null;
}
