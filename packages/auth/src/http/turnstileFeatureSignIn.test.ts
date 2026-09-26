// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { stubSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { TURNSTILE_SECRET_NAME, turnstileSecretsRegistry } from "@pithy-sh/turnstile/src/secret/registry";
import { Hono } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { createAuthRoutes } from "./routes";

/**
 * **A feature deployment can sign somebody in (#656).**
 *
 * The reproduction, on kit 0.11.0 against a real branch deployment:
 *
 * ```
 * POST /auth/sign-in/magic-link
 * {"error":{"code":"turnstile/config","status":500,"message":"Turnstile is not configured."}}
 * ```
 *
 * Nothing was wrong with the request. `@pithy-sh/auth` auto-gates the magic-link and OTP sends, and the
 * gate could not resolve a widget secret: `pithy turnstile provision` writes dev's secrets file and
 * staging's and prod's stores, and a branch's store is created empty by `pithy provision --feature`. So
 * every protected route on the deployment refused, sign-in included, and there was no adopter edit that
 * could have prevented it — a feature's config is generated per branch and nobody owns it.
 *
 * ## What this holds, and why it is not the middleware's own suite again
 *
 * `@pithy-sh/turnstile`'s `http/middleware.test.ts` proves the gate defaults a feature to Cloudflare's
 * always-pass pair, and its `middleware.workers.test.ts` proves that pair is genuinely Cloudflare's by
 * asking live siteverify. Neither says the *composed* sign-in route works: the route is auth's, it stacks
 * the gate itself with `action: "login"`, and the 500 above came from that composition. So this drives the
 * real `createAuthRoutes` at the real path, and asserts both halves of what a branch needs — the secret the
 * gate sends, and that no `turnstile/*` refusal comes back.
 *
 * The control is the same request stamped `prod`, which must still refuse. Without it, "the gate stopped
 * refusing" would pass this file, and that is a hole in every deployment rather than a fix for one.
 */

/** The mount path, and Cloudflare's own magic-link send under it — one of the two routes auth gates. */
const MAGIC_LINK = "/auth/sign-in/magic-link";

/**
 * Cloudflare's documented always-pass test *secret*, written out rather than imported from
 * `@pithy-sh/turnstile`: the value under test is what the gate defaults to, and an expectation taken from
 * the gate's own constant could only agree with itself.
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
const PASS_SECRET = "1x0000000000000000000000000000000AA";

/** What that secret answers — `success`, Cloudflare's own test-key flag, and no `action` field at all. */
const TEST_KEY_PASS = { success: true, "error-codes": [], metadata: { result_with_testing_key: true } };

/** The auth routes, gated exactly as `compose` wires them when turnstile is composed. */
function app(): Hono<PithyHonoEnv> {
  const wiring: AuthWiring = {
    config: AuthConfig.parse({
      baseURL: "http://localhost",
      basePath: "/auth",
      trustedOrigins: ["http://localhost"],
    }),
    resolveGithubUserInfo: undefined,
    enqueueEmail: undefined,
    turnstile: { mode: "visible" },
  };
  const hono = new Hono<PithyHonoEnv>();
  hono.onError(pithyErrorHandler);
  hono.use("*", async (c, next) => {
    if (c.get("emit") === undefined) c.set("emit", noopEmit);
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  createAuthRoutes(wiring)(hono);
  return hono;
}

/**
 * POST the magic-link send with a token, from a Worker stamped `environment`, with **no turnstile secret
 * provisioned** — declared and never written, which is how a branch's store reads.
 */
async function signIn(environment: string): Promise<{ res: Response; siteverify: ReturnType<typeof vi.fn> }> {
  stubSecrets(turnstileSecretsRegistry, {});
  const siteverify = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => TEST_KEY_PASS,
  });
  vi.stubGlobal("fetch", siteverify);
  const res = await app().request(
    MAGIC_LINK,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.test", "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" }),
    },
    { ENVIRONMENT: environment },
  );
  return { res, siteverify };
}

/** The `code` from a `{ error: <public payload> }` response body; empty when the body is not one. */
async function errCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  return typeof body?.error?.code === "string" ? body.error.code : "";
}

/** The `secret` form field of a recorded siteverify call. */
function sentSecret(siteverify: ReturnType<typeof vi.fn>): string | null {
  const args = siteverify.mock.calls[0];
  if (!args) throw new Error("siteverify was never called — the gate did not reach it.");
  return ((args[1] as RequestInit).body as URLSearchParams).get("secret");
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSharedSecrets();
});

test("a feature deployment's magic-link send passes the gate on the documented test secret", async () => {
  const { res, siteverify } = await signIn("feature");
  // The gate ran and verified against Cloudflare's always-pass pair, with nothing provisioned for the
  // branch and no adopter edit.
  expect(siteverify).toHaveBeenCalledTimes(1);
  expect(String(siteverify.mock.calls[0]?.[0])).toContain("/turnstile/v0/siteverify");
  expect(sentSecret(siteverify)).toBe(PASS_SECRET);
  // And it did not refuse. Beyond it lies Better Auth reaching for a database this suite does not give it,
  // so the response is a fault from further down the chain — which is itself proof the request got past the
  // gate. The assertion is on the gate's own verdict: no `turnstile/*` code came back.
  expect(await errCode(res)).not.toMatch(/^turnstile\//);
});

test("and prod still refuses, naming the environment rather than blaming the caller", async () => {
  const { res, siteverify } = await signIn("prod");
  expect(siteverify).not.toHaveBeenCalled();
  expect(res.status).toBe(500);
  // The sentence an operator gets is the one this issue asked for: which environment, and what is absent.
  const { error } = (await res.json()) as { error: { code: string; message: string } };
  expect(error.code).toBe("turnstile/config");
  expect(error.message).toContain("prod");
  expect(error.message).toMatch(/widget secret/i);
});

test("the secret a feature falls back to is the store's when the store has one", async () => {
  // The default fills an absence. A branch an adopter deliberately provisioned a real widget for verifies
  // against that widget, and this is what says the fallback is not an override.
  stubSecrets(turnstileSecretsRegistry, { [TURNSTILE_SECRET_NAME]: { visible: { key: "0xa-real-branch-secret" } } });
  const siteverify = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ success: true, "error-codes": [], action: "login" }),
  });
  vi.stubGlobal("fetch", siteverify);
  const res = await app().request(
    MAGIC_LINK,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.test", "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" }),
    },
    { ENVIRONMENT: "feature" },
  );
  expect(sentSecret(siteverify)).toBe("0xa-real-branch-secret");
  expect(await errCode(res)).not.toMatch(/^turnstile\//);
});
