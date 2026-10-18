// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ForbiddenError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";
import { LeaderboardSubmitForbiddenError } from "../error/errors";

/**
 * Route guards.
 *
 * These depend on the core `AuthContext` seam and nothing else — `@pithy-sh/auth` populates `c.var.auth`,
 * and leaderboard never reaches into its internals (CLAUDE.md §HTTP). Without auth installed `c.var.auth`
 * is null and every route below is denied, which is the correct failure: an entry with no stable player
 * id cannot be keyed, upserted, or rate-limited, so an unauthenticated board is not a degraded board but
 * an append log of unattributable scores.
 */
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
 * Require the board's submit scope while `serverAuthoritative` is on.
 *
 * Every vendor that offers server-authoritative writes ships it **off**; Pithy ships it **on**. The scope
 * is the seam: resolve it for your own trusted backend and never for a player's device, and a device cannot
 * post a score it invented. Turning `serverAuthoritative` off removes this gate entirely — which is the
 * vendor default, and is why it is not ours.
 *
 * **A scope is an attestation about the caller, not a permission granted to the user.** It says this
 * request came from the adopter's own backend. `@pithy-sh/auth`'s `resolveScopes` makes that call on every
 * request — over a service binding, a verified client certificate, or a short-lived token bound to this
 * origin — and with no resolver composed the array is empty and this gate refuses every caller (#560).
 */
export function requireSubmitScope(serverAuthoritative: boolean, scope: string): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    if (serverAuthoritative && !c.var.auth?.scopes.includes(scope)) {
      throw new LeaderboardSubmitForbiddenError({
        detail: `Submit requires the ${scope} scope; this session carries [${c.var.auth?.scopes.join(", ") ?? ""}].`,
      });
    }
    await next();
  };
}

/**
 * Require the admin scope for moderation — hiding or removing another player's entry.
 *
 * There is no toggle: moderation is always the trusted backend's. The scope is an attestation about the
 * caller, not a permission granted to the user — see {@link requireSubmitScope} — so with no
 * `resolveScopes` composed on `@pithy-sh/auth` these routes refuse every caller.
 */
export function requireAdminScope(scope: string): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    if (!c.var.auth?.scopes.includes(scope)) {
      throw new ForbiddenError({
        message: "This session may not moderate leaderboard entries.",
        action: `Retry with a token carrying the ${scope} scope.`,
        detail: `Moderation requires the ${scope} scope; this session carries [${c.var.auth?.scopes.join(", ") ?? ""}].`,
      });
    }
    await next();
  };
}
