// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AuditAction } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { emitRecentSignInRefused } from "../audit/emit";
import { requireAuth } from "./middleware";

/**
 * Whether `authenticatedAt` falls within the last `maxAgeSeconds` of `now`, boundary included.
 *
 * `authenticatedAt` is the session's sign-in instant: stamped once at sign-in and carried across every
 * rotation, unlike the session's `createdAt`, which a rotation restamps. So a rotation never passes a
 * window that the sign-in did not.
 *
 * **Fails closed on anything it cannot read.** An absent, unparseable or future timestamp is not evidence
 * of a recent sign-in. The future case matters as much as the past: a window checked on one side only
 * would pass any future value forever.
 */
export function authenticatedWithin(
  authenticatedAt: Date | string | null | undefined,
  now: Date,
  maxAgeSeconds: number,
): boolean {
  if (authenticatedAt === null || authenticatedAt === undefined) return false;
  const at = authenticatedAt instanceof Date ? authenticatedAt : new Date(authenticatedAt);
  const millis = at.getTime();
  if (Number.isNaN(millis)) return false;
  const age = (now.getTime() - millis) / 1000;
  if (age < 0) return false;
  return age <= maxAgeSeconds;
}

/** What an app route's recent-sign-in gate is built from. Checked once, when the gate is built. */
export const RecentSignInOptions = z
  .object({
    maxAgeSeconds: z
      .number()
      .int()
      .positive()
      .describe("How recently the caller must have signed in, in seconds, for this route. A whole number above zero."),
    purpose: AuditAction.describe(
      "What the route protects, as the app's own `domain/reason` (`things/secret_revealed`). Recorded as `metadata.purpose` on the `auth/recent_sign_in_refused` audit row.",
    ),
  })
  .describe("The window and the audit purpose of one `requireRecentSignIn` gate.");
export type RecentSignInOptions = z.infer<typeof RecentSignInOptions>;

/**
 * The refusal for an app route reached without a recent enough sign-in: 403 `auth/recent_sign_in_required`.
 *
 * One code for every gated route, so a client renders one remedy — sign in again, then retry — wherever it
 * meets it. `message` says nothing was changed, because the caller cannot otherwise tell whether the
 * request half-happened.
 */
export function recentSignInRequired(): PithyError {
  return new PithyError({
    code: "auth/recent_sign_in_required",
    status: 403,
    message: "Sign in again to continue. Nothing was changed.",
    action:
      "A deliberate gate: this route requires a sign-in within the window its `requireRecentSignIn` names. Sign in again, then retry.",
    detail: "session authenticatedAt is outside the route's window, absent, or unreadable",
  });
}

/**
 * Gate an app route on a recent sign-in, with the window the route names.
 *
 * ```ts
 * app.post(
 *   "/things/:id/secret",
 *   describeRoute({ … }),
 *   requireRecentSignIn({ maxAgeSeconds: 300, purpose: "things/secret_revealed" }),
 *   validate("param", ThingParams),
 *   handler,
 * );
 * ```
 *
 * - No credential answers exactly as `requireAuth()` does.
 * - A session whose `authenticatedAt` is older than `maxAgeSeconds`, absent, unreadable or in the future is
 *   refused with {@link recentSignInRequired}, after an `auth/recent_sign_in_refused` audit row naming the
 *   user, the session and `purpose`.
 * - A bearer session and a cookie session are judged by the same rule. A phone passes by signing in again,
 *   which starts a session with a new `authenticatedAt`; a rotation does not.
 *
 * `options` is checked here, so a `maxAgeSeconds` that is not a positive whole number or a `purpose` that is
 * not `domain/reason` throws when the route is declared rather than on a request.
 */
export function requireRecentSignIn(
  options: RecentSignInOptions,
  now: () => Date = () => new Date(),
): MiddlewareHandler<PithyHonoEnv> {
  const { maxAgeSeconds, purpose } = RecentSignInOptions.parse(options);
  const authenticated = requireAuth();
  return (c, next) =>
    authenticated(c, async () => {
      // `requireAuth()` has already refused a request with no `AuthContext`.
      const auth = c.var.auth;
      if (auth && authenticatedWithin(auth.authenticatedAt, now(), maxAgeSeconds)) return next();
      if (auth) {
        await emitRecentSignInRefused(c.var.emit, {
          purpose,
          userId: auth.userId,
          sessionId: auth.sessionId,
          headers: c.req.raw.headers,
        });
      }
      throw recentSignInRequired();
    });
}
