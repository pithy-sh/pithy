import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createRateLimitMiddleware } from "./rateLimit";

function app() {
  const a = new Hono<PithyHonoEnv>();
  a.onError(pithyErrorHandler);
  a.use("*", createRateLimitMiddleware("AUTH_RATE_LIMITER"));
  a.get("/x", (c) => c.text("ok"));
  return a;
}

describe("createRateLimitMiddleware", () => {
  test("allows a request the limiter permits", async () => {
    const res = await app().request("/x", {}, { AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) } });
    expect(res.status).toBe(200);
  });

  test("blocks a request the limiter denies with 429", async () => {
    const res = await app().request("/x", {}, { AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } });
    expect(res.status).toBe(429);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("rate_limit/exceeded");
  });

  test("keys the limit on the client IP", async () => {
    let seen: string | undefined;
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        seen = key;
        return { success: true };
      },
    };
    await app().request("/x", { headers: { "cf-connecting-ip": "203.0.113.9" } }, { AUTH_RATE_LIMITER: limiter });
    expect(seen).toBe("203.0.113.9");
  });

  test("skips gracefully when the binding is absent (dev/test)", async () => {
    const res = await app().request("/x", {}, {});
    expect(res.status).toBe(200);
  });
});
