// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretRotationRecord, SecretStatus } from "../admin/status";
import type { SecretRotationOutcome } from "../rotation/rotateValue";
import type { SecretRotationOutcomeView, SecretRotationView, SecretStatusView } from "./responses";

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
    rotation: status.rotation,
    keyVersion: status.keyVersion,
    createdAt: status.createdAt?.toISOString() ?? null,
    updatedAt: status.updatedAt?.toISOString() ?? null,
    lastRotatedAt: status.lastRotatedAt?.toISOString() ?? null,
    rotationCount: status.rotationCount,
    rotateEveryDays: status.rotateEveryDays,
    overdue: status.overdue,
  };
}

/**
 * One rotation outcome, rendered for the wire.
 *
 * **Two fields of the core's outcome are not named here, and that is the whole of what this function is
 * for.** `cause` is an `unknown` thrown by a store — an exception raised where a value was in scope — and
 * it does not cross. Optionality is flattened rather than forwarded: `rollFailed` becomes a plain boolean
 * because absent and false mean the same thing beside `rolled`, while `reason` and `attempts` become null,
 * because for those two the absence *is* the fact — nothing was skipped, nothing was stored.
 *
 * Naming every field rather than spreading, for the reason `secretStatusView` states: a spread would carry
 * a field the core's outcome later gained straight to a client, silently.
 */
export function secretRotationOutcomeView(outcome: SecretRotationOutcome): SecretRotationOutcomeView {
  return {
    name: outcome.name,
    status: outcome.status,
    kind: outcome.kind,
    rolled: outcome.rolled,
    rollFailed: outcome.rollFailed ?? false,
    recorded: [...outcome.recorded],
    stranded: [...outcome.stranded],
    reason: outcome.reason ?? null,
    attempts: outcome.attempts ?? null,
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
