// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions this capability emits, through the core `emit()` seam.
 *
 * **The two reads are audited.** This surface discloses no value, but it does disclose the
 * shape of a project's secret estate — every name, which are stale, and which have never been rotated.
 * That is a target list, and a credential quietly pulling it changes nothing, so without these lines it
 * would leave no trace anywhere. "Who enumerated the secrets on the ninth" is a question with an
 * answer, and these are what make it one.
 *
 * **The three member actions are writes, and they are the reason this list is not only reads.** A
 * keyspace member is a per-tenant credential an application mints and stores on a request path
 * (`../keyspaceWrite`), which is an administrative act however routine it looks — somebody's key to
 * somebody's system now exists, or no longer does. The action codes are owned here so an adopter does
 * not invent one for the kit's most sensitive write; the emitter and the actor come from the call site,
 * because an accessor has neither. See `SecretsAccessor`'s `KeyedWriteAudit`.
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
  /**
   * A management client replaced one secret's value.
   *
   * The same code `pithy secrets rotate` emits, on purpose: it is the same act, and an incident review
   * asking *who rolled the production key on the twelfth* must not have to know which door it came through
   * to find it. Which door it was is in the actor — a `control-plane` actor with a connection id is the
   * dashboard, a CLI actor is a terminal.
   *
   * **Emitted on failure as well as success, and `critical` for `unrecorded`.** A rotation that rolled a
   * credential at its issuer and failed to store the successor is the one administrative act here that
   * leaves a system broken, and a trail that records only the rotations that worked is a trail that is
   * silent about exactly the ones somebody is looking for.
   */
  rotated: "secrets/rotated",
  /** An application stored a keyspace member — created it, or replaced it (`mode` says which). */
  memberWritten: "secrets/member_written",
  /** An application added a version to a keyspace member, keeping the prior one valid. */
  memberRotated: "secrets/member_rotated",
  /** An application removed a keyspace member and every version of it. */
  memberRemoved: "secrets/member_removed",
} as const;

/** One of the secrets capability's audit actions. */
export type SecretsAuditAction = (typeof SecretsAuditActions)[keyof typeof SecretsAuditActions];
