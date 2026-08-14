// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ForbiddenError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * The ledger routes' identity gates: the two middlewares this package owns.
 *
 * **The scope constants moved to `./scopes`** (#315). A management client reads them to render what a
 * connection may do, and it reads them in a browser — so they cannot live in a module that imports
 * Hono middleware and `PithyHonoEnv`. The gates stayed here; the names they demand are next door, and
 * the routes import both.
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
 */

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
