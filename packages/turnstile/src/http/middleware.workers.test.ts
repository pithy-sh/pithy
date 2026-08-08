// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TURNSTILE_SECRET_NAME, turnstileSecretsRegistry } from "../secret/registry";
import { turnstile } from "./middleware";

// The middleware reads its secret through the shared per-invocation accessor, so configure it from
// turnstile's slice before each case (and reset after) — each case then resolves fresh from the store.
beforeEach(() => configureSharedSecrets({ registry: turnstileSecretsRegistry }));
afterEach(() => resetSharedSecrets());

/**
 * Cloudflare's documented dummy *secret* keys. siteverify returns a deterministic verdict for each,
 * regardless of the response token — so the always-pass, always-block, and token-already-spent paths
 * are exercised against the real endpoint, in the Workers runtime, with no widget and no flake.
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
const SECRETS = {
  pass: "1x0000000000000000000000000000000AA",
  fail: "2x0000000000000000000000000000000AA",
  spent: "3x0000000000000000000000000000000AA",
} as const;

/** The form body the widget's own submit sends. */
const withToken = (token = "XXXX.DUMMY.TOKEN.XXXX") => new URLSearchParams({ "cf-turnstile-response": token });

/**
 * Provision `secret`, then POST `body` at a public route guarded by `turnstile()`.
 *
 * The secret is written as the encrypted row the middleware actually reads — the same store, the same
 * envelope, the same master key a deployed worker resolves through. Nothing is injected on the env:
 * since #153 a `d1` secret is never read from a binding, in any environment.
 */
async function post(secret: string, body: URLSearchParams): Promise<Response> {
  await seedSecrets(env, turnstileSecretsRegistry, { [TURNSTILE_SECRET_NAME]: { visible: { key: secret } } });
  const app = new Hono();
  app.onError(pithyErrorHandler);
  app.use("/login", turnstile());
  app.post("/login", (c) => c.json({ ok: true }));
  return app.request(
    "/login",
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
    env,
  );
}

/** The `code` from a `{ error: <public payload> }` response body. */
async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("turnstile() against live siteverify (Workers runtime)", () => {
  test("always-pass secret lets the request through", async () => {
    const res = await post(SECRETS.pass, withToken());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("always-block secret denies with turnstile/failed", async () => {
    const res = await post(SECRETS.fail, withToken());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("turnstile/failed");
  });

  test("token-already-spent secret denies with turnstile/failed", async () => {
    const res = await post(SECRETS.spent, withToken());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("turnstile/failed");
  });

  test("a missing token is rejected before any network call", async () => {
    const res = await post(SECRETS.pass, new URLSearchParams());
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("turnstile/missing_token");
  });
});
