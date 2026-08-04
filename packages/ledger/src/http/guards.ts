// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { ForbiddenError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * The ledger routes' identity gates: the two middlewares this package owns, and the two control-plane
 * scopes its management routes demand of core's.
 *
 * ## `requireAuth` is copied, not imported
 *
 * These lines are the same ones `@pithy-sh/payments`, `@pithy-sh/storage`, and `@pithy-sh/media` each
 * carry, and the duplication is deliberate. Importing the gate from `@pithy-sh/auth` would make auth a
 * hard dependency, and *a package that imports its authorization from another package fails open when
 * that package is absent*. Depending on the core `AuthContext` seam instead means `c.var.auth` is simply
 * `null` with no auth capability composed, and every player route denies. Failing closed is not a side
 * effect of the copy; it is the reason for it.
 *
 * ## The control-plane gate is core's, and the ledger contributes only the scope names
 *
 * `requireControlPlane` lives in `@pithy-sh/core/src/controlPlane/http/guard` and the management routes
 * wear it directly. The ledger verifies nothing itself: a management call arrives as an EdDSA-signed
 * compact JWS on the `pithy-control-plane` header, and the seam checks the signature against a public
 * key the **adopter** registered, the connection it addresses, that connection's environment, the
 * token's lifetime, a digest of the body, and the token's single use.
 *
 * **This is not the opposite of the rule above; it is the same rule.** The rule is never to import
 * authorization from a package that might be absent. `@pithy-sh/auth` is optional, so its gate is
 * copied. `@pithy-sh/core` is a hard dependency of every capability there is, so importing its gate
 * cannot leave a deployment without one — and when the *seam* is not composed the imported gate raises
 * `controlplane/not_connected` rather than passing.
 *
 * ## `requireAuth()` never sits on a management route, and `requireAdmin` never replaces the seam
 *
 * A management client is not a player: it holds no session, owns no account row, and the seam
 * deliberately leaves `c.var.auth` null so a control-plane credential cannot satisfy an ordinary
 * `requireAuth()` anywhere in the tree. So {@link requireAdmin} — which reads `c.var.auth?.scopes` —
 * can never pass for one, by design. The control-plane scope **replaces** that gate on the management
 * routes; it does not stack with it. Stacking them would deny every legitimate management call,
 * permanently, and no credential could fix it.
 *
 * ## Two scopes, not one admin flag
 *
 * `scopeCovers` matches exactly, with no prefix or wildcard rule, so these two confer nothing about
 * each other — and they should not, because they disclose different things. A **balance** is a number:
 * what an account holds right now. An **entry log** is a behavioural record: every wager placed, every
 * payout taken, every purchase, in order, with whatever note the adopter's own code wrote on it. A
 * balances pane and a support tool answering "why is my chip count wrong" need different halves of
 * that, and an adopter who wants to hand out only the shallower one must have a way to say so.
 *
 * The names are constants rather than config: a configurable scope name is a way to misconfigure a
 * default-denied gate into a differently-named one, and tooling that read the docs would then hold a
 * scope nothing checks. They are also the join key with what `pithy dashboard connect` offers an
 * adopter to grant, so they must be the same strings in both places.
 *
 * ## There is no write scope, and that is the whole design
 *
 * Nothing here grants a management client the ability to move a balance. Adjusting a ledger from an
 * admin console needs the same care as any other movement — an idempotency key, an audited reason, a
 * reversal path — and shipping a `POST /adjust` that has none of them would make the console the one
 * place the ledger's guarantees do not hold. Balance movement stays server-authoritative: in-process
 * through `openLedger`, or over the existing player-facing admin routes behind the auth scope.
 */

/** Read balances: the account list, and one player's position in each currency. A number, not a story. */
export const LEDGER_ACCOUNTS_READ_SCOPE: ControlPlaneScope = "ledger:accounts:read";

/**
 * Read the append-only entry log behind a balance — every movement, in order, with its memo. Strictly
 * more disclosure than the balance itself, which is why it is granted separately.
 */
export const LEDGER_TRANSACTIONS_READ_SCOPE: ControlPlaneScope = "ledger:transactions:read";

/**
 * Every control-plane scope the ledger defines — what `pithy dashboard connect` offers for this
 * capability, and the list a manifest or a doc quotes rather than re-typing.
 */
export const LEDGER_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  LEDGER_ACCOUNTS_READ_SCOPE,
  LEDGER_TRANSACTIONS_READ_SCOPE,
];

/**
 * The ledger's management surface, as `GET /control-plane/manifest` reports it.
 *
 * Declared beside the scopes rather than in `routes.ts` so the scope a route demands and the scope a
 * manifest advertises are the same constant, read from one place. `basePath` is a parameter and never a
 * default: an adopter who mounted the ledger at `/wallet` must get a manifest naming
 * `/wallet/admin/accounts`, or a management client composing its calls from it would 404 against
 * exactly the adopters who customised anything.
 *
 * **Everything sits under an `admin/` segment because the player surface already owns the one-segment
 * space.** `GET ${basePath}/:currency` matches any single segment, so a management route mounted at
 * `${basePath}/accounts` would collide with a currency called `accounts` and, worse, would sit behind
 * whichever of the two Hono matched first. The extra segment removes the ambiguity by construction
 * rather than by registration order.
 */
export function ledgerAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/admin/accounts`,
      scope: LEDGER_ACCOUNTS_READ_SCOPE,
      summary: "Page every account holding a balance, newest first, optionally in one currency.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/accounts/:userId`,
      scope: LEDGER_ACCOUNTS_READ_SCOPE,
      summary: "What one player holds, in every currency they have an account in.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/accounts/:userId/:currency/transactions`,
      scope: LEDGER_TRANSACTIONS_READ_SCOPE,
      summary: "The entry log behind one balance — every movement, newest first, with its memo.",
    },
  ];
}

/** Require an authenticated caller (the core AuthContext seam). */
export function requireAuth(): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    if (!c.var.auth) {
      throw new UnauthorizedError({
        message: "Authentication required.",
        action: "Sign in and retry with a valid session or bearer token.",
      });
    }
    await next();
  };
}

/**
 * Require the admin scope for a balance-moving write.
 *
 * Reads `c.var.auth`, so it gates the **player-facing** trusted-server routes and nothing else. A
 * control-plane caller has no `AuthContext` by design and can never satisfy it — see the file comment.
 */
export function requireAdmin(scope: string): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    if (!c.var.auth?.scopes.includes(scope)) {
      throw new ForbiddenError({
        message: "This session may not move balances.",
        action: `Retry with a token carrying the ${scope} scope, minted for your trusted server.`,
        detail: `Ledger writes require the ${scope} scope; this session carries [${c.var.auth?.scopes.join(", ") ?? ""}].`,
      });
    }
    await next();
  };
}
