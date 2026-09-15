// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { encodeVersionedValue, type VersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { storeEntryText } from "@pithy-sh/secrets/src/store/entryText";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EMAIL_LINK_SIGNING_KEY, emailSigningRegistry } from "../crypto/signingKey";
import { mintToken, type TokenClaims } from "../crypto/token";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { CALLBACK_BASE } from "../templates/engine";
import {
  type CallbackRequest,
  handleClick,
  handleOpen,
  handleUnsubscribe,
  registerCallbacks,
  type SigningKeys,
} from "./callbacks";

const KEY = "callback-signing-key";
const keys: SigningKeys = { versions: { "1": KEY } };
const now = new Date("2026-06-18T12:00:00.000Z");
const expiresAt = new Date("2026-12-18T12:00:00.000Z");
/** The origin the direct-handler cases mint for and present at. */
const ORIGIN = "https://api.acme.test";

function token(claims: TokenClaims): Promise<string> {
  return mintToken(claims, { key: KEY, kid: "1", expiresAt, audience: ORIGIN });
}

/** A token as it arrives on this origin's callback route. */
function at(token: string): CallbackRequest {
  return { token, url: `${ORIGIN}${CALLBACK_BASE}/x/${token}` };
}

async function eventsFor(jobId: string): Promise<{ type: string; recipient: string; link_url: string | null }[]> {
  const rows = await env.DB.prepare(
    "select type, recipient, link_url from pithy_email_events where job_id = ? order by id",
  )
    .bind(jobId)
    .all<{ type: string; recipient: string; link_url: string | null }>();
  return rows.results;
}

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
  // The registered routes resolve the signing key through the shared per-invocation accessor, so
  // configure it from email's own slice before each case (and reset after). The key itself is the
  // Secrets Store entry each route's env binds — see `callbackApp`.
  configureSharedSecrets({ registry: emailSigningRegistry });
});

afterEach(() => resetSharedSecrets());

describe("click callback", () => {
  test("records the click and 302-redirects to the signed destination", async () => {
    const t = await token({
      kind: "click",
      jobId: "job-1",
      recipient: "U@Example.com",
      destination: "https://acme.test/welcome",
      linkLabel: "cta",
      campaignId: "spring",
    });
    const res = await handleClick(emailDatabase(env.DB), keys, at(t), now);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://acme.test/welcome");
    expect(await eventsFor("job-1")).toEqual([
      { type: "click", recipient: "u@example.com", link_url: "https://acme.test/welcome" },
    ]);
  });

  test("rejects a forged token before recording anything", async () => {
    const t = await token({
      kind: "click",
      jobId: "job-2",
      recipient: "u@example.com",
      destination: "https://acme.test/x",
    });
    const forged = `${t}tamper`;
    await expect(handleClick(emailDatabase(env.DB), keys, at(forged), now)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
    expect(await eventsFor("job-2")).toEqual([]);
  });

  test("refuses a non-http destination (no open redirect)", async () => {
    const t = await token({
      kind: "click",
      jobId: "job-3",
      recipient: "u@example.com",
      destination: "javascript:alert(1)",
    });
    await expect(handleClick(emailDatabase(env.DB), keys, at(t), now)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
  });

  test("rejects a token minted for a different callback kind", async () => {
    const t = await token({ kind: "open", jobId: "job-4", recipient: "u@example.com" });
    await expect(handleClick(emailDatabase(env.DB), keys, at(t), now)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
  });
});

describe("open callback", () => {
  test("records the open and returns a PNG pixel, tolerating the .png suffix", async () => {
    const t = await token({ kind: "open", jobId: "job-5", recipient: "u@example.com", campaignId: "spring" });
    const res = await handleOpen(emailDatabase(env.DB), keys, at(`${t}.png`), now);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await eventsFor("job-5"))[0]).toMatchObject({ type: "open", recipient: "u@example.com" });
  });
});

describe("unsubscribe callback", () => {
  test("suppresses the address, records the opt-out, and confirms", async () => {
    const t = await token({ kind: "unsubscribe", jobId: "job-6", recipient: "Bye@Example.com", campaignId: "spring" });
    const res = await handleUnsubscribe(
      emailDatabase(env.DB),
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      keys,
      at(t),
      now,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("unsubscribed");
    const sup = await env.EMAIL_SUPPRESSIONS.prepare("select reason from pithy_email_suppressions where email = ?")
      .bind("bye@example.com")
      .first<{ reason: string }>();
    expect(sup?.reason).toBe("unsubscribe");
    expect((await eventsFor("job-6"))[0]).toMatchObject({ type: "unsubscribe", recipient: "bye@example.com" });
  });

  test("stores a caller-supplied reason on the suppression detail", async () => {
    const t = await token({ kind: "unsubscribe", jobId: "job-r", recipient: "r@example.com" });
    await handleUnsubscribe(
      emailDatabase(env.DB),
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      keys,
      at(t),
      now,
      "too_many_emails",
    );

    const sup = await env.EMAIL_SUPPRESSIONS.prepare("select detail from pithy_email_suppressions where email = ?")
      .bind("r@example.com")
      .first<{ detail: string }>();
    expect(sup?.detail).toBe("too_many_emails");
  });

  test("an expired token is rejected and suppresses nothing", async () => {
    const t = await token({ kind: "unsubscribe", jobId: "job-7", recipient: "u@example.com" });
    const afterExpiry = new Date("2027-01-01T00:00:00.000Z");
    await expect(
      handleUnsubscribe(
        emailDatabase(env.DB),
        emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
        keys,
        at(t),
        afterExpiry,
      ),
    ).rejects.toMatchObject({ payload: { code: "email/invalid_token" } });
    const count = await env.EMAIL_SUPPRESSIONS.prepare("select count(*) as n from pithy_email_suppressions").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });
});

/** A token valid against the wall clock — the registered routes verify against a real `new Date()`. */
function liveToken(claims: TokenClaims, audience = "http://localhost"): Promise<string> {
  // `app.request` resolves a bare path against `http://localhost`, so that is the origin a route sees.
  return mintToken(claims, { key: KEY, kid: "1", expiresAt: new Date(Date.now() + 86_400_000), audience });
}

/**
 * The three routes as `registerCallbacks` mounts them — the app-level peer of the direct-handler cases
 * above, so the `zValidator("param" | "query", …, validationHook)` declarations on the route line are
 * actually exercised. The signing key resolves through the shared secrets accessor from the binding a
 * deployed Worker gets from its `secrets_store_secrets` stanza: the entry's text, exactly as provisioning
 * writes it (`storeEntryText`) — a fresh envelope, so its one version is `"1"`, the `kid` `liveToken()`
 * mints with. A case that wants another version set passes the envelope it wants the entry to hold.
 *
 * There is no `SECRETS` database here and no master key, and that is the assertion (#596): the key lives
 * outside every D1, so nothing a migration, a reset or a teardown does to one can reach it.
 */
function callbackApp(
  entry: VersionedValue | undefined = undefined,
): (path: string, init?: RequestInit) => Promise<Response> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  registerCallbacks(app);
  return async (path, init = {}) =>
    app.request(path, init, {
      DB: env.DB,
      EMAIL_SUPPRESSIONS: env.EMAIL_SUPPRESSIONS,
      [EMAIL_LINK_SIGNING_KEY]: entry ? encodeVersionedValue(entry) : storeEntryText({}, KEY),
    });
}

/** The `code` from a `{ error: <public payload> }` response body. */
async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("registered callback routes", () => {
  test("the click route verifies the token and redirects", async () => {
    const t = await liveToken({
      kind: "click",
      jobId: "job-route-c",
      recipient: "u@example.com",
      destination: "https://acme.test/welcome",
    });
    const res = await callbackApp()(`${CALLBACK_BASE}/c/${t}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://acme.test/welcome");
    expect((await eventsFor("job-route-c"))[0]).toMatchObject({ type: "click" });
  });

  test("the open route still reaches the handler with the .png suffix", async () => {
    const t = await liveToken({ kind: "open", jobId: "job-route-o", recipient: "u@example.com" });
    const res = await callbackApp()(`${CALLBACK_BASE}/o/${t}.png`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await eventsFor("job-route-o"))[0]).toMatchObject({ type: "open", recipient: "u@example.com" });
  });

  test("the unsubscribe route passes ?reason= through and still truncates it", async () => {
    const t = await liveToken({ kind: "unsubscribe", jobId: "job-route-u", recipient: "bye@example.com" });
    const res = await callbackApp()(`${CALLBACK_BASE}/u/${t}?reason=${"why".repeat(100)}`);

    expect(res.status).toBe(200);
    const sup = await env.EMAIL_SUPPRESSIONS.prepare("select detail from pithy_email_suppressions where email = ?")
      .bind("bye@example.com")
      .first<{ detail: string }>();
    expect(sup?.detail).toHaveLength(200);
  });

  test("the unsubscribe route answers a one-click POST, with no human ever loading a page", async () => {
    // Elective mail carries `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, so the mail client
    // posts to this URL itself. Advertising that header against a GET-only route would be promising an
    // opt-out that silently does nothing — the failure mode this whole change is about, inverted.
    const t = await liveToken({ kind: "unsubscribe", jobId: "job-route-p", recipient: "click@example.com" });
    const res = await callbackApp()(`${CALLBACK_BASE}/u/${t}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });

    expect(res.status).toBe(200);
    const sup = await env.EMAIL_SUPPRESSIONS.prepare("select reason from pithy_email_suppressions where email = ?")
      .bind("click@example.com")
      .first<{ reason: string }>();
    expect(sup?.reason).toBe("unsubscribe");
    expect((await eventsFor("job-route-p"))[0]).toMatchObject({ type: "unsubscribe" });
  });

  test("a client that posts twice is not an error — the write is an upsert", async () => {
    const t = await liveToken({ kind: "unsubscribe", jobId: "job-route-t", recipient: "twice@example.com" });
    const app = callbackApp();
    const post = { method: "POST" };

    expect((await app(`${CALLBACK_BASE}/u/${t}`, post)).status).toBe(200);
    expect((await app(`${CALLBACK_BASE}/u/${t}`, post)).status).toBe(200);

    const count = await env.EMAIL_SUPPRESSIONS.prepare(
      "select count(*) as n from pithy_email_suppressions where email = ?",
    )
      .bind("twice@example.com")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  test("after a rotation, a link minted under the previous version still verifies", async () => {
    // The entry holds both versions, current `2` — what a rotation that retains the prior key leaves
    // behind. A link already in an inbox carries `kid: "1"`, and must keep working until `1` is pruned.
    const rotated = callbackApp({ currentVersion: "2", versions: { "1": KEY, "2": "the-key-after-rotation" } });
    const before = await liveToken({
      kind: "click",
      jobId: "job-route-r",
      recipient: "u@example.com",
      destination: "https://acme.test/welcome",
    });
    expect((await rotated(`${CALLBACK_BASE}/c/${before}`)).status).toBe(302);

    // And pruned, it stops: the version set is the whole of what verifies. The shared accessor caches a
    // resolution for its TTL, as it does in a Worker, so the prune is read the way a new isolate reads it.
    resetSharedSecrets();
    configureSharedSecrets({ registry: emailSigningRegistry });
    const pruned = callbackApp({ currentVersion: "2", versions: { "2": "the-key-after-rotation" } });
    const res = await pruned(`${CALLBACK_BASE}/c/${before}`);
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("email/invalid_token");
  });

  test("a token minted for another origin is refused at every route, under the very key that signed it", async () => {
    // One key across two environments is a misconfiguration, and this is what it must not be able to do:
    // a staging link acting on production's routes — the unsubscribe among them, which writes into the
    // suppression list both environments bind.
    const app = callbackApp();
    const staging = "https://staging.acme.test";
    const click = await liveToken(
      { kind: "click", jobId: "job-route-x", recipient: "u@example.com", destination: "https://acme.test/welcome" },
      staging,
    );
    const open = await liveToken({ kind: "open", jobId: "job-route-x", recipient: "u@example.com" }, staging);
    const unsubscribe = await liveToken(
      { kind: "unsubscribe", jobId: "job-route-x", recipient: "cross@example.com" },
      staging,
    );

    for (const [path, init] of [
      [`${CALLBACK_BASE}/c/${click}`, {}],
      [`${CALLBACK_BASE}/o/${open}.png`, {}],
      [`${CALLBACK_BASE}/u/${unsubscribe}`, {}],
      [`${CALLBACK_BASE}/u/${unsubscribe}`, { method: "POST" }],
    ] as const) {
      const res = await app(path, init);
      expect(res.status).toBe(400);
      expect(await errCode(res)).toBe("email/invalid_token");
    }
    expect(await eventsFor("job-route-x")).toEqual([]);
    const count = await env.EMAIL_SUPPRESSIONS.prepare("select count(*) as n from pithy_email_suppressions").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  test("an over-long token is rejected as validation/invalid_input", async () => {
    const res = await callbackApp()(`${CALLBACK_BASE}/c/${"a".repeat(5000)}`);

    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("validation/invalid_input");
  });

  test("an over-long ?reason= is rejected as validation/invalid_input", async () => {
    const t = await liveToken({ kind: "unsubscribe", jobId: "job-route-q", recipient: "u@example.com" });
    const res = await callbackApp()(`${CALLBACK_BASE}/u/${t}?reason=${"x".repeat(2001)}`);

    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("validation/invalid_input");
    // Nothing was suppressed: the validator answered before the handler ran.
    const count = await env.EMAIL_SUPPRESSIONS.prepare("select count(*) as n from pithy_email_suppressions").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  test("a repeated ?reason= is now ambiguous and rejected", async () => {
    // Hono hands a repeated query key to the validator as an array, so the schema refuses it. Before
    // the validator, `c.req.query("reason")` silently took the first value; ambiguous input is now a 400.
    const t = await liveToken({ kind: "unsubscribe", jobId: "job-route-d", recipient: "u@example.com" });
    const res = await callbackApp()(`${CALLBACK_BASE}/u/${t}?reason=a&reason=b`);

    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("validation/invalid_input");
  });

  test("a malformed token is the validator's error, not the verifier's", async () => {
    // Status is unchanged (both are 400), but the code now comes from the route-line validator: the
    // param never reaches `verifyToken`, so it is `validation/invalid_input`, not `email/invalid_token`.
    const res = await callbackApp()(`${CALLBACK_BASE}/o/not a token`);

    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("validation/invalid_input");
  });
});
