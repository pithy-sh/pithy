// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { email } from "@pithy-sh/email/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { auth } from "../capability";
import {
  prepareScopedBackend,
  SCOPED_ORIGIN,
  SCOPED_REGISTRY,
  scopedWorkerEnv,
  signInScoped,
} from "../test-utils/scopedBackend";
import { requireRecentSignIn } from "./recentSignIn";

/**
 * **An app route behind `requireRecentSignIn`, reached through a real `auth()`.**
 *
 * The session is a real one, signed in through Better Auth and resolved by the session middleware, so the
 * `authenticatedAt` the gate reads is the one a deployed Worker would hand it — for a bearer token and for
 * a cookie alike, and across a rotation.
 */

const emitted: AuditEventInput[] = [];

/** The adopter's own capability: one gated route, and the audit seam replaced with a capturing one. */
const appCapability = defineCapability({
  name: "things",
  requiredBindings: [],
  middleware: [
    (app) => {
      app.use("*", async (c, next) => {
        c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
        await next();
      });
    },
  ],
  routes: (app) => {
    app.post("/things/secret", requireRecentSignIn({ maxAgeSeconds: 300, purpose: "things/secret_revealed" }), (c) =>
      c.json({ revealed: true }),
    );
  },
});

function buildApp() {
  return createBackend({
    capabilities: [
      secrets({ registry: SCOPED_REGISTRY }),
      email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: SCOPED_ORIGIN }),
      auth({ baseURL: SCOPED_ORIGIN, basePath: "/auth", trustedOrigins: [SCOPED_ORIGIN] }),
    ],
    app: appCapability,
  });
}

const workerEnv = () => scopedWorkerEnv(env as unknown as Record<string, unknown>);

/** Reach the gated route with the headers given, and read the status and any error code. */
async function reveal(headers: Record<string, string>): Promise<{ status: number; code: string | null }> {
  const res = await buildApp().request("/things/secret", { method: "POST", headers }, workerEnv());
  const answer = res.status >= 400 ? await res.json<{ error?: { code?: string } }>() : null;
  return { status: res.status, code: answer?.error?.code ?? null };
}

/** Move a session's sign-in instant into the past, touching nothing else about it. */
async function signedInAgo(token: string, seconds: number): Promise<void> {
  const at = new Date(Date.now() - seconds * 1000).toISOString();
  await env.DB.prepare("update pithy_auth_sessions set authenticated_at = ? where token = ?").bind(at, token).run();
}

let session: { token: string; userId: string; cookie: string };

beforeEach(async () => {
  emitted.length = 0;
  await prepareScopedBackend(env);
  session = await signInScoped(env.DB, "holder@example.com");
});

afterEach(() => {
  resetSharedSecrets();
});

describe("a bearer session", () => {
  test("a fresh sign-in passes", async () => {
    expect(await reveal({ authorization: `Bearer ${session.token}` })).toEqual({ status: 200, code: null });
    expect(emitted.filter((event) => event.action === "auth/recent_sign_in_refused")).toEqual([]);
  });

  test("a sign-in older than the window is refused, and the refusal is recorded", async () => {
    await signedInAgo(session.token, 600);
    expect(await reveal({ authorization: `Bearer ${session.token}` })).toEqual({
      status: 403,
      code: "auth/recent_sign_in_required",
    });
    expect(emitted.filter((event) => event.action === "auth/recent_sign_in_refused")).toEqual([
      expect.objectContaining({
        outcome: "denied",
        actorType: "user",
        actorId: session.userId,
        metadata: { purpose: "things/secret_revealed" },
      }),
    ]);
  });

  test("a rotated session keeps its sign-in instant and does not pass on rotation alone", async () => {
    await signedInAgo(session.token, 600);
    const rotated = await buildApp().request(
      "/auth/token/rotate",
      { method: "POST", headers: { authorization: `Bearer ${session.token}` } },
      workerEnv(),
    );
    expect(rotated.status).toBe(200);
    const { refreshToken } = await rotated.json<{ refreshToken: string }>();
    expect(refreshToken).not.toBe(session.token);
    expect(await reveal({ authorization: `Bearer ${refreshToken}` })).toEqual({
      status: 403,
      code: "auth/recent_sign_in_required",
    });
  });

  test("signing in again starts a session that passes", async () => {
    await signedInAgo(session.token, 600);
    const again = await signInScoped(env.DB, "holder@example.com");
    expect(await reveal({ authorization: `Bearer ${again.token}` })).toEqual({ status: 200, code: null });
  });
});

describe("a cookie session is judged by the same rule", () => {
  test("a fresh sign-in passes", async () => {
    expect(session.cookie).not.toBe("");
    expect(await reveal({ cookie: session.cookie, origin: SCOPED_ORIGIN })).toEqual({ status: 200, code: null });
  });

  test("a sign-in older than the window is refused", async () => {
    await signedInAgo(session.token, 600);
    expect(await reveal({ cookie: session.cookie, origin: SCOPED_ORIGIN })).toEqual({
      status: 403,
      code: "auth/recent_sign_in_required",
    });
  });
});

describe("no credential", () => {
  test("answers 401 auth/invalid_token, as requireAuth() does, and records no refusal", async () => {
    expect(await reveal({})).toEqual({ status: 401, code: "auth/invalid_token" });
    expect(emitted.filter((event) => event.action === "auth/recent_sign_in_refused")).toEqual([]);
  });
});
