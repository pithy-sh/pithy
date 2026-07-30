import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ForbiddenError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * The payments routes' identity gates.
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
 * ## `requireControlPlane` — the repo's first `control-plane` gate
 *
 * The strategy is described in core as "M2M admin via a customer-issued scoped credential; default-denied",
 * and this is the mechanism chosen for it: **a scope on the `AuthContext` seam.** The customer mints a
 * credential carrying `payments:admin` for their support tooling, `@pithy-sh/auth` puts its scopes on the
 * request, and this gate checks for the one.
 *
 * That choice was made over the alternative — a separate shared secret compared against a header — for three
 * reasons. It invents no second credential channel, so there is one place credentials are issued, audited and
 * revoked rather than two. It composes: the same route line already carries `requireAuth()`, so a
 * control-plane call is an authenticated call with a scope, and the audit event has a real actor id in it
 * instead of "the machine". And it is default-denied **by construction, twice over**: `AuthContext.scopes`
 * defaults to `[]`, so an ordinary user token holds nothing; and with no auth capability composed at all
 * `c.var.auth` is `null`, so the gate denies before it looks at a scope. Nothing has to be configured for the
 * denial to happen, which is the property a default-denied gate needs.
 *
 * A shared secret would have meant reading it through `sharedSecretsStore` and comparing in constant time —
 * doable, but it buys nothing here and adds a credential nobody can revoke without a deploy.
 *
 * ## This is interim, and #80 replaces it
 *
 * `control-plane` is declared in core and unimplemented; issue #80 builds the real seam and names these two
 * routes as blocked on it. Its mechanism is **decided, and it is not this one**: asymmetric EdDSA, where a
 * management client signs with a private key and the customer registers, rotates, and revokes the trusted
 * public key by `kid`, with `jti`, `iat`, a short `exp`, and a digest of the body. It rules out a shared HMAC
 * explicitly — our breach would become the adopter's.
 *
 * A scope on the `AuthContext` is neither. It is what payments can enforce today without inventing a
 * credential format #80 would immediately replace, and it keeps the two routes default-denied and audited
 * until then, which is the property that actually matters in the meantime.
 *
 * **When #80 lands, delete `requireControlPlane` and put core's middleware on the route lines.** Nothing else
 * has to move: the handlers, the request schemas, and the audit events below never ask how a caller was
 * verified, only that one was.
 *
 * The scope name is a constant rather than config on purpose. A configurable scope name is a way to
 * misconfigure a default-denied gate into a differently-named one, and support tooling that reads the docs
 * would then quietly hold a scope nothing checks.
 */

/**
 * The scope a credential must carry to write an entitlement by hand. Manual grant and revoke are the only way
 * an entitlement appears without money moving, which is exactly why they are gated and audited.
 */
export const PAYMENTS_CONTROL_PLANE_SCOPE = "payments:admin";

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
 * Require the control-plane scope. Denies unless the caller's credential carries `scope`, which includes the
 * case where there is no caller at all — so the gate is safe on its own, whatever runs before it.
 */
export function requireControlPlane(scope: string = PAYMENTS_CONTROL_PLANE_SCOPE): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    if (!c.var.auth?.scopes.includes(scope)) {
      throw new ForbiddenError({
        message: "This credential may not change entitlements.",
        action: `Retry with a token carrying the ${scope} scope, minted for your support tooling.`,
        // The scopes the caller *does* hold go in `detail`, where an operator debugging a support tool sees
        // them and the caller never does — echoing them back would enumerate our scope vocabulary.
        detail: `Manual entitlement writes require the ${scope} scope; this credential carries [${c.var.auth?.scopes.join(", ") ?? ""}].`,
      });
    }
    await next();
  };
}
