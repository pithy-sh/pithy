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
