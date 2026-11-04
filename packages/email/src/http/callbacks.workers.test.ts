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
import { emailSigningRegistry } from "../crypto/signingKey";
import { mintToken, type TokenClaims, tokenAudience } from "../crypto/token";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { CALLBACK_BASE } from "../templates/engine";
import {
  type CallbackRequest,
  handleClick,
  handleOpen,
  handleUnsubscribe,
  handleUnsubscribePage,
  registerCallbacks,
  type SigningKeys,
} from "./callbacks";

/**
 * A token in the signed `<payload>.<signature>` format, built the way mail already in inboxes carries it.
 *
 * Only tests build one: `mintToken` seals, and the verifier reads this format until the last such link expires. The
 * payload is plain base64url JSON, recipient included, which is exactly why nothing mints it any more.
 */
async function signedToken(
  claims: TokenClaims,
  options: { key: string; kid: string; expiresAt: Date; audience: string; v?: number },
): Promise<string> {
  const encode = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const payload = encode(
    new TextEncoder().encode(
      JSON.stringify({
        ...claims,
        v: options.v ?? 2,
        kid: options.kid,
        ...(options.v === 1 ? {} : { aud: tokenAudience(options.audience) }),
        exp: Math.floor(options.expiresAt.getTime() / 1000),
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${encode(signature)}`;
}

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

  test("the page handler verifies the token and records nothing", async () => {
    const t = await token({ kind: "unsubscribe", jobId: "job-page", recipient: "page@example.com" });
    const res = await handleUnsubscribePage(keys, at(t), now);
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await eventsFor("job-page")).toEqual([]);
    const click = await token({ kind: "click", jobId: "job-page", recipient: "page@example.com" });
    await expect(handleUnsubscribePage(keys, at(click), now)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
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
 * above, so the `validate("param" | "form", …)` declarations on the route line are
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
      // The binding `pithy secrets provision` writes (#603) — spelled out rather than derived, so this states
      // what a deployed Worker is handed instead of agreeing with whatever the derivation says.
      EMAIL_LINK_SIGNING_KEY: entry ? encodeVersionedValue(entry) : storeEntryText({}, KEY),
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

  test("the unsubscribe GET renders a page that posts back, and suppresses nothing", async () => {
    // A mail scanner or a link preview fetches the link on its own. That fetch must not opt anyone out.
    const t = await liveToken({ kind: "unsubscribe", jobId: "job-route-g", recipient: "look@example.com" });
    const res = await callbackApp()(`${CALLBACK_BASE}/u/${t}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const page = await res.text();
    expect(page).toContain('<form method="post">');
    expect(page).not.toContain("look@example.com");
    expect(await eventsFor("job-route-g")).toEqual([]);
    const count = await env.EMAIL_SUPPRESSIONS.prepare("select count(*) as n from pithy_email_suppressions").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  test("the unsubscribe POST takes a reason from its form body, and still truncates it", async () => {
    const t = await liveToken({ kind: "unsubscribe", jobId: "job-route-u", recipient: "bye@example.com" });
    const res = await callbackApp()(`${CALLBACK_BASE}/u/${t}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ reason: "why".repeat(100) }).toString(),
    });

    expect(res.status).toBe(200);
    const sup = await env.EMAIL_SUPPRESSIONS.prepare("select detail from pithy_email_suppressions where email = ?")
      .bind("bye@example.com")
      .first<{ detail: string }>();
    expect(sup?.detail).toHaveLength(200);
  });

  test("a ?reason= on the link is never read: the opt-out still lands, without it", async () => {
    // An app that still appends the reason to the URL keeps opting people out; the words it put in the query are
    // not stored, so nothing downstream comes to rely on a value every request log has already recorded.
    const t = await liveToken({ kind: "unsubscribe", jobId: "job-route-q", recipient: "query@example.com" });
    const res = await callbackApp()(`${CALLBACK_BASE}/u/${t}?reason=${"x".repeat(3000)}`, { method: "POST" });

    expect(res.status).toBe(200);
    const sup = await env.EMAIL_SUPPRESSIONS.prepare("select detail from pithy_email_suppressions where email = ?")
      .bind("query@example.com")
      .first<{ detail: string }>();
    expect(sup?.detail).toBe("unsubscribe link");
  });

  test("a link already in an inbox, in the signed format, still works on every route until it expires", async () => {
    const app = callbackApp();
    const expiry = new Date(Date.now() + 86_400_000);
    const options = { key: KEY, kid: "1", expiresAt: expiry, audience: "http://localhost" };
    const click = await signedToken(
      { kind: "click", jobId: "job-route-old", recipient: "old@example.com", destination: "https://acme.test/welcome" },
      options,
    );
    const open = await signedToken({ kind: "open", jobId: "job-route-old", recipient: "old@example.com" }, options);
    const unsubscribe = await signedToken(
      { kind: "unsubscribe", jobId: "job-route-old", recipient: "old@example.com" },
      options,
    );

    expect((await app(`${CALLBACK_BASE}/c/${click}`)).status).toBe(302);
    expect((await app(`${CALLBACK_BASE}/o/${open}.png`)).status).toBe(200);
    expect((await app(`${CALLBACK_BASE}/u/${unsubscribe}`)).status).toBe(200);
    expect((await app(`${CALLBACK_BASE}/u/${unsubscribe}`, { method: "POST" })).status).toBe(200);
    expect((await eventsFor("job-route-old")).map((event) => event.type)).toEqual(["click", "open", "unsubscribe"]);

    const expired = await signedToken(
      { kind: "unsubscribe", jobId: "job-route-old", recipient: "old@example.com" },
      { ...options, expiresAt: new Date(Date.now() - 1000) },
    );
    const res = await app(`${CALLBACK_BASE}/u/${expired}`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("email/invalid_token");
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

  test("no body can refuse the opt-out: malformed, repeated, over-long or mistyped, it still lands", async () => {
    const app = callbackApp();
    const cases: [string, RequestInit][] = [
      [
        "malformed@example.com",
        { headers: { "content-type": "multipart/form-data; boundary=zzz" }, body: "--zzz\r\nbroken" },
      ],
      [
        "repeated@example.com",
        {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "reason=a&reason=b&List-Unsubscribe=One-Click&List-Unsubscribe=One-Click",
        },
      ],
      [
        "long@example.com",
        {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ reason: "x".repeat(5000) }).toString(),
        },
      ],
      ["json@example.com", { headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: 7 }) }],
    ];
    for (const [address, init] of cases) {
      const t = await liveToken({ kind: "unsubscribe", jobId: `job-body-${address}`, recipient: address });
      const res = await app(`${CALLBACK_BASE}/u/${t}`, { method: "POST", ...init });
      expect(res.status, address).toBe(200);
      const sup = await env.EMAIL_SUPPRESSIONS.prepare("select detail from pithy_email_suppressions where email = ?")
        .bind(address)
        .first<{ detail: string }>();
      expect(sup?.detail, address).toBe(
        address === "repeated@example.com"
          ? "a"
          : address === "long@example.com"
            ? "x".repeat(200)
            : "unsubscribe link",
      );
    }
  });

  test("a malformed token is the validator's error, not the verifier's", async () => {
    // Status is unchanged (both are 400), but the code now comes from the route-line validator: the
    // param never reaches `verifyToken`, so it is `validation/invalid_input`, not `email/invalid_token`.
    const res = await callbackApp()(`${CALLBACK_BASE}/o/not a token`);

    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("validation/invalid_input");
  });
});
