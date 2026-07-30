import type { MiddlewareHandler } from "hono";
import type { PithyHonoEnv } from "../capability/capability";
import { InternalError, messageOf, PithyError, UnauthorizedError } from "../error/pithyError";
import { ENTITLEMENT_DENIED_ACTION, EntitlementKey, grantedEntitlementKeys } from "./entitlement";

/**
 * The entitlement gate — the middleware half of the seam. `requireEntitlement("pro")` is the
 * `verification`-strategy sibling every paid route carries: it says what the caller must *hold*, the
 * way `requireAuth()` says who the caller must *be*, and it belongs on the route line beside it.
 *
 *   app.get("/reports", requireAuth(), requireEntitlement("pro"), zValidator(…), handler)
 *
 * It lives in `@pithy-sh/core` rather than in `@pithy-sh/payments` for the same reason `requireAuth()`
 * is copied into each capability instead of imported from `@pithy-sh/auth`: a gate that arrives with a
 * package fails **open** when that package is absent. Depending on the core seam means an uncomposed
 * provider leaves `noEntitlementProvider` on the request, and every gate denies.
 *
 * Two names, not one variadic, because "any of these" and "all of these" are both plausible readings
 * of `requireEntitlement("pro", "team")` and the wrong reading is a security bug rather than a typo.
 */

/** Why a gate denied — recorded in `detail` and in the audit event, never sent to the client. */
function denialDetail(keys: readonly string[], provider: string | null, held: ReadonlySet<string>): string {
  const required = keys.join(" | ");
  if (provider === null) {
    return `no entitlement provider is composed, so \`${required}\` cannot be held. Add a payments capability to this Worker's pithy.config.ts.`;
  }
  return `${provider} resolved [${[...held].sort().join(", ")}]; the route requires \`${required}\`.`;
}

/** The gate's denial: one code, one status, whatever the reason. The reason rides in `detail`. */
function denied(keys: readonly string[], provider: string | null, held: ReadonlySet<string>): PithyError {
  return new PithyError({
    code: "payments/entitlement_required",
    status: 403,
    message: "This feature requires an active subscription or purchase.",
    action: "Purchase or restore the product that grants access, then retry.",
    detail: denialDetail(keys, provider, held),
  });
}

/**
 * Require any one of `keys`. Every key is parsed at construction, so a store SKU where an entitlement
 * key belongs (`com.acme.pro.monthly`) fails on deploy rather than gating on something no projection
 * ever writes. An empty list is refused for the same reason: it reads as "nothing required" but would
 * deny every caller forever.
 */
export function requireAnyEntitlement(keys: readonly string[]): MiddlewareHandler<PithyHonoEnv> {
  if (keys.length === 0) {
    throw new InternalError({
      message: "requireAnyEntitlement() needs at least one entitlement key.",
      action: "Name the entitlements that grant access, or drop the gate if the route is not paid.",
    });
  }
  const required = keys.map((key) => EntitlementKey.parse(key));

  return async (c, next) => {
    // A gate is not an identity check: an anonymous caller is 401, so a 403 never confirms to an
    // unauthenticated stranger that the route exists and is paid.
    const auth = c.var.auth;
    if (!auth) {
      throw new UnauthorizedError({
        message: "Authentication required.",
        action: "Sign in and retry with a valid session or bearer token.",
      });
    }

    const resolver = c.var.entitlements;
    // A provider whose store is unreachable must not become an open door, so a throw is a denial.
    // The cause goes to the log, where an operator sees the difference between "unentitled" and
    // "broken" — the response cannot, without telling a client about our infrastructure.
    let held: Set<string>;
    try {
      held = grantedEntitlementKeys(await resolver.list(), new Date());
    } catch (error) {
      c.var.log.error("entitlement resolution failed", { provider: resolver.provider, cause: messageOf(error) });
      held = new Set();
    }

    if (required.some((key) => held.has(key))) {
      await next();
      return;
    }

    // A blocked attempt is a first-class audit record (`outcome: "denied"`), not only a 403. `emit()`
    // is non-fatal by contract and a no-op with no audit capability composed, so this is always safe.
    await c.var.emit({
      action: ENTITLEMENT_DENIED_ACTION,
      outcome: "denied",
      severity: "info",
      actorType: "user",
      actorId: auth.userId,
      sessionId: auth.sessionId,
      resourceType: "entitlement",
      resourceId: required.join("|"),
      metadata: { provider: resolver.provider, required, held: [...held].sort() },
    });

    throw denied(required, resolver.provider, held);
  };
}

/** Require one entitlement. The common case: one key gates one feature. */
export function requireEntitlement(key: string): MiddlewareHandler<PithyHonoEnv> {
  return requireAnyEntitlement([key]);
}
