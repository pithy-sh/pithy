// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretRotationRecord, SecretStatus } from "../admin/status";
import type { SecretRotationView, SecretStatusView } from "./responses";

/**
 * What a client is shown. Nothing in this capability's management surface ever returns a raw row.
 *
 * The only work here is the date rendering — ms-epoch in SQLite, `Date` in TypeScript, ISO-8601 on the
 * wire — and it is a function rather than a spread for one reason: **a spread would carry any field the
 * reader shape later gained, straight to a client, silently.** Naming every field means a new fact has
 * to be added here, to `responses.ts`, and to the test that asserts both field sets, which is three
 * places somebody has to mean it.
 *
 * Null passes through as null, in every case, because null is a fact on this surface: never rotated,
 * not stored here, no cadence declared, unanswerable. See `admin/status.ts`.
 */

/** One secret's status, rendered for the wire. */
export function secretStatusView(status: SecretStatus): SecretStatusView {
  return {
    name: status.name,
    backend: status.backend,
    valueType: status.valueType,
    rotatable: status.rotatable,
    keyVersion: status.keyVersion,
    createdAt: status.createdAt?.toISOString() ?? null,
    updatedAt: status.updatedAt?.toISOString() ?? null,
    lastRotatedAt: status.lastRotatedAt?.toISOString() ?? null,
    rotationCount: status.rotationCount,
    rotateEveryDays: status.rotateEveryDays,
    overdue: status.overdue,
  };
}

/** One rotation attempt, rendered for the wire. */
export function secretRotationView(record: SecretRotationRecord): SecretRotationView {
  return {
    startedAt: record.startedAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    status: record.status,
    trigger: record.trigger,
    rotatedBy: record.rotatedBy,
  };
}
