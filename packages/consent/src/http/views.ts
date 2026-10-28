// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ConsentPurpose } from "@pithy-sh/core/src/consent/purpose";
import type { ConsentMerge } from "../data/record";
import type { ConsentStanding } from "../record/answer";
import type { OpenedRecord } from "../record/store";
import type { ConsentMergeView, ConsentPurposeView, ConsentRecordView } from "./responses";

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
