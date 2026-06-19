import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { TURNSTILE_SECRET_NAME } from "../secret/registry";
import { turnstile } from "./middleware";

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

/** A public POST route guarded by `turnstile()`, with the given secret bound. */
function gatedApp(secret: string) {
  const app = new Hono();
  app.onError(pithyErrorHandler);
  app.use("/login", turnstile());
  app.post("/login", (c) => c.json({ ok: true }));
  return (token = "XXXX.DUMMY.TOKEN.XXXX") =>
    app.request(
      "/login",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ "cf-turnstile-response": token }),
      },
      { [TURNSTILE_SECRET_NAME]: JSON.stringify({ visible: { key: secret } }) },
    );
}

/** The `code` from a `{ error: <public payload> }` response body. */
async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("turnstile() against live siteverify (Workers runtime)", () => {
  test("always-pass secret lets the request through", async () => {
    const res = await gatedApp(SECRETS.pass)();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("always-block secret denies with turnstile/failed", async () => {
    const res = await gatedApp(SECRETS.fail)();
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("turnstile/failed");
  });

  test("token-already-spent secret denies with turnstile/failed", async () => {
    const res = await gatedApp(SECRETS.spent)();
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("turnstile/failed");
  });

  test("a missing token is rejected before any network call", async () => {
    const app = new Hono();
    app.onError(pithyErrorHandler);
    app.use("/login", turnstile());
    app.post("/login", (c) => c.json({ ok: true }));
    const res = await app.request(
      "/login",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams() },
      { [TURNSTILE_SECRET_NAME]: JSON.stringify({ visible: { key: SECRETS.pass } }) },
    );
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("turnstile/missing_token");
  });
});
