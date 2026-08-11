// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions this capability emits, through the core `emit()` seam.
 *
 * **Both are reads, and both are audited.** This surface discloses no value, but it does disclose the
 * shape of a project's secret estate — every name, which are stale, and which have never been rotated.
 * That is a target list, and a credential quietly pulling it changes nothing, so without these lines it
 * would leave no trace anywhere. "Who enumerated the secrets on the ninth" is a question with an
 * answer, and these are what make it one.
 *
 * Emitted with `c.var.emit`, never by importing `@pithy-sh/audit` — the seam is always present
 * (`noopEmit` when no audit capability is composed), so there is no null check and no hard dependency.
 * Counts and names only in metadata: the trail is long-lived and more widely readable than this
 * surface, so nothing about a value goes into it. Nothing about a value is available to put there.
 */
export const SecretsAuditActions = {
  /** A management client read the status of every declared secret. */
  statusRead: "secrets/status_read",
  /** A management client read one secret's rotation history. */
  rotationsRead: "secrets/rotations_read",
} as const;

/** One of the secrets capability's audit actions. */
export type SecretsAuditAction = (typeof SecretsAuditActions)[keyof typeof SecretsAuditActions];
