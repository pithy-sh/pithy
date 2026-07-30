// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { RateLimitError } from "@pithy-sh/core/src/error/pithyError";
import type { MiddlewareHandler } from "hono";

/**
 * Tier 1 of two: the coarse edge rate limiter.
 *
 * Cloudflare's native Workers Rate Limiting binding caps requests per client IP at the edge with no
 * storage round-trip — blunting floods and credential-stuffing before they reach Better Auth's
 * per-action D1 limiter (tier 2: the 5/min magic-link and 3/min OTP caps, keyed per identity). Two
 * limiters, two jobs: this one is a cheap per-IP flood guard across every auth route; tier 2 is the
 * fine-grained per-action cap.
 *
 * Keys on `cf-connecting-ip`. The limit and window are set on the binding in `wrangler.jsonc`, not
 * here. Skips only when the binding is absent (local dev / tests) — in a real deployment the binding is
 * a required binding, enforced at compose.
 */
export function createRateLimitMiddleware(bindingName: string): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    const limiter = (c.env as Record<string, unknown>)[bindingName] as RateLimit | undefined;
    if (limiter && typeof limiter.limit === "function") {
      const key = c.req.raw.headers.get("cf-connecting-ip") ?? "anonymous";
      const { success } = await limiter.limit({ key });
      if (!success) {
        throw new RateLimitError({
          message: "Too many requests.",
          action: "Slow down and retry in a moment.",
        });
      }
    }
    await next();
  };
}
