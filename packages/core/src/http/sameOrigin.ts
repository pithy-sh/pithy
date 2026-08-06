// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MiddlewareHandler } from "hono";
import type { PithyHonoEnv } from "../capability/capability";
import { ForbiddenError } from "../error/pithyError";

/**
 * The same-origin seam — one CSRF decision per Worker, made where the origins are known.
 *
 * ## Why the gate arrives already bound
 *
 * The origins a cookie-authenticated mutation may come from are the composed auth capability's:
 * its `baseURL` plus its `trustedOrigins`. An adopter's own routes need the same rule, and the
 * `routes` hook hands them only the Hono app — so the only way to write the check beside auth's own
 * was to rebuild it from the request and hope the two agreed. They are free not to, and a Worker with
 * two same-origin implementations has the weaker one as its actual policy.
 *
 * So the capability that resolved the origins publishes the gate **already bound** to them, and
 * {@link requireSameOrigin} takes no argument. There is no origin list to pass, therefore no wrong one
 * to pass — which is the failure mode, not the ceremony of passing it.
 *
 * The alternative considered was handing resolved capability config to the `routes` hook. That serves
 * more cases (a base path, a rail toggle) and is worse here: it hands every adopter the raw material
 * for a second, differently-bound copy of a security decision, which is the thing being removed.
 *
 * ## It fails closed
 *
 * With no capability publishing a policy the gate denies, exactly as `requireEntitlement` does with no
 * provider composed. A gate that arrives with a package must not stand open when that package is
 * absent; the denial names the reason in `detail`, where an operator reads it and a client does not.
 */

/**
 * A same-origin gate, already bound to the origins the composing capability resolved. Published on
 * `c.var.sameOrigin`, consumed by {@link requireSameOrigin}, and null when nothing published one.
 *
 * Deliberately a bound middleware rather than the origin list: a list on the request context is an
 * invitation to build a second checker beside the first, and the point of the seam is that there is
 * one.
 */
export type SameOriginGate = MiddlewareHandler<PithyHonoEnv>;

/**
 * Require this request to come from an origin the Worker trusts — the CSRF gate a cookie-authenticated
 * mutating route wears, beside the strategy that says who the caller is.
 *
 *   app.post("/organisations", requireAuth(), requireSameOrigin(), zValidator(…), handler)
 *
 * A bearer request carries no ambient credential and is CSRF-exempt; that exemption belongs to the
 * published gate, since the capability that owns the credential model is the one that knows.
 */
export function requireSameOrigin(): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    const gate = c.var.sameOrigin;
    if (!gate) {
      throw new ForbiddenError({
        message: "Cross-origin request rejected.",
        action: "Compose a capability that resolves this Worker's trusted origins (auth), then retry.",
        detail: "no same-origin policy on the request — no composed capability published one",
      });
    }
    // `return await`, not `await`: a gate may answer by *returning* a Response rather than throwing,
    // and a wrapper that swallowed it would leave the request unanswered — a refusal reported as a 500.
    return await gate(c, next);
  };
}
