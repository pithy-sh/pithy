// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { stubSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { TURNSTILE_LOGIN_ACTION } from "@pithy-sh/turnstile/src/config/config";
import { TURNSTILE_SECRET_NAME, turnstileSecretsRegistry } from "@pithy-sh/turnstile/src/secret/registry";
import { Hono } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { createAuthRoutes } from "./routes";

/**
 * The sign-in gate reads the token where turnstile's config says it is: the same `token` the client
 * projection hands a screen. A screen told to send a header, and a gate reading the body, refuse every
 * sign-in.
 */

const BASE_PATH = "/auth";
const MAGIC_LINK = `${BASE_PATH}/sign-in/magic-link`;
const HEADER = "x-turnstile-token";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

function app(): Hono<PithyHonoEnv> {
  const wiring: AuthWiring = {
    config: AuthConfig.parse({
      baseURL: "http://localhost",
      basePath: BASE_PATH,
      trustedOrigins: ["http://localhost"],
    }),
    resolveGithubUserInfo: undefined,
    enqueueEmail: undefined,
    turnstile: { mode: "visible", token: { field: "cf-turnstile-response", header: HEADER } },
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

async function signIn(headers: Record<string, string>, body: Record<string, string>) {
  stubSecrets(turnstileSecretsRegistry, { [TURNSTILE_SECRET_NAME]: { visible: { key: "0x4AAAAAAA-stubbed" } } });
  const siteverify = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ success: true, "error-codes": [], action: TURNSTILE_LOGIN_ACTION }),
  });
  vi.stubGlobal("fetch", siteverify);
  const res = await app().request(
    MAGIC_LINK,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ email: "someone@example.test", ...body }),
    },
    { ENVIRONMENT: "prod" },
  );
  const payload = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  return { res, siteverify, code: typeof payload?.error?.code === "string" ? payload.error.code : "" };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSharedSecrets();
});

test("a token in the configured header passes the sign-in gate", async () => {
  const { siteverify, code } = await signIn({ [HEADER]: TOKEN }, {});
  expect(siteverify).toHaveBeenCalledTimes(1);
  expect(code).not.toMatch(/^turnstile\//);
});

test("and the body field is not read when a header is configured", async () => {
  const { res, siteverify, code } = await signIn({}, { "cf-turnstile-response": TOKEN });
  expect(siteverify).not.toHaveBeenCalled();
  expect(res.status).toBe(400);
  expect(code).toBe("turnstile/missing_token");
});
