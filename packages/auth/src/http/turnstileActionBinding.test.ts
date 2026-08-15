// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { stubSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { turnstile } from "@pithy-sh/turnstile/src/capability";
import { TURNSTILE_SECRET_NAME, turnstileSecretsRegistry } from "@pithy-sh/turnstile/src/secret/registry";
import { Hono } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { createAuthRoutes } from "./routes";

/**
 * **The sign-in route asserts the action the widget was handed (#377).**
 *
 * Turnstile bakes an action label into the token at render and echoes it from siteverify; the gate
 * refuses a token whose action is not the one the route expects. Two ends, one string — and it used to
 * be typed out at both, `turnstile({ action: "login" })` here and `const ACTION = "login"` in the
 * scaffolded widget.
 *
 * ## Read this before deciding the gate is paranoid: dev and staging cannot see the failure
 *
 * `pithy turnstile provision` wires Cloudflare's documented **always-pass test secret** into dev and
 * staging, and that secret's siteverify answer carries **no `action` field at all**. The middleware
 * accepts exactly that answer in exactly those two environments, deliberately and narrowly (#374 —
 * `testKeyCarriesNoAction`). So in every environment anyone develops or tests in, there is nothing
 * coming back to compare against, and a drifted pair behaves precisely like a matching one.
 *
 * Production is the first environment that can tell, because a real widget echoes what it solved for.
 * There a mismatch refuses **every** sign-in with a 403 saying the challenge failed — which is true, and
 * points at the user rather than at the two strings. Locked-out users, and the wrong place to look.
 *
 * That is why these cases stamp `ENVIRONMENT` as **prod** and stub siteverify: it is the only way to run
 * the environment that can actually observe the binding, and the reason a green dev suite is not
 * evidence about this value.
 *
 * ## What is proven, and why it is not circular
 *
 * The expected action is taken from **`@pithy-sh/turnstile`'s client projection** — the value a browser
 * is handed and the widget is solved for — and it is checked against **`createAuthRoutes`**, which is the
 * subject. Neither reads the other. A route that expected some other label would refuse the token the
 * widget can actually produce, and the first case goes red.
 *
 * The second case is the control. The same request, the same everything, with one character changed in
 * the action siteverify returns — and the verdict flips to a 403 `turnstile/failed`. Without it the
 * first case could pass on a gate that had stopped comparing at all.
 *
 * The widget's half of the loop — that it renders the projected action rather than a literal of its own
 * — is `@pithy-sh/ui-react`'s `src/turnstileAction.test.tsx`.
 */

/** The mount path these cases pin. The gate is stacked relative to it. */
const BASE_PATH = "/auth";

/** Cloudflare's own path for the magic-link send, which is one of the two routes auth auto-gates. */
const MAGIC_LINK = `${BASE_PATH}/sign-in/magic-link`;

/** Any well-formed secret. siteverify is stubbed, so its value decides nothing — that it resolves does. */
const SECRET = "0x4AAAAAAA-not-a-test-key-and-never-verified";

/**
 * The action a browser is handed for this project — the widget's half of the contract, read from the
 * capability that produces it rather than from the route being tested.
 */
function projectedAction(): string {
  const capability = turnstile({ widgets: { visible: { sitekeys: { dev: "d", staging: "s", prod: "p" } } } });
  const projection = resolveClientProjection(capability, { environment: "prod" });
  const action = (projection as { action?: unknown }).action;
  if (typeof action !== "string" || action === "") {
    throw new Error("the turnstile client projection carries no action — the widget has nothing to solve for.");
  }
  return action;
}

/** The auth routes, gated exactly as `compose` wires them when turnstile is composed. */
function app(): Hono<PithyHonoEnv> {
  const wiring: AuthWiring = {
    config: AuthConfig.parse({
      baseURL: "http://localhost",
      basePath: BASE_PATH,
      trustedOrigins: ["http://localhost"],
    }),
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
 * POST the magic-link send with a token, against a siteverify that answers `success` with `action`.
 *
 * `ENVIRONMENT` is stamped **prod** because that is the only environment in which the binding is live —
 * see the file docblock. No `metadata.result_with_testing_key`, so nothing here is taken for a test key.
 */
async function signIn(action: string): Promise<{ res: Response; siteverify: ReturnType<typeof vi.fn> }> {
  stubSecrets(turnstileSecretsRegistry, { [TURNSTILE_SECRET_NAME]: { visible: { key: SECRET } } });
  const siteverify = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ success: true, "error-codes": [], action }),
  });
  vi.stubGlobal("fetch", siteverify);
  const res = await app().request(
    MAGIC_LINK,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.test", "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" }),
    },
    { ENVIRONMENT: "prod" },
  );
  return { res, siteverify };
}

/** The `code` from a `{ error: <public payload> }` response body; empty when the body is not one. */
async function errCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  return typeof body?.error?.code === "string" ? body.error.code : "";
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSharedSecrets();
});

test("a token solved for the projected action passes the sign-in gate", async () => {
  const { res, siteverify } = await signIn(projectedAction());
  // The gate ran: it resolved its secret and asked siteverify about the token. Asserted, because a
  // route that had quietly lost its gate would also fail to refuse, and would pass the line below.
  expect(siteverify).toHaveBeenCalledTimes(1);
  expect(String(siteverify.mock.calls[0]?.[0])).toContain("/turnstile/v0/siteverify");
  // And it did not refuse. Beyond it lies Better Auth reaching for a database this suite does not give
  // it, so the response is a 500 from further down the chain — which is itself the proof the request
  // got past the gate. The assertion is on the gate's own verdict: no `turnstile/*` code came back.
  expect(await errCode(res)).not.toMatch(/^turnstile\//);
});

test("and one solved for anything else is refused — the binding is live, not vacuous", async () => {
  const { res } = await signIn(`${projectedAction()}-drifted`);
  expect(res.status).toBe(403);
  expect(await errCode(res)).toBe("turnstile/failed");
});
