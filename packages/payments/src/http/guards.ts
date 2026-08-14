// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * The payments routes' identity gates: the one middleware payments owns.
 *
 * **The scope constants moved to `./scopes`** (#315). A management client reads them to render what a
 * connection may do, and it reads them in a browser — so they cannot live in a module that imports
 * Hono middleware and `PithyHonoEnv`. The gates stayed here; the names they demand are next door, and
 * the routes import both.
 *
 * ## `requireAuth` is copied, not imported
 *
 * These three lines are the same three `@pithy-sh/storage`, `@pithy-sh/media`, and `@pithy-sh/ledger` each
 * carry, and the duplication is deliberate. Importing the gate from `@pithy-sh/auth` would make auth a hard
 * dependency, and a package that *imports its authorization from another package fails open when that package
 * is absent*. Depending on the core `AuthContext` seam instead means `c.var.auth` is simply `null` with no
 * auth capability composed, and every route denies. Failing closed is not a side effect of the copy; it is the
 * reason for it. So `dependsOn` stays free of auth and the manifest lists it under `optionalCapabilities`.
 *
 * ## The control-plane gate is core's, and payments contributes only the scope names
 *
 * `requireControlPlane` lives in `@pithy-sh/core/src/controlPlane/http/guard` and the two admin routes wear it
 * directly. Payments verifies nothing itself: a management call arrives as an EdDSA-signed compact JWS on the
 * `pithy-control-plane` header, and the seam checks the signature against a public key the **adopter**
 * registered, the connection it addresses, that connection's environment, the token's lifetime, a digest of
 * the body, and the token's single use — none of which a capability could re-implement per package without
 * five subtly different answers to the same question.
 *
 * **This is not the opposite of the rule above; it is the same rule.** The rule is never to import
 * authorization from a package that might be absent. `@pithy-sh/auth` is optional, so its gate is copied.
 * `@pithy-sh/core` is a hard dependency of every capability there is, so importing its gate cannot leave a
 * deployment without one — and when the *seam* is not composed the imported gate raises
 * `controlplane/not_connected` rather than passing. Both halves fail closed; only the mechanism differs.
 *
 * **`requireAuth()` must never sit on those two routes.** A management client is not a user of the adopter's
 * app: it holds no session, owns no user row, and the seam deliberately leaves `c.var.auth` null so that a
 * control-plane credential cannot satisfy an ordinary `requireAuth()` anywhere in the tree. An auth gate on an
 * admin route would therefore deny every legitimate management call, permanently, and no credential could fix
 * it. The gate that replaced the interim one is the whole verification strategy, not half of it.
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
