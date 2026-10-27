// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditCitation } from "../../audit/citations";
import type { ErasureAuditActions, ErasureHistoryRow } from "../../capability/erasure";
import type { PurgeSubject } from "../../capability/purge";
import type {
  ErasureAttestation,
  ErasureCitation,
  ErasurePeriodEntry,
  ErasureState,
  ErasureStepView,
} from "../http/responses";

/**
 * **The erasure attestation, assembled (#823)** — pure functions over a subject's lifecycle rows and the audit events
 * that name it, so every rule here is tested without a database.
 *
 * ## Which deletion
 *
 * A subject can be deleted, restored, and deleted again. The attestation is about the **deletion in force**: the
 * first `deleted` row after the last `restored`. A subject whose last act was a restore has no erasure to attest.
 * A hard deletion that brought a soft one forward writes a second `deleted` row in the same cycle, so the deletion
 * reads as `hard` and comes due when the later row says.
 *
 * ## Where the purge stands
 *
 * `complete` once a `purged` row is written. `failed` when the last thing the purge wrote was its failure — a later
 * pass that runs a step again puts it back `in_progress`. `scheduled` while nothing has run and the window is still
 * open. `in_progress` otherwise. **Overdue** is not a state: a purge not complete two days after it came due has
 * missed a daily pass, whatever it last wrote, and is named with the step it stopped at.
 *
 * ## A step run twice
 *
 * The daily pass is the purge's outer retry, so a failed purge's steps run again the next day and record again.
 * Each capability is shown once, in the order it first ran, as it last finished.
 */

/** How long after coming due a purge that has not completed is overdue: two daily passes. */
export const ERASURE_OVERDUE_AFTER_MS = 2 * 86_400_000;

/** The step a purge that has run nothing is named as having stopped at. */
export const ERASURE_NOT_STARTED = "due";

/** The rows of the deletion in force, or `null` when there is none — never deleted, or restored since. */
export function deletionInForce(rows: readonly ErasureHistoryRow[]): ErasureHistoryRow[] | null {
  let start = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.action === "restored") start = -1;
    else if (row?.action === "deleted" && start === -1) start = index;
  }
  return start === -1 ? null : rows.slice(start);
}

/** A citation as the wire carries it. */
function cited(citation: AuditCitation | undefined): ErasureCitation | null {
  if (!citation) return null;
  return {
    eventId: citation.eventId,
    action: citation.action,
    occurredAt: citation.occurredAt.toISOString(),
    tenant: citation.tenant,
    seq: citation.seq,
    hash: citation.hash,
  };
}

/** The newest citation matching, or undefined. */
function latest(citations: readonly AuditCitation[], match: (citation: AuditCitation) => boolean) {
  let found: AuditCitation | undefined;
  for (const citation of citations) {
    if (match(citation) && (!found || citation.occurredAt.getTime() >= found.occurredAt.getTime())) found = citation;
  }
  return found;
}

/** What one subject's attestation is assembled from. */
export interface AttestInput {
  /** The kind of subject. */
  readonly subject: PurgeSubject;
  /** Its id. */
  readonly subjectId: string;
  /** Its lifecycle rows, oldest first. */
  readonly rows: readonly ErasureHistoryRow[];
  /** The audit events naming it, or `null` when no audit is composed. */
  readonly citations: readonly AuditCitation[] | null;
  /** The actions its purge records. */
  readonly actions: ErasureAuditActions;
  /** Now. */
  readonly now: Date;
}

/** One subject's attestation, or `null` when it has no deletion in force. */
export function attest(input: AttestInput): ErasureAttestation | null {
  const cycle = deletionInForce(input.rows);
  const deletion = cycle?.[0];
  if (!cycle || !deletion) return null;
  const deletions = cycle.filter((row) => row.action === "deleted");
  const hard = deletions.some((row) => row.mode === "hard");
  const mode = hard ? "hard" : (deletion.mode ?? null);
  const purgeAfter = [...deletions].reverse().find((row) => row.purgeAfter)?.purgeAfter ?? null;

  // Only events recorded since this deletion: an earlier cycle's events are about a deletion that was undone.
  const citations = (input.citations ?? []).filter((each) => each.occurredAt.getTime() >= deletion.at.getTime());
  const steps = new Map<string, ErasureHistoryRow>();
  let activity: ErasureHistoryRow | undefined;
  let purged: ErasureHistoryRow | undefined;
  for (const row of cycle) {
    if (row.action === "purge_step" || row.action === "purge_retained") {
      // Re-inserting would move a re-run step to the end; setting keeps its first place with its last row.
      steps.set(row.step ?? "", row);
      activity = row;
    } else if (row.action === "purge_failed") activity = row;
    else if (row.action === "purged") purged = row;
  }

  const state = stateOf({ purged, activity, purgeAfter, now: input.now });
  const overdue =
    (state === "in_progress" || state === "failed") &&
    purgeAfter !== null &&
    input.now.getTime() - purgeAfter.getTime() > ERASURE_OVERDUE_AFTER_MS;
  const stoppedAt = state === "failed" || overdue ? (activity?.step ?? ERASURE_NOT_STARTED) : null;

  const views: ErasureStepView[] = [...steps.values()].map((row) => {
    const capability = row.step ?? "";
    const retained = row.action === "purge_retained";
    return {
      capability,
      disposition: retained ? "retained" : "erased",
      reason: retained ? row.reason : null,
      summary: retained ? null : row.reason,
      completedAt: row.at.toISOString(),
      audit: cited(latest(citations, (each) => each.action === input.actions.step && each.step === capability)),
    };
  });

  return {
    subject: { type: input.subject, id: input.subjectId },
    deletion: {
      at: deletion.at.toISOString(),
      actorType: deletion.actorType,
      reason: deletion.reason,
      mode,
      purgeAfter: purgeAfter ? purgeAfter.toISOString() : null,
      audit: cited(citations.find((each) => input.actions.deleted.includes(each.action))),
    },
    state,
    overdue,
    stoppedAt,
    steps: views,
    completedAt: purged ? purged.at.toISOString() : null,
    completion: purged ? cited(latest(citations, (each) => each.action === input.actions.purged)) : null,
    failure: state === "failed" ? cited(latest(citations, (each) => each.action === input.actions.failed)) : null,
    trail: input.citations === null ? "absent" : "recorded",
  };
}

/** Where a purge stands, from its last activity. See the file header. */
function stateOf(input: {
  purged: ErasureHistoryRow | undefined;
  activity: ErasureHistoryRow | undefined;
  purgeAfter: Date | null;
  now: Date;
}): ErasureState {
  if (input.purged) return "complete";
  if (input.activity?.action === "purge_failed") return "failed";
  if (!input.activity && (input.purgeAfter === null || input.purgeAfter.getTime() > input.now.getTime())) {
    return "scheduled";
  }
  return "in_progress";
}

/** One attestation, summarized for the period read. */
export function periodEntry(attestation: ErasureAttestation): ErasurePeriodEntry {
  return {
    subject: attestation.subject,
    state: attestation.state,
    overdue: attestation.overdue,
    purgeAfter: attestation.deletion.purgeAfter,
    completedAt: attestation.completedAt,
    stoppedAt: attestation.stoppedAt,
  };
}

/** The period's counts and the purges that need someone, from its entries. */
export function summarize(entries: readonly ErasurePeriodEntry[]) {
  const counts = { scheduled: 0, inProgress: 0, complete: 0, failed: 0, overdue: 0 };
  for (const entry of entries) {
    if (entry.state === "scheduled") counts.scheduled += 1;
    else if (entry.state === "in_progress") counts.inProgress += 1;
    else if (entry.state === "complete") counts.complete += 1;
    else counts.failed += 1;
    if (entry.overdue) counts.overdue += 1;
  }
  const attention = entries.filter((entry) => entry.state === "failed" || entry.overdue);
  return { counts, attention };
}

/** Every entry, oldest due first; a deletion recorded before #823 has no due instant and sorts last. */
export function byDue(entries: readonly ErasurePeriodEntry[]): ErasurePeriodEntry[] {
  const key = (entry: ErasurePeriodEntry) =>
    entry.purgeAfter ? Date.parse(entry.purgeAfter) : Number.MAX_SAFE_INTEGER;
  return [...entries].sort((a, b) => key(a) - key(b) || a.subject.id.localeCompare(b.subject.id));
}
