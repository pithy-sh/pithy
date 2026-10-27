// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PurgeSubject } from "./purge";

/**
 * **The erasure record (#823): what a capability that runs a purge kept about it, read back.**
 *
 * A purge (#620, #623) records its progress in the lifecycle table of the capability that owns the subject:
 * `pithy_auth_user_lifecycle` for a user, `pithy_organization_lifecycle` for an organization. Each holds the
 * deletion, one row per step (erased, or retained with its basis under #814), a failure when the purge gave up, and
 * the `purged` row at the end, keyed by the subject's id and nothing else.
 *
 * The control plane's erasure attestation assembles those rows into a record an auditor can be handed. It cannot
 * import auth or organization (principle 4), so the capability that owns a subject declares how its rows are read,
 * here, and which audit actions its purge records — so the attestation can cite them in the chain (#822).
 *
 * **Nothing about the person crosses this seam** beyond the id the trail already keeps: no address, no name.
 */

/** What happened, as the lifecycle tables name it. Only the rows an erasure is made of. */
export type ErasureHistoryAction = "deleted" | "restored" | "purge_step" | "purge_retained" | "purge_failed" | "purged";

/** How a deletion was asked for: with a window (`soft`) or none (`hard`). */
export type ErasureDeletionMode = "soft" | "hard";

/** One row of a subject's lifecycle, as the attestation reads it. Oldest first, in the order it was written. */
export interface ErasureHistoryRow {
  /** The subject's id. */
  readonly subjectId: string;
  /** What happened. */
  readonly action: ErasureHistoryAction;
  /** Who did it: `control-plane`, `user` or `system`. */
  readonly actorType: string;
  /** Why, in whoever acted's words. A step's summary, a retained step's basis. Null when nobody had to say. */
  readonly reason: string | null;
  /** The purge step a step, retained or failed row names — the capability, or the purge's own step. */
  readonly step: string | null;
  /** On a `deleted` row written since #823, how the deletion was asked for. Null before. */
  readonly mode: ErasureDeletionMode | null;
  /** On a `deleted` row written since #823, when its purge comes due. Null before. */
  readonly purgeAfter: Date | null;
  /** When it happened. */
  readonly at: Date;
}

/** The audit actions one subject's purge records, so the attestation cites them. */
export interface ErasureAuditActions {
  /** Every action a deletion of the subject is recorded under — soft, hard, by its owner. */
  readonly deleted: readonly string[];
  /** One purge step: erased or retained, its `metadata.step` naming which. */
  readonly step: string;
  /** The purge giving up, its `metadata.step` naming where. */
  readonly failed: string;
  /** The purge finishing. */
  readonly purged: string;
}

/** Reading one kind of subject's erasure rows, over one env. */
export interface ErasureHistoryReader {
  /** Every erasure row for these subjects, oldest first. A subject with none is absent. */
  history(subjectIds: readonly string[]): Promise<ErasureHistoryRow[]>;
  /**
   * Every subject with a purge in the window: a step, a failure or a completion written in it, a deletion whose
   * purge came due in it, or one still outstanding in it — due by its end (or recorded before a due instant was) and
   * neither purged nor restored before it opened. The last is the purge that came due earlier and has written nothing
   * since, which is the one a period read exists to name. Inclusive at both ends.
   */
  subjectsIn(since: Date, until: Date): Promise<string[]>;
}

/** What a capability that owns a purge subject declares: which subject, its trail, and how its rows are read. */
export interface ErasureRecords {
  /** The subject this capability's purge erases. One capability per subject. */
  readonly subject: PurgeSubject;
  /** The `resourceType` its audit events are recorded against. */
  readonly resourceType: string;
  /** The audit actions its purge records. */
  readonly auditActions: ErasureAuditActions;
  /** The reader, over one env. */
  readonly read: (env: Record<string, unknown>) => ErasureHistoryReader;
}
