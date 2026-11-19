// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { routesOf } from "@pithy-sh/core/src/http/lazyRoutes";
import { email } from "@pithy-sh/email/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { auth } from "../capability";
import { requireAuth } from "../http/middleware";
import {
  prepareScopedBackend,
  SCOPED_ORIGIN,
  SCOPED_REGISTRY,
  SCOPED_SESSION_SECRET,
  scopedWorkerEnv,
} from "./scopedBackend";
import { signInTestUser } from "./signIn";

/**
 * **`signInTestUser` against a real `auth()`, with an adopter's own route behind `requireAuth()`.**
 *
 * The session the helper mints is resolved by the session middleware the capability composes, from the row
 * Better Auth wrote, so a pass here is a pass a deployed Worker would give.
 */

/** The adopter's capability: one route that answers who is signed in. */
const appCapability = defineCapability({
  name: "things",
  requiredBindings: [],
  routes: routesOf((app) => {
    app.get("/things/me", requireAuth(), (c) => c.json({ userId: c.var.auth.userId }));
  }),
});

/** An app on `https://app.example.com`, where Better Auth names its session cookie with the `__Secure-` prefix. */
const SECURE_ORIGIN = "https://app.example.com";

function buildApp(origin: string) {
  return createBackend({
    capabilities: [
      secrets({ registry: SCOPED_REGISTRY }),
      email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: origin }),
      auth({ baseURL: origin, basePath: "/auth", trustedOrigins: [origin] }),
    ],
    app: appCapability,
  });
}

/** Ask the gated route who is signed in, with the headers given, on an app at `origin`. */
async function me(headers: HeadersInit, origin: string = SCOPED_ORIGIN): Promise<{ status: number; body: unknown }> {
  const res = await buildApp(origin).request(
    "/things/me",
    { headers },
    scopedWorkerEnv(env as unknown as Record<string, unknown>),
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  await prepareScopedBackend(env);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("signInTestUser", () => {
  test("a seeded user is signed in as themselves, and its headers pass requireAuth()", async () => {
    await env.DB.prepare(
      "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)",
    )
      .bind("user-ada", "Ada", "ada@example.com", new Date().toISOString(), new Date().toISOString())
      .run();

    const signedIn = await signInTestUser(env.DB, { email: "ada@example.com", secret: SCOPED_SESSION_SECRET });

    expect(signedIn.userId).toBe("user-ada");
    expect(await me(signedIn.headers)).toEqual({ status: 200, body: { userId: "user-ada" } });
  });

  test("an address nobody seeded becomes a new user, signed in", async () => {
    const signedIn = await signInTestUser(env.DB, { email: "new@example.com", secret: SCOPED_SESSION_SECRET });

    const row = await env.DB.prepare("select id from pithy_auth_users where email = ?")
      .bind("new@example.com")
      .first<{ id: string }>();
    expect(row?.id).toBe(signedIn.userId);
    expect(await me(signedIn.headers)).toEqual({ status: 200, body: { userId: signedIn.userId } });
  });

  test("the session is a real row, and ending it ends the pass", async () => {
    const signedIn = await signInTestUser(env.DB, { email: "kai@example.com", secret: SCOPED_SESSION_SECRET });

    await env.DB.prepare("delete from pithy_auth_sessions where id = ?").bind(signedIn.sessionId).run();

    expect((await me(signedIn.headers)).status).toBe(401);
  });

  test("the cookie passes too, for a browser-shaped test", async () => {
    const signedIn = await signInTestUser(env.DB, { email: "web@example.com", secret: SCOPED_SESSION_SECRET });

    expect(await me({ cookie: signedIn.cookie })).toEqual({ status: 200, body: { userId: signedIn.userId } });
  });

  test("on an https app, the cookie carries the secure name the Worker reads", async () => {
    const signedIn = await signInTestUser(env.DB, {
      email: "secure@example.com",
      secret: SCOPED_SESSION_SECRET,
      baseURL: SECURE_ORIGIN,
    });

    expect(signedIn.cookie).toMatch(/^__Secure-better-auth\.session_token=/);
    expect(await me({ cookie: signedIn.cookie }, SECURE_ORIGIN)).toEqual({
      status: 200,
      body: { userId: signedIn.userId },
    });
  });

  test("a cookie minted for http is not read by an https app", async () => {
    const signedIn = await signInTestUser(env.DB, { email: "plain@example.com", secret: SCOPED_SESSION_SECRET });

    expect((await me({ cookie: signedIn.cookie }, SECURE_ORIGIN)).status).toBe(401);
  });

  test("no headers is a 401", async () => {
    expect((await me({})).status).toBe(401);
  });
});
