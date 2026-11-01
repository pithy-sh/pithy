// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ConsentPurpose } from "@pithy-sh/core/src/consent/purpose";
import type { ConsentMerge } from "../data/record";
import type { ConsentStanding } from "../record/answer";
import type { ConsentVersionCount } from "../record/counts";
import type { ExpiringGrant } from "../record/expiring";
import type { OpenedRecord } from "../record/store";
import type {
  ConsentExpiringGrantView,
  ConsentMergeView,
  ConsentPurposeView,
  ConsentRecordView,
  ConsentVersionCountView,
} from "./responses";

/** A purpose as a client reads it. */
export function purposeView(purpose: ConsentPurpose): ConsentPurposeView {
  return {
    id: purpose.id,
    summary: purpose.summary,
    noticeVersion: purpose.noticeVersion,
    classes: [...purpose.classes],
    explicit: purpose.explicit,
    minimumMethod: purpose.minimumMethod,
    writtenWithdrawal: purpose.writtenWithdrawal,
  };
}

/** A record as a client reads it: dates as ISO-8601, the two names opened. */
export function recordView(record: OpenedRecord): ConsentRecordView {
  return {
    id: record.id,
    subject: { kind: record.subjectKind, id: record.subjectId },
    purpose: record.purpose,
    action: record.action,
    noticeVersion: record.noticeVersion,
    method: record.method,
    surface: record.surface,
    identity: record.identity,
    documentHash: record.documentHash,
    typedName: record.typedName === null ? null : String(record.typedName),
    drawnImageHash: record.drawnImageHash,
    drawnImageType: record.drawnImageType,
    provider: record.provider,
    providerEnvelopeId: record.providerEnvelopeId,
    providerCertificateHash: record.providerCertificateHash,
    expiresAt: record.expiresAt === null ? null : record.expiresAt.toISOString(),
    representative:
      record.representativeName === null
        ? null
        : { name: String(record.representativeName), relationship: record.representativeRelationship ?? "" },
    recordedAt: record.recordedAt.toISOString(),
  };
}

/** A merge as a client reads it. */
export function mergeView(merge: ConsentMerge): ConsentMergeView {
  return { visitorId: merge.visitorId, userId: merge.userId, mergedAt: merge.mergedAt.toISOString() };
}

/** Where a subject stands on one purpose. */
export function standingView(purpose: ConsentPurpose, standing: ConsentStanding) {
  return { purpose: purposeView(purpose), standing, granted: standing === "granted" };
}

/** One notice version's counts as a client reads them. */
export function versionCountView(count: ConsentVersionCount): ConsentVersionCountView {
  return {
    noticeVersion: count.noticeVersion,
    grants: count.grants,
    withdrawals: count.withdrawals,
    expired: count.expired,
  };
}

/** A grant on the expiring list as a client reads it: the facts of the row, never a name. */
export function expiringGrantView(grant: ExpiringGrant): ConsentExpiringGrantView {
  return {
    recordId: grant.recordId,
    subject: { kind: grant.subject.kind, id: grant.subject.id },
    purpose: grant.purpose,
    noticeVersion: grant.noticeVersion,
    method: grant.method,
    expiresAt: grant.expiresAt.toISOString(),
    expired: grant.expired,
    documentHash: grant.documentHash,
  };
}
