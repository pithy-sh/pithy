import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * The payments routes' identity gates: one middleware payments owns, and the two scopes its control-plane
 * routes demand of core's.
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
 *
 * ## Two scopes, not one admin flag
 *
 * The interim gate checked a single `payments:admin` scope on the `AuthContext`. That string is a valid
 * {@link ControlPlaneScope} — it matches the seam's pattern, so nothing forced this change — but it names a
 * *credential holder*, and the seam's scopes name *operations*. Under that model one flag is wrong on the
 * merits: granting and revoking an entitlement are two operations with different blast radii and different
 * holders. **Grant** mints paid product out of nothing, so a compromised comp tool costs revenue and can
 * escalate itself into anything the catalog sells. **Revoke** takes paid access away from a live customer, so
 * a compromised refund tool is an outage for people who paid. A refund tool needs revoke and never grant; a
 * support-comp tool needs grant and never revoke. One flag makes each of them the other, and an adopter who
 * wanted to hand out only the safer half had no way to say so.
 *
 * The split is real rather than cosmetic because `scopeCovers` matches exactly, with no prefix or wildcard
 * rule: `payments:entitlements` confers neither of these, and holding one confers nothing about the other.
 *
 * The names are constants rather than config, for the reason the old comment gave and which has not changed: a
 * configurable scope name is a way to misconfigure a default-denied gate into a differently-named one, and
 * support tooling that read the docs would then quietly hold a scope nothing checks. They are also the join
 * key with what `pithy dashboard connect` offers an adopter to grant, so they must be the same strings in both
 * places.
 */

/**
 * Write an entitlement nobody paid for — a comp, or the repair of a purchase that verified and never
 * projected. The more dangerous of the two: a connection holding this can give any account anything the
 * catalog sells.
 */
export const PAYMENTS_ENTITLEMENT_GRANT_SCOPE: ControlPlaneScope = "payments:entitlements:grant";

/**
 * Take an entitlement back — a chargeback, an abuse decision, a comp withdrawn. Effective on the account's
 * next request, which is exactly why it is granted separately from the ability to hand one out.
 */
export const PAYMENTS_ENTITLEMENT_REVOKE_SCOPE: ControlPlaneScope = "payments:entitlements:revoke";

/**
 * Every control-plane scope payments defines — what `pithy dashboard connect` offers for this capability, and
 * the list a manifest or a doc quotes rather than re-typing. Core's `SEAM_SCOPES` is the same idea for the
 * seam's own routes.
 */
export const PAYMENTS_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
];

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
