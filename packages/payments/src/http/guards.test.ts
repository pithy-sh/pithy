import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { PAYMENTS_CONTROL_PLANE_SCOPE, requireAuth, requireControlPlane } from "./guards";

/**
 * The gates on their own, before any route uses them. Both are three lines, and both are the difference
 * between a paid feature and a free one, so each branch is asserted directly rather than only through a route
 * that happens to exercise it.
 */

/** An app whose fake auth middleware sets whatever the request headers ask for — or nothing at all. */
function app(guarded: ReturnType<typeof requireAuth>, options: { withAuth?: boolean } = { withAuth: true }) {
  const hono = new Hono<PithyHonoEnv>();
  hono.onError(pithyErrorHandler);
  if (options.withAuth) {
    hono.use("*", async (c, next) => {
      const user = c.req.header("x-user");
      const scopes = c.req.header("x-scopes")?.split(",").filter(Boolean) ?? [];
      c.set("auth", user ? { userId: user, sessionId: "s1", scopes } : null);
      await next();
    });
  }
  hono.get("/gated", guarded, (c) => c.json({ ok: true }));
  return (headers: Record<string, string> = {}) => hono.request("http://x/gated", { headers });
}

const code = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

describe("requireAuth", () => {
  test("passes an authenticated caller through", async () => {
    const response = await app(requireAuth())({ "x-user": "ada" });
    expect(response.status).toBe(200);
  });

  test("denies an anonymous caller with 401", async () => {
    const response = await app(requireAuth())();
    expect(response.status).toBe(401);
    expect(await code(response)).toBe("auth/invalid_token");
  });

  test("denies when no auth capability is composed at all — the reason it is copied, not imported", async () => {
    // Nothing sets `c.var.auth`, so it is undefined rather than null. A gate that only checked for `null`
    // would fail open in exactly the deployment that has no auth.
    const response = await app(requireAuth(), { withAuth: false })({ "x-user": "ada" });
    expect(response.status).toBe(401);
  });
});

describe("requireControlPlane", () => {
  test("passes a credential carrying the scope", async () => {
    const response = await app(requireControlPlane())({
      "x-user": "support-bot",
      "x-scopes": PAYMENTS_CONTROL_PLANE_SCOPE,
    });
    expect(response.status).toBe(200);
  });

  test("denies an ordinary authenticated user with 403", async () => {
    // `AuthContext.scopes` defaults to an empty array, so an ordinary token holds nothing and the gate is
    // default-denied without anything being configured.
    const response = await app(requireControlPlane())({ "x-user": "ada" });
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("auth/forbidden");
  });

  test("denies a credential carrying other scopes", async () => {
    const response = await app(requireControlPlane())({ "x-user": "ada", "x-scopes": "payments:read,ledger:admin" });
    expect(response.status).toBe(403);
  });

  test("denies an anonymous caller — the gate is safe whatever ran before it", async () => {
    expect((await app(requireControlPlane())()).status).toBe(403);
  });

  test("denies when no auth capability is composed", async () => {
    const response = await app(requireControlPlane(), { withAuth: false })({
      "x-scopes": PAYMENTS_CONTROL_PLANE_SCOPE,
    });
    expect(response.status).toBe(403);
  });

  test("a scope that merely contains the required one does not pass", async () => {
    // Membership, not substring. `payments:admin:readonly` is a different scope.
    const response = await app(requireControlPlane())({ "x-user": "ada", "x-scopes": "payments:admin:readonly" });
    expect(response.status).toBe(403);
  });

  test("does not tell the caller which scopes it holds, but tells the operator", async () => {
    const response = await app(requireControlPlane())({ "x-user": "ada", "x-scopes": "payments:read" });
    const body = await response.json<{ error: { message: string; detail?: string } }>();
    // The HTTP codec strips `detail`; the message names the required scope so a support engineer can act.
    expect(body.error.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("payments:read");
  });

  test("an explicit scope overrides the default", async () => {
    const response = await app(requireControlPlane("acme:support"))({ "x-user": "bot", "x-scopes": "acme:support" });
    expect(response.status).toBe(200);
    expect(
      (await app(requireControlPlane("acme:support"))({ "x-user": "bot", "x-scopes": PAYMENTS_CONTROL_PLANE_SCOPE }))
        .status,
    ).toBe(403);
  });
});
