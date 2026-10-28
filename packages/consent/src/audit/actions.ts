// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions consent emits through core's `c.var.emit` seam — never by importing `@pithy-sh/audit`, so with
 * no audit capability composed they land on `noopEmit`.
 *
 * **Every row is an event.** A grant, a withdrawal and a merge each append one row and emit one event naming it, so
 * `@pithy-sh/audit`'s chain makes the consent record tamper-evident: a row removed from D1 leaves its event
 * standing in a chain that verifies, and an event removed breaks the chain. The event carries the record's id, the
 * purpose, the notice version, the method and the document's hash — never a name.
 */
export const ConsentAuditActions = {
  /** A person gave consent to a purpose. */
  granted: "consent/granted",
  /** A person withdrew consent from a purpose. */
  withdrawn: "consent/withdrawn",
  /** A visitor's consent was carried into the account they signed in as. */
  merged: "consent/merged",
} as const;

/** One of consent's audit actions. */
export type ConsentAuditAction = (typeof ConsentAuditActions)[keyof typeof ConsentAuditActions];
