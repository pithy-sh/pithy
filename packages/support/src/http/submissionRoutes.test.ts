// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { registerSupportRoutes } from "./routes";

/**
 * The gates on the in-app surface, exercised through real requests.
 *
 * Two properties, and both are the kind that a reader of `routes.ts` can convince themselves of and be
 * wrong about: that the surface **fails closed** with no auth capability composed, and that the gate
 * runs **before** the validator. No database and no deps are needed for either — every request under
 * test is refused before a handler could resolve one, which is exactly the claim.
 */

/**
 * The composed sub-router, with the error handler that turns a `PithyError` into its wire form.
 *
 * `reached` is how a *pass* is asserted: resolving deps is the first thing after the last gate, so a
 * request that gets there passed every one of them. Nothing beyond it is exercised — the resolver
 * throws, which is why every passing request here still ends in a 500.
 */
function makeApp(options: { auth?: { userId: string }; sameOrigin?: boolean; submission?: boolean } = {}): {
  app: Hono<PithyHonoEnv>;
  reached: () => boolean;
} {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    if (options.auth) c.set("auth", { ...options.auth, sessionId: "s-1", scopes: [] });
    // The gate `@pithy-sh/auth` publishes when it is composed. Absent by default, because the point of
    // most of these tests is a Worker that never composed it.
    if (options.sameOrigin) c.set("sameOrigin", async (_c, next) => next());
    await next();
  });
  let reached = false;
  registerSupportRoutes({
    submission: options.submission,
    resolveDeps: async () => {
      reached = true;
      throw new Error("the gates passed; nothing beyond them is under test here");
    },
  })(app);
  return { app, reached: () => reached };
}

/** A well-formed submission body, so a 400 can only mean the validator ran. */
const BODY = JSON.stringify({ subject: "Export button", body: "Nothing happens." });
const HEADERS = { "content-type": "application/json" };

async function codeOf(response: Response): Promise<string> {
  const payload = (await response.json()) as { error?: { code?: string } };
  return payload.error?.code ?? "";
}

describe("the in-app surface fails closed", () => {
  test("with no auth capability composed, every route denies", async () => {
    const { app, reached } = makeApp();
    for (const request of [
      new Request("http://t/support/feedback", { method: "POST", body: BODY, headers: HEADERS }),
      new Request("http://t/support/feedback"),
      new Request("http://t/support/feedback/0195c1f0-0000-7000-8000-000000000000"),
    ]) {
      const response = await app.fetch(request);
      expect(response.status, request.url).toBe(401);
      expect(await codeOf(response)).toBe("auth/invalid_token");
    }
    expect(reached()).toBe(false);
  });

  test("the gate runs before the validator, so a malformed body still answers 401", async () => {
    // A validator ahead of the gate turns a 401 into a 400 and tells an unauthenticated caller which
    // requests were well-formed — a live oracle for the shape of an adopter's support tooling.
    const response = await makeApp().app.fetch(
      new Request("http://t/support/feedback", { method: "POST", body: "{}", headers: HEADERS }),
    );
    expect(response.status).toBe(401);
  });

  test("an authenticated caller with no same-origin policy is still refused", async () => {
    // A CSRF gate whose policy is missing must refuse rather than stand open: the capability that owns
    // the credential model is the one that knows which origins are trusted, and with none composed
    // there is no answer that is safe to assume.
    const { app, reached } = makeApp({ auth: { userId: "u-1" } });
    const response = await app.fetch(
      new Request("http://t/support/feedback", { method: "POST", body: BODY, headers: HEADERS }),
    );
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("auth/forbidden");
    expect(reached()).toBe(false);
  });

  test("both gates pass for a signed-in caller on a Worker that published a policy", async () => {
    const { app, reached } = makeApp({ auth: { userId: "u-1" }, sameOrigin: true });
    await app.fetch(new Request("http://t/support/feedback", { method: "POST", body: BODY, headers: HEADERS }));
    expect(reached()).toBe(true);
  });

  test("the reads carry no CSRF gate, because a GET is not a mutation", async () => {
    const { app, reached } = makeApp({ auth: { userId: "u-1" } });
    await app.fetch(new Request("http://t/support/feedback"));
    expect(reached()).toBe(true);
  });

  test("with the channel off the routes are not served at all", async () => {
    // 404 rather than 403: a route that is not served has nothing to say about who was asking.
    const response = await makeApp({ submission: false }).app.fetch(
      new Request("http://t/support/feedback", { method: "POST", body: BODY, headers: HEADERS }),
    );
    expect(response.status).toBe(404);
  });

  test("a session confers no control-plane scope", async () => {
    // The two surfaces are not two strengths of one gate. A signed-in user's session must never open
    // the inbox that holds every other customer's correspondence.
    const { app, reached } = makeApp({ auth: { userId: "u-1" } });
    const response = await app.fetch(new Request("http://t/support/threads"));
    expect(response.status).toBe(403);
    expect(reached()).toBe(false);
  });
});
