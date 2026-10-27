// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type AuditCitation, composedAuditCitations } from "../../audit/citations";
import type { Capability } from "../../capability/capability";
import type { ErasureRecords } from "../../capability/erasure";
import type { PurgeSubject } from "../../capability/purge";
import { NotFoundError, ValidationError } from "../../error/pithyError";
import type {
  ControlPlaneErasurePeriodResponse,
  ControlPlaneErasureSubjectResponse,
  ErasurePeriodEntry,
} from "../http/responses";
import type { ErasurePeriodQuery } from "../http/schemas";
import { attest, byDue, periodEntry, summarize } from "./attest";

/**
 * **The two erasure reads (#823), over whatever this Worker composes.**
 *
 * The rows live in the capability that owns each subject — auth for a user, organization for an organization —
 * and are read through the {@link ErasureRecords} each declares. The events live in the audit trail and are read
 * through the citation reader `@pithy-sh/audit` declares. Neither is imported: both are found among the composed
 * capabilities, so a Worker with no organization attests users only and says so, and one with no audit attests from
 * the lifecycle rows and says the trail is absent.
 */

/** The default window: a quarter. */
export const ERASURE_DEFAULT_WINDOW_MS = 90 * 86_400_000;

/** The longest window one read covers: a year and a day, so a year's audit is one call. */
export const ERASURE_MAX_WINDOW_MS = 366 * 86_400_000;

/** How many subjects one history or citation read names at once — inside D1's bound-parameter limit. */
const CHUNK = 50;

/** What the reads need from the seam. */
export interface ErasureReadDeps {
  /** Every composed capability. */
  readonly composition: () => readonly Capability[];
  /** The clock. */
  readonly now: () => Date;
}

/** The capability recording each subject's purges, first declared wins. */
export function erasureProviders(capabilities: readonly Capability[]): Map<PurgeSubject, ErasureRecords> {
  const providers = new Map<PurgeSubject, ErasureRecords>();
  for (const capability of capabilities) {
    const records = capability.erasureRecords;
    if (records && !providers.has(records.subject)) providers.set(records.subject, records);
  }
  return providers;
}

/** The window a period read covers, defaulted and bounded. */
export function erasureWindow(query: ErasurePeriodQuery, now: Date): { since: Date; until: Date } {
  const until = query.until ? new Date(query.until) : now;
  const since = query.since ? new Date(query.since) : new Date(until.getTime() - ERASURE_DEFAULT_WINDOW_MS);
  if (since.getTime() > until.getTime()) {
    throw new ValidationError({
      message: "`since` is after `until`.",
      detail: `erasure window ${since.toISOString()} to ${until.toISOString()}`,
    });
  }
  if (until.getTime() - since.getTime() > ERASURE_MAX_WINDOW_MS) {
    throw new ValidationError({
      message: "An erasure window is at most 366 days. Ask for a shorter one.",
      detail: `erasure window ${since.toISOString()} to ${until.toISOString()}`,
    });
  }
  return { since, until };
}

/** Every value in chunks of {@link CHUNK}. */
function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += CHUNK) out.push(values.slice(index, index + CHUNK));
  return out;
}

/** The audit events a subject's purge records, for these ids, or `null` with no audit composed. */
async function citationsFor(
  capabilities: readonly Capability[],
  env: Record<string, unknown>,
  records: ErasureRecords,
  ids: readonly string[],
): Promise<AuditCitation[] | null> {
  const reader = composedAuditCitations(capabilities, env);
  if (!reader) return null;
  const { deleted, step, failed, purged } = records.auditActions;
  const actions = [...deleted, step, failed, purged];
  const found: AuditCitation[] = [];
  for (const resourceIds of chunks(ids)) {
    found.push(...(await reader({ resourceType: records.resourceType, resourceIds, actions })));
  }
  return found;
}

/** `GET /control-plane/erasure/:subjectType/:subjectId`. */
export async function readErasureSubject(
  env: Record<string, unknown>,
  deps: ErasureReadDeps,
  subject: PurgeSubject,
  subjectId: string,
): Promise<ControlPlaneErasureSubjectResponse> {
  const capabilities = deps.composition();
  const records = erasureProviders(capabilities).get(subject);
  if (!records) {
    throw new NotFoundError({
      message: `This Worker records no erasures for ${subject === "user" ? "a user" : "an organization"}.`,
      action: `Compose the capability that owns ${subject} purges in this Worker, then ask again.`,
      detail: `no composed capability declares erasureRecords for ${subject}`,
    });
  }
  const now = deps.now();
  const rows = await records.read(env).history([subjectId]);
  const citations = rows.length === 0 ? null : await citationsFor(capabilities, env, records, [subjectId]);
  const attestation =
    rows.length === 0 ? null : attest({ subject, subjectId, rows, citations, actions: records.auditActions, now });
  if (!attestation) {
    throw new NotFoundError({
      message: "No erasure on record for this subject.",
      action: "It was never deleted, or it was restored. Nothing has been erased.",
      detail: `no deletion in force for ${subject} ${subjectId}`,
    });
  }
  return { generatedAt: now.toISOString(), attestation };
}

/** `GET /control-plane/erasure?since&until`. */
export async function readErasurePeriod(
  env: Record<string, unknown>,
  deps: ErasureReadDeps,
  query: ErasurePeriodQuery,
): Promise<ControlPlaneErasurePeriodResponse> {
  const now = deps.now();
  const { since, until } = erasureWindow(query, now);
  const providers = erasureProviders(deps.composition());
  const entries: ErasurePeriodEntry[] = [];
  for (const [subject, records] of providers) {
    const reader = records.read(env);
    const ids = await reader.subjectsIn(since, until);
    for (const batch of chunks(ids)) {
      const rows = await reader.history(batch);
      for (const subjectId of batch) {
        const attestation = attest({
          subject,
          subjectId,
          rows: rows.filter((row) => row.subjectId === subjectId),
          // The period read counts and names; the citations are the subject read's.
          citations: null,
          actions: records.auditActions,
          now,
        });
        if (attestation) entries.push(periodEntry(attestation));
      }
    }
  }
  const purges = byDue(entries);
  const { counts, attention } = summarize(purges);
  return {
    generatedAt: now.toISOString(),
    since: since.toISOString(),
    until: until.toISOString(),
    subjects: [...providers.keys()],
    counts,
    attention,
    purges,
  };
}
