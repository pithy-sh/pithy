// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { AuditAction } from "@pithy-sh/core/src/audit/auditEvent";
import { AuditInvalidEventError } from "./error/errors";

/**
 * Author a capability's action constants. The taxonomy is **federated**: each capability owns and
 * exports its own `domain/reason` action codes (`auth/login`, `entitlement/granted`) and adds them
 * without touching core — the way migrations and table prefixes already federate per-capability.
 *
 * This validates every code against the shared {@link AuditAction} shape at author time, so a typo
 * (a missing slash, an uppercase letter) fails loudly where the constant is declared rather than
 * silently when an event is emitted. Returns the same object, typed, so call sites read
 * `AuthAuditActions.login`:
 *
 * ```ts
 * export const AuthAuditActions = defineAuditActions({
 *   login: "auth/login",
 *   tokenRefreshed: "auth/token_refreshed",
 * });
 * ```
 */
export function defineAuditActions<const T extends Record<string, string>>(actions: T): T {
  for (const [name, code] of Object.entries(actions)) {
    const parsed = AuditAction.safeParse(code);
    if (!parsed.success) {
      throw new AuditInvalidEventError({
        message: `Invalid audit action code for "${name}": ${code}`,
        action: "Use a lowercase namespaced `domain/reason` code, e.g. `auth/login`.",
        detail: parsed.error.message,
      });
    }
  }
  return actions;
}

/**
 * This capability's own action codes — the trail recording the reads of itself.
 *
 * **Reading an audit trail is a security-relevant action.** It is the record of who did what across
 * every other capability, so a management client paging through it is doing something that has to be
 * answerable later; a trail that records every write and no read cannot answer "who looked".
 *
 * They are separate codes rather than one, because the two reads disclose different things and a
 * reviewer filtering the trail should not have to inspect metadata to tell them apart:
 * `audit/trail_read` is a filtered page of structural fields, while `audit/event_read` is the full
 * record of one event — the IP, the user-agent, and the capability metadata included.
 *
 * Yes, this appends to the table it just read. That is a loop by design, not by accident: the row it
 * writes is one row, it is the only durable evidence the read happened, and the alternative is a
 * surface that quietly exempts itself from the guarantee it exists to provide.
 */
export const AuditTrailActions = defineAuditActions({
  /** A filtered page of the trail was read. */
  trailRead: "audit/trail_read",
  /** One event was read in full, network identifiers and metadata included. */
  eventRead: "audit/event_read",
});
