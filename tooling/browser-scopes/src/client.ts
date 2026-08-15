// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AUDIT_EVENT_DETAIL_READ_SCOPE, AUDIT_TRAIL_READ_SCOPE } from "@pithy-sh/audit/src/http/guards";
import {
  AUTH_DEVICES_READ_SCOPE,
  AUTH_DEVICES_REVOKE_SCOPE,
  AUTH_SESSIONS_REVOKE_SCOPE,
  AUTH_USERS_LOGOUT_SCOPE,
  AUTH_USERS_READ_SCOPE,
} from "@pithy-sh/auth/src/http/guards";
import { KEYS_ROTATE_SCOPE, MANIFEST_READ_SCOPE } from "@pithy-sh/core/src/controlPlane/scope/scope";
import {
  EMAIL_JOBS_READ_SCOPE,
  EMAIL_JOBS_RETRY_SCOPE,
  EMAIL_SUPPRESSIONS_DELETE_SCOPE,
  EMAIL_SUPPRESSIONS_READ_SCOPE,
  EMAIL_SUPPRESSIONS_WRITE_SCOPE,
} from "@pithy-sh/email/src/http/guards";
import { LEDGER_ACCOUNTS_READ_SCOPE, LEDGER_TRANSACTIONS_READ_SCOPE } from "@pithy-sh/ledger/src/http/scopes";
import {
  PAYMENTS_CATALOG_READ_SCOPE,
  PAYMENTS_DISCOUNT_CREATE_SCOPE,
  PAYMENTS_DISCOUNT_READ_SCOPE,
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_RECONCILE_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
} from "@pithy-sh/payments/src/http/scopes";
import { SECRETS_ROTATE_SCOPE, SECRETS_STATUS_READ_SCOPE } from "@pithy-sh/secrets/src/http/guards";
import {
  SUPPORT_THREADS_ARCHIVE_SCOPE,
  SUPPORT_THREADS_FLAG_SCOPE,
  SUPPORT_THREADS_READ_SCOPE,
  SUPPORT_THREADS_RECLASSIFY_SCOPE,
  SUPPORT_THREADS_REPLY_SCOPE,
} from "@pithy-sh/support/src/http/scopes";
import {
  TESTERS_NUDGE_SEND_SCOPE,
  TESTERS_ROSTER_READ_SCOPE,
  TESTERS_ROSTER_WRITE_SCOPE,
} from "@pithy-sh/testers/src/http/scopes";

/**
 * The adopter's browser program, in miniature.
 *
 * `pithy-sh/dashboard` is a Vite client and a Worker in one repo, with two TypeScript programs: the
 * client has the DOM lib, the Worker has `@cloudflare/workers-types`. Its panes render what a
 * connection may do, and its scope builder writes the `pithy dashboard connect --scope …` command —
 * both from these constants. **Reading a scope is a client activity by design**, so a client must be
 * able to name one without acquiring `ExecutionContext`.
 *
 * It could not (#315). Four capabilities declared their scopes in the same module as their Hono
 * middleware, so naming a scope compiled `PithyHonoEnv`, which reached `capability.ts`, which named
 * Workers globals the client program has no types for. Four errors, none of them in the adopter's own
 * code, and nothing the adopter could do about them short of excluding the kit from typechecking.
 *
 * This file is the reproduction, kept. `tsconfig.client.json` compiles it with the DOM lib and
 * `types: []` — no ambient Workers types, exactly as a browser build has none — and that compile is
 * this package's `typecheck` task. `coverage.test.ts` is what keeps the file honest: it holds the
 * import list to *every* control-plane scope the kit declares, so a new one is not silently
 * uncovered, and it holds each scope's home module to type-only imports, so the declaration cannot
 * drift back in beside the middleware that reads it.
 *
 * Names only. There is nothing to assert about a string literal that the compiler has not already
 * proven by resolving it.
 */
export const EVERY_CONTROL_PLANE_SCOPE: readonly string[] = [
  MANIFEST_READ_SCOPE,
  KEYS_ROTATE_SCOPE,
  AUDIT_TRAIL_READ_SCOPE,
  AUDIT_EVENT_DETAIL_READ_SCOPE,
  AUTH_USERS_READ_SCOPE,
  AUTH_DEVICES_READ_SCOPE,
  AUTH_SESSIONS_REVOKE_SCOPE,
  AUTH_USERS_LOGOUT_SCOPE,
  AUTH_DEVICES_REVOKE_SCOPE,
  EMAIL_JOBS_READ_SCOPE,
  EMAIL_JOBS_RETRY_SCOPE,
  EMAIL_SUPPRESSIONS_READ_SCOPE,
  EMAIL_SUPPRESSIONS_WRITE_SCOPE,
  EMAIL_SUPPRESSIONS_DELETE_SCOPE,
  LEDGER_ACCOUNTS_READ_SCOPE,
  LEDGER_TRANSACTIONS_READ_SCOPE,
  PAYMENTS_DISCOUNT_CREATE_SCOPE,
  PAYMENTS_DISCOUNT_READ_SCOPE,
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_CATALOG_READ_SCOPE,
  PAYMENTS_RECONCILE_READ_SCOPE,
  SECRETS_STATUS_READ_SCOPE,
  SECRETS_ROTATE_SCOPE,
  SUPPORT_THREADS_READ_SCOPE,
  SUPPORT_THREADS_ARCHIVE_SCOPE,
  SUPPORT_THREADS_REPLY_SCOPE,
  SUPPORT_THREADS_RECLASSIFY_SCOPE,
  SUPPORT_THREADS_FLAG_SCOPE,
  TESTERS_ROSTER_READ_SCOPE,
  TESTERS_ROSTER_WRITE_SCOPE,
  TESTERS_NUDGE_SEND_SCOPE,
];
