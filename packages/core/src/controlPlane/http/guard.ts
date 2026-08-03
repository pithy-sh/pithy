// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MiddlewareHandler } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { PithyError } from "../../error/pithyError";
import { ControlPlaneAuditActions, safeEmit } from "../audit/actions";
import type { ControlPlaneContext } from "../context";
import { ControlPlaneNotConnectedError } from "../error/errors";
import type { ControlPlaneRequirement } from "../scope/scope";
import { CONTROL_PLANE_HEADER, type ControlPlaneVerifyDeps, verifyControlPlaneCall } from "./verify";

/**
 * `requireControlPlane(scope)` — the gate every control-plane route wears, including the ones
 * capabilities contribute.
 *
 * ## Why a verifier on the request, and not a configured factory
 *
 * `@pithy-sh/payments` writes `requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE)` at module scope. It cannot
 * hold the seam's config — that is the adopter's, resolved when they compose `controlplane()` — and it
 * must not import anything from a sibling package. So the seam contributes one middleware that puts a
 * {@link ControlPlaneVerifier} on the request, and the gate below consumes it. A capability depends on
 * a core seam and nothing else, which is principle 4 doing exactly what it exists for.
 *
 * ## It fails closed, and that is the point
 *
 * With no `controlplane()` composed there is no verifier, and every gate raises
 * `controlplane/not_connected`. A capability that contributes admin routes into a Worker that never
 * enabled the seam therefore denies them, rather than leaving them open because the thing meant to
 * protect them is absent. **A package that imports its authorization from elsewhere must deny when
 * that elsewhere is missing** — the same reason `requireAuth` is copied per capability rather than
 * imported from `@pithy-sh/auth`.
 *
 * ## The requirement is mandatory
 *
 * There is no zero-argument form. An optional scope is a thing you can forget, and forgetting it on an
 * admin route ships an unscoped one; requiring the argument means the only way to write a route with no
 * authorization is to name `ANY_VERIFIED_CALLER` out loud, which is as deliberate as naming a scope.
 */

/**
 * Verify one call against this Worker's registrations. Contributed by the seam's middleware, consumed
 * by {@link requireControlPlane}, and absent when the seam is not composed.
 */
export type ControlPlaneVerifier = (
  request: Request,
  requirement: ControlPlaneRequirement,
) => Promise<ControlPlaneContext>;

/**
 * Build the verifier the seam's middleware publishes. Split out from the middleware so the wiring is
 * testable without a Worker, and so `verify.ts` stays free of Hono.
 */
export function createControlPlaneVerifier(deps: ControlPlaneVerifyDeps): ControlPlaneVerifier {
  return async (request, requirement) => {
    // Clone before reading. The handler still has to parse this body through `zValidator`, and a stream
    // consumed here would reach it empty — the digest check would pass and the request would then fail
    // validation for no visible reason.
    const body = new Uint8Array(await request.clone().arrayBuffer());
    // `return await`, not `return`. Returning a promise from an async function makes this frame *adopt*
    // the rejection instead of raising it, and workerd then reports the adopted promise as an unhandled
    // rejection even though the gate catches it and `onError` answers correctly. Refusals are the normal
    // traffic of this seam — an expired token, an ungranted scope — so they must not read as runtime
    // faults in an adopter's logs. Same trap `submit()` in `@pithy-sh/payments` documents.
    return await verifyControlPlaneCall(
      { token: request.headers.get(CONTROL_PLANE_HEADER) ?? undefined, body, requirement },
      deps,
    );
  };
}

/**
 * Require a verified control-plane caller carrying `requirement`.
 *
 * Goes **before** any validator on the route line. A validator ahead of the gate turns a 401 into a
 * 400 and tells an unauthenticated caller which requests were well-formed — on this seam that is a
 * live oracle, letting someone with no credential at all probe the shape of key registration.
 */
export function requireControlPlane(requirement: ControlPlaneRequirement): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    const verify = c.var.controlPlaneVerifier;
    if (!verify) {
      const denial = new ControlPlaneNotConnectedError({
        message: "This deployment does not accept management-client calls.",
        action: "Add `controlplane()` to this Worker's pithy.config.ts, then run pithy dashboard connect.",
        detail: "no control-plane verifier on the request — the controlplane capability is not composed",
      });
      await auditDenial(c, requirement, denial);
      throw denial;
    }

    let context: ControlPlaneContext;
    try {
      context = await verify(c.req.raw, requirement);
    } catch (cause) {
      await auditDenial(c, requirement, cause);
      throw cause;
    }

    c.set("controlPlane", context);
    await safeEmit(
      c.var.emit,
      {
        action: ControlPlaneAuditActions.callAllowed,
        outcome: "success",
        actorType: "control-plane",
        actorId: context.subject,
        resourceType: "controlplane_connection",
        resourceId: context.connectionId,
        requestId: c.req.header("cf-ray"),
        ip: c.req.header("cf-connecting-ip"),
        userAgent: c.req.header("user-agent"),
        metadata: {
          connectionId: context.connectionId,
          connectionEnvironment: context.environment,
          scope: context.scope,
          keyId: context.keyId,
          method: c.req.method,
          path: c.req.path,
        },
      },
      c.var.log,
    );
    await next();
  };
}

/**
 * Record a refused call.
 *
 * **Denials are audited, not only successes.** `denied` is a first-class outcome precisely for this, and
 * this is the surface where an unaudited blocked attempt is least acceptable — a run of them is what a
 * credential being probed looks like, and it is invisible if only the successes are written down.
 *
 * The reason lands in `metadata.reason` from the error's `code`, never from its `detail`: `detail` names
 * the exact verification step, and the audit trail is queryable and long-lived. The step belongs in the
 * log, which is bounded and already carries the whole payload.
 *
 * Nothing here can turn a correct denial into a 500 — `safeEmit` swallows, and the caller rethrows the
 * original error regardless.
 */
async function auditDenial(
  c: Parameters<MiddlewareHandler<PithyHonoEnv>>[0],
  requirement: ControlPlaneRequirement,
  cause: unknown,
): Promise<void> {
  const code = cause instanceof PithyError ? cause.payload.code : "core/internal";
  await safeEmit(
    c.var.emit,
    {
      action: ControlPlaneAuditActions.callDenied,
      outcome: "denied",
      severity: "warning",
      actorType: "control-plane",
      // Null, deliberately. The `sub` claim of a call that failed verification is unproven, and writing
      // an unverified identity into the trail as the actor is how a forged token gets to name someone.
      actorId: null,
      requestId: c.req.header("cf-ray"),
      ip: c.req.header("cf-connecting-ip"),
      userAgent: c.req.header("user-agent"),
      metadata: { reason: code, required: String(requirement), method: c.req.method, path: c.req.path },
    },
    c.var.log,
  );
}
