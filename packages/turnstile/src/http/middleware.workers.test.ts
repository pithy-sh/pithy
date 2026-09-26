// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { secretsTables } from "@pithy-sh/secrets/src/data/tables";
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
  /** A secret of the right shape that Cloudflare has never issued. Answers 400 `invalid-input-secret`. */
  unknown: "0x0000000000000000000000000000000ZZ",
} as const;

/** The form body the widget's own submit sends. */
const withToken = (token = "XXXX.DUMMY.TOKEN.XXXX") => new URLSearchParams({ "cf-turnstile-response": token });

/** What a case asks the gate for, beyond the secret: the route's action and the Worker's environment. */
interface Deployment {
  /** The expected action, as `createAuthRoutes` stacks it (`turnstile({ action: "login" })`). */
  action?: string;
  /**
   * The Worker's stamped `ENVIRONMENT`. Defaults to `dev`, which is what a Worker under `pithy dev`
   * carries — every deployed and scaffolded Worker stamps one, and `undefined` here is the case that
   * asserts what happens to the ones that do not.
   */
  environment?: string | undefined;
}

/**
 * Provision `secret`, then POST `body` at a public route guarded by `turnstile()`.
 *
 * The secret is written as the encrypted row the middleware actually reads — the same store, the same
 * envelope, the same master key a deployed worker resolves through. Nothing but the identity var is
 * injected on the env: since #153 a `d1` secret is never read from a binding, in any environment.
 */
async function post(secret: string, body: URLSearchParams, deployment: Deployment = {}): Promise<Response> {
  await seedSecrets(env, turnstileSecretsRegistry, { [TURNSTILE_SECRET_NAME]: { visible: { key: secret } } });
  return send(body, deployment);
}

/**
 * The same route with **nothing provisioned** — the store's tables exist and hold no turnstile row.
 *
 * That is every feature deployment (#656): `pithy turnstile provision` writes dev's secrets file and
 * staging's and prod's stores, and `pithy provision --feature` creates a branch's store empty.
 *
 * The empty fixture creates the tables and writes no value; every row is then deleted, because this D1 is
 * the one every case in this file seeds into and a leftover row would make "nothing provisioned" resolve
 * whichever secret ran last. Planted and watched: without the delete, the always-block secret from the case
 * above answers here, and the unprovisioned case reads as a failed challenge instead of a refusal.
 */
async function postUnprovisioned(body: URLSearchParams, deployment: Deployment = {}): Promise<Response> {
  await seedSecrets(env, turnstileSecretsRegistry, {});
  await createDatabase(env.SECRETS, secretsTables).deleteFrom("pithySecretsSystemSecrets").execute();
  return send(body, deployment);
}

/** The guarded route and the request, shared by the provisioned and unprovisioned harnesses. */
async function send(body: URLSearchParams, deployment: Deployment): Promise<Response> {
  const app = new Hono();
  app.onError(pithyErrorHandler);
  app.use("/login", turnstile({ action: deployment.action }));
  app.post("/login", (c) => c.json({ ok: true }));
  const environment = "environment" in deployment ? deployment.environment : "dev";
  return app.request(
    "/login",
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
    { ...env, ...(environment === undefined ? {} : { ENVIRONMENT: environment }) },
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

/**
 * The composed gate — `turnstile({ action: "login" })`, exactly as `@pithy-sh/auth` stacks it — against
 * live siteverify (#374).
 *
 * The always-pass test secret answers `success: true` with **no `action` field**, so before this the
 * action binding refused every dev and staging sign-in. Each case below is one condition of the
 * exception, run against Cloudflare rather than a stub, because the stub was where the two disagreed.
 */
describe("turnstile({ action }) with a documented test key (Workers runtime)", () => {
  test("dev signs in: the test key passes the composed gate", async () => {
    const res = await post(SECRETS.pass, withToken(), { action: "login", environment: "dev" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("staging too", async () => {
    const res = await post(SECRETS.pass, withToken(), { action: "login", environment: "staging" });
    expect(res.status).toBe(200);
  });

  test("prod refuses it, and blames the deployment rather than the caller", async () => {
    const res = await post(SECRETS.pass, withToken(), { action: "login", environment: "prod" });
    expect(res.status).toBe(500);
    expect(await errCode(res)).toBe("turnstile/config");
  });

  test("an unstamped Worker is refused too — it cannot claim to be dev", async () => {
    const res = await post(SECRETS.pass, withToken(), { action: "login", environment: undefined });
    expect(res.status).toBe(500);
    expect(await errCode(res)).toBe("turnstile/config");
  });

  test("the always-block key still denies in dev, and as a failed challenge", async () => {
    // The exception is about the action a test key omits, never about the verdict it returns. A gate
    // that opened for anything flagged as a test key would satisfy the first case above and this one
    // would catch it.
    const res = await post(SECRETS.fail, withToken(), { action: "login", environment: "dev" });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("turnstile/failed");
  });
});

/**
 * **A feature deployment signs in with nothing provisioned for it (#656), against live siteverify.**
 *
 * This is the case a stub cannot make: the gate defaults a feature to a secret string, and only Cloudflare
 * can say whether that string is the always-pass test secret it documents. A wrong one comes back as HTTP
 * 400 `invalid-input-secret`, which the gate renders `turnstile/config` — the very refusal the branch
 * deployment answered before this. A right one comes back `success: true` with the test-key flag set and no
 * `action`, and the composed login gate has to accept exactly that answer here, as it does in dev.
 */
describe("a feature deployment with nothing provisioned (Workers runtime)", () => {
  test("the secret it defaults to is Cloudflare's, and the composed login gate passes", async () => {
    const res = await postUnprovisioned(withToken(), { action: "login", environment: "feature" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("dev with nothing provisioned still refuses — the default belongs to a feature alone", async () => {
    const res = await postUnprovisioned(withToken(), { action: "login", environment: "dev" });
    expect(res.status).toBe(500);
    expect(await errCode(res)).toBe("turnstile/config");
  });
});

describe("a secret Cloudflare does not recognize (Workers runtime)", () => {
  test("is reported as a misconfiguration, from the real 400", async () => {
    // Live, because the whole finding is that siteverify answers HTTP 400 here rather than a 200 with
    // a verdict — which is what used to render a wrong secret as a user failing a challenge.
    const res = await post(SECRETS.unknown, withToken(), { environment: "dev" });
    expect(res.status).toBe(500);
    expect(await errCode(res)).toBe("turnstile/config");
  });
});
