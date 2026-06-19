import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import type { Hono } from "hono";
import { resolveSigningKeys } from "../crypto/signingKey";
import { type CallbackToken, type TokenKind, verifyToken } from "../crypto/token";
import {
  type EmailDatabase,
  type EmailSuppressionDatabase,
  emailDatabase,
  emailSuppressionDatabase,
} from "../data/tables";
import { EmailInvalidTokenError } from "../error/errors";
import { recordEvent } from "../send/events";
import { normalizeEmail, suppress } from "../send/suppression";
import { CALLBACK_BASE } from "../templates/engine";

/**
 * The callback routes — click, open, and unsubscribe. Every link in a tracked email points here with
 * an HMAC-signed token (see `crypto/token`). The routes are **public + signed-token**: they take no
 * session, and the token's signature is the only gate. A forged, altered, or expired token is rejected
 * (`email/invalid_token` → 400) before anything is recorded. The click route only ever 302-redirects to
 * an `http(s)` destination carried inside the signed token, so it cannot be turned into an open redirect.
 *
 * The per-request handlers take the signing-key version set directly so they are unit-testable without
 * standing up the secrets store; `registerCallbacks` is the thin shell that resolves the keys from the
 * worker env (via `@pithy-sh/secrets`) and the database from the `DB` binding.
 */

/** The env the callbacks read: the app + shared suppression databases plus the secrets bindings for the signing key. */
type CallbackEnv = SecretsStoreEnv & { DB: D1Database; EMAIL_SUPPRESSIONS: D1Database; ENVIRONMENT?: string };

/** The signing-key version set a handler verifies against. */
export interface SigningKeys {
  versions: Record<string, string>;
}

/** A 1×1 transparent PNG — the open-tracking pixel body. */
const PIXEL = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/** Verify a token and assert its kind, or throw `email/invalid_token`. */
async function verify(keys: SigningKeys, token: string, expected: TokenKind, now: Date): Promise<CallbackToken> {
  const claims = await verifyToken(token, keys, now);
  if (claims.kind !== expected) {
    throw new EmailInvalidTokenError({ detail: `token kind '${claims.kind}' does not match callback '${expected}'` });
  }
  return claims;
}

/** Handle a click: record it, then 302-redirect to the signed http(s) destination. */
export async function handleClick(db: EmailDatabase, keys: SigningKeys, token: string, now: Date): Promise<Response> {
  const claims = await verify(keys, token, "click", now);
  const destination = claims.destination ?? "";
  if (!/^https?:\/\//i.test(destination)) {
    throw new EmailInvalidTokenError({ detail: "click token has no http(s) destination" });
  }
  await recordEvent(
    db,
    {
      jobId: claims.jobId,
      recipient: normalizeEmail(claims.recipient),
      type: "click",
      linkLabel: claims.linkLabel ?? null,
      linkUrl: destination,
      campaignId: claims.campaignId ?? null,
    },
    now,
  );
  return new Response(null, { status: 302, headers: { location: destination } });
}

/** Handle an open: record it, return the 1×1 pixel. */
export async function handleOpen(db: EmailDatabase, keys: SigningKeys, token: string, now: Date): Promise<Response> {
  const claims = await verify(keys, token.replace(/\.png$/i, ""), "open", now);
  await recordEvent(
    db,
    {
      jobId: claims.jobId,
      recipient: normalizeEmail(claims.recipient),
      type: "open",
      campaignId: claims.campaignId ?? null,
    },
    now,
  );
  return new Response(PIXEL, {
    status: 200,
    headers: { "content-type": "image/png", "cache-control": "no-store, max-age=0" },
  });
}

/**
 * Handle an unsubscribe: suppress the address (shared DB), record the opt-out event (app DB), confirm.
 * An optional `reason` — supplied by the app's own unsubscribe/preferences flow via the `?reason=` query
 * param — is stored on the suppression `detail` and the event, so a project can capture *why* someone
 * opted out using its own logic. It is length-bounded so the link can't be used to stuff the column.
 */
export async function handleUnsubscribe(
  db: EmailDatabase,
  suppressionDb: EmailSuppressionDatabase,
  keys: SigningKeys,
  token: string,
  now: Date,
  reason?: string,
  environment?: string,
): Promise<Response> {
  const claims = await verify(keys, token, "unsubscribe", now);
  const recipient = normalizeEmail(claims.recipient);
  const detail = reason ? reason.slice(0, 200) : "unsubscribe link";
  await suppress(
    suppressionDb,
    { email: recipient, reason: "unsubscribe", jobId: claims.jobId, environment, detail },
    now,
  );
  await recordEvent(
    db,
    { jobId: claims.jobId, recipient, type: "unsubscribe", campaignId: claims.campaignId ?? null, detail },
    now,
  );
  return new Response("<p>You've been unsubscribed. You won't receive marketing email from us again.</p>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Mount the click/open/unsubscribe callback routes under `${CALLBACK_BASE}` on the app's Hono router. */
export function registerCallbacks(app: Hono<PithyHonoEnv>): void {
  const setup = async (
    env: CallbackEnv,
  ): Promise<{ db: EmailDatabase; suppressionDb: EmailSuppressionDatabase; keys: SigningKeys }> => {
    const keys = await resolveSigningKeys(env);
    return {
      db: emailDatabase(env.DB),
      suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      keys: { versions: keys.versions },
    };
  };

  app.get(`${CALLBACK_BASE}/c/:token`, async (c) => {
    const { db, keys } = await setup(c.env as unknown as CallbackEnv);
    return handleClick(db, keys, c.req.param("token"), new Date());
  });

  app.get(`${CALLBACK_BASE}/o/:token`, async (c) => {
    const { db, keys } = await setup(c.env as unknown as CallbackEnv);
    return handleOpen(db, keys, c.req.param("token"), new Date());
  });

  app.get(`${CALLBACK_BASE}/u/:token`, async (c) => {
    const env = c.env as unknown as CallbackEnv;
    const { db, suppressionDb, keys } = await setup(env);
    return handleUnsubscribe(
      db,
      suppressionDb,
      keys,
      c.req.param("token"),
      new Date(),
      c.req.query("reason"),
      env.ENVIRONMENT,
    );
  });
}
