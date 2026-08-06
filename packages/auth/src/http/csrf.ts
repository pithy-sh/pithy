// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import { ForbiddenError } from "@pithy-sh/core/src/error/pithyError";
import type { SameOriginGate } from "@pithy-sh/core/src/http/sameOrigin";
import type { AuthWiring } from "../capability";

/**
 * CSRF origin guard for every state-changing route in the Worker — Pithy's own (token rotation, device
 * revoke) and the adopter's alike.
 *
 * Better Auth applies this check to its own endpoints; routes in front of the catch-all must enforce
 * it themselves to honor principle 2 ("cookie/session mode ⇒ CSRF on"). Bearer requests carry no
 * ambient credential, so they are CSRF-exempt and pass through. A cookie-authenticated request must
 * present an `Origin` (or `Referer`) matching an allowed origin.
 *
 * ## Nothing here takes an origin list
 *
 * The gate used to be built by whoever needed it, from origins they passed in. Auth's own routes had
 * the resolved ones; an adopter's routes did not — the `routes` hook receives only the Hono app — so
 * the adopter wrote the check again from the request and hoped the two agreed. One Worker, two
 * same-origin implementations, free to drift, and the weaker one is the real policy.
 *
 * Now the capability publishes the gate **already bound** to the origins it resolved, and core's
 * `requireSameOrigin()` takes no argument. There is no list to pass, so there is no wrong list to
 * pass — and no second implementation to keep in step.
 */
function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The origins a cookie-authenticated mutating request may come from: the base URL plus trustedOrigins. */
function allowedOrigins(baseURL: string, trustedOrigins: readonly string[]): string[] {
  const origins = new Set<string>(trustedOrigins);
  const base = originOf(baseURL);
  if (base) origins.add(base);
  return [...origins];
}

/** The decision itself, closed over the one resolved origin set. Never exported: see the module doc. */
function sameOriginGate(allowedOrigins: readonly string[]): SameOriginGate {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    // A bearer request has no ambient credential to forge — CSRF-exempt.
    if (c.req.raw.headers.has("authorization")) {
      await next();
      return;
    }
    const origin = c.req.raw.headers.get("origin") ?? originOf(c.req.raw.headers.get("referer"));
    if (!origin || !allowed.has(origin)) {
      throw new ForbiddenError({
        message: "Cross-origin request rejected.",
        action: "Send the request from an allowed origin, or use a bearer token.",
        detail: `origin ${origin ?? "(none)"} is not in trustedOrigins`,
      });
    }
    await next();
  };
}

/**
 * Publish the bound gate on every request, as capability middleware.
 *
 * Built once at composition, not per request: the origin set is resolved config, and re-deriving it on
 * the hot path is work that can only ever produce the same answer — or a different one, which is the
 * bug. Registered on `*` rather than under `basePath`, because the routes that most need it are the
 * adopter's, and those are anywhere.
 */
export function publishSameOrigin(wiring: AuthWiring): PithyMiddleware {
  const gate = sameOriginGate(allowedOrigins(wiring.config.baseURL, wiring.config.trustedOrigins));
  return (app) => {
    app.use("*", async (c, next) => {
      c.set("sameOrigin", gate);
      await next();
    });
  };
}
