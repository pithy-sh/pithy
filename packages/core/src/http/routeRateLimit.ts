// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import { z } from "zod";
import type { PithyHonoEnv } from "../capability/capability";
import { commandName } from "../cli/command";
import { InternalError, RateLimitError, UnauthorizedError } from "../error/pithyError";

/**
 * **A route's own rate limit, declared on its `describeRoute` and enforced by the gate that declaration installs.**
 *
 * Each limit is backed by a Workers Rate Limiting binding. Cloudflare sets the limit and the period on the binding,
 * not on the call, so one binding serves exactly one policy: every route declaring `20` per `60` seconds shares
 * `ROUTE_RATE_LIMIT_20_PER_60S`, and the counter key names the route, so two routes sharing a binding still keep
 * two budgets. `pithy worker sync` writes one binding per policy the composed routes declare, and takes out one no
 * route declares any more.
 */

/** The periods Workers Rate Limiting accepts, in seconds. */
export const RATE_LIMIT_PERIODS = [10, 60] as const;

/** A route's rate limit: who is counted, how many requests each may make, and over what period. */
export const RouteRateLimit = z
  .object({
    key: z
      .enum(["user", "ip"])
      .describe(
        "Who is counted. `user` counts each signed-in user, so only a route every caller of which is signed in may declare it. `ip` counts each client address, from `cf-connecting-ip`.",
      ),
    limit: z.number().int().min(1).describe("How many requests each caller may make in one period."),
    period: z
      .union([z.literal(10), z.literal(60)])
      .describe("The period in seconds. Workers Rate Limiting accepts 10 or 60, nothing else."),
  })
  .strict()
  .describe("A route's rate limit, enforced per user or per client address by a Workers Rate Limiting binding.");
export type RouteRateLimit = z.infer<typeof RouteRateLimit>;

/** The prefix every route rate-limit binding carries, and the one `pithy worker sync` recognizes its own by. */
export const ROUTE_RATE_LIMIT_PREFIX = "ROUTE_RATE_LIMIT_";

const BINDING = /^ROUTE_RATE_LIMIT_[1-9][0-9]*_PER_(10|60)S$/;

/** The binding one policy is enforced through: `ROUTE_RATE_LIMIT_<limit>_PER_<period>S`. */
export function routeRateLimitBinding(policy: Pick<RouteRateLimit, "limit" | "period">): string {
  return `${ROUTE_RATE_LIMIT_PREFIX}${policy.limit}_PER_${policy.period}S`;
}

/** Whether a binding name is one {@link routeRateLimitBinding} composes. */
export function isRouteRateLimitBinding(name: string): boolean {
  return BINDING.test(name);
}

/** What a Workers Rate Limiting binding answers to. */
interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

function isLimiter(value: unknown): value is Limiter {
  return typeof value === "object" && value !== null && typeof (value as Limiter).limit === "function";
}

/**
 * Count this request against the route's limit, and refuse it with `rate_limit/exceeded` (429) past the limit.
 *
 * A `user` limit with nobody signed in answers 401 and counts nothing: the composition refuses a `user` limit on a
 * route that admits an anonymous caller, so a request reaching here unsigned is one a guard below would refuse too.
 */
export async function enforceRouteRateLimit(c: Context<PithyHonoEnv>, rateLimit: RouteRateLimit): Promise<void> {
  const binding = routeRateLimitBinding(rateLimit);
  let caller: string;
  if (rateLimit.key === "user") {
    if (!c.var.auth) {
      throw new UnauthorizedError({
        message: "Authentication required.",
        action: "Sign in and retry with a valid session or bearer token.",
        detail: `describeRoute(rateLimit: user) ran with no signed-in caller on ${c.req.method} ${c.req.routePath}`,
      });
    }
    caller = `user:${c.var.auth.userId}`;
  } else {
    caller = `ip:${c.req.header("cf-connecting-ip") ?? "anonymous"}`;
  }
  const limiter = (c.env as Record<string, unknown> | undefined)?.[binding];
  if (!isLimiter(limiter)) {
    throw new InternalError({
      action: `Run \`${commandName("worker sync")}\` to write the ${binding} rate limiter into wrangler.jsonc, then restart the Worker.`,
      detail: `${c.req.method} ${c.req.routePath} declares a rate limit, and the Worker has no ${binding} binding`,
    });
  }
  // Hono serves HEAD by running the GET route, so a HEAD spends the GET route's budget rather than a second one.
  const method = c.req.method === "HEAD" ? "GET" : c.req.method;
  const { success } = await limiter.limit({ key: `${method} ${c.req.routePath} ${caller}` });
  if (!success) {
    throw new RateLimitError({
      message: "Too many requests.",
      action: "Slow down and retry in a moment.",
      detail: `${caller} passed ${rateLimit.limit} per ${rateLimit.period}s on ${c.req.method} ${c.req.routePath}`,
    });
  }
}
