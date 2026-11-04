// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import type { Hono, MiddlewareHandler } from "hono";
import { resolveSigningKeys } from "../crypto/signingKey";
import { type TokenKind, type VerifiedCallbackToken, verifyToken } from "../crypto/token";
import {
  type EmailDatabase,
  type EmailSuppressionDatabase,
  emailDatabase,
  emailSuppressionDatabase,
} from "../data/tables";
import { EmailInvalidTokenError } from "../error/errors";
import { recordEvent } from "../send/events";
import { suppress } from "../send/suppression";
import { CALLBACK_BASE } from "../templates/engine";
import { CallbackTokenParam, UnsubscribeForm } from "./schemas";

/**
 * The callback routes — click, open, and unsubscribe. Every link in a tracked email points here with
 * a sealed token (see `crypto/token`) that decodes to nothing, so the URL a request log records names no one.
 * The routes are **public + sealed token**: they take no session, and the token's seal is the only gate. A forged,
 * altered, or expired token is rejected (`email/invalid_token` → 400) before anything is recorded. The click route
 * only ever 302-redirects to an `http(s)` destination carried inside the token, so it cannot be turned into an open
 * redirect.
 *
 * | Method | Path                          | Strategy      | Validates |
 * |--------|-------------------------------|---------------|-----------|
 * | GET    | /_pithy/email/c/:token        | sealed token  | param `CallbackTokenParam` |
 * | GET    | /_pithy/email/o/:token        | sealed token  | param `CallbackTokenParam` |
 * | GET    | /_pithy/email/u/:token        | sealed token  | param `CallbackTokenParam` |
 * | POST   | /_pithy/email/u/:token        | sealed token  | param `CallbackTokenParam`, form `UnsubscribeForm` |
 *
 * **The unsubscribe GET changes nothing.** It renders a page whose one button posts back to the same URL, because
 * a GET is what a mail scanner or a link preview fetches on its own, and an opt-out nobody asked for is still an
 * opt-out. The POST does the work, and it is what elective mail's `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 * (RFC 8058) has a mail client send, with no human loading the page. The write is an upsert, so a client that
 * retries costs nothing.
 *
 * **No route reads a query string.** The one value a caller supplies, the recipient's `reason`, is in the POST's
 * form body, since a query string is written to every request log on the way. A `?reason=` on a link is never read.
 *
 * The validators bound shape and size only — the seal check stays in the handler, so a well-formed token that is
 * forged or expired is still `email/invalid_token` (400), not `validation/invalid_input`.
 *
 * Every token names the origin it was minted for, and a handler refuses one presented anywhere else — see
 * `crypto/token`'s `aud`. That is what keeps a key misconfigured as shared from letting a staging link act
 * on production's routes.
 *
 * The per-request handlers take the signing-key version set directly so they are unit-testable without
 * standing up the secrets store; `registerCallbacks` is the thin shell that resolves the keys from the
 * worker env (via `@pithy-sh/secrets`) and the database from the `DB` binding.
 */

/** The env the callbacks read: the app + shared suppression databases plus the secrets bindings for the signing key. */
type CallbackEnv = SecretsStoreEnv & { DB: D1Database; EMAIL_SUPPRESSIONS: D1Database };

/** The signing-key version set a handler verifies against. */
export interface SigningKeys {
  versions: Record<string, string>;
}

/** A 1×1 transparent PNG — the open-tracking pixel body. */
const PIXEL = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/**
 * Where a token was presented: the URL of the request carrying it. The token's `aud` has to name this
 * origin, so a link minted by one environment cannot act on another's routes even under a shared key.
 *
 * The request's own URL rather than `email({ baseUrl })`: that config value is one string composed for
 * whichever environment the config was loaded under, while the request is, by construction, at the origin
 * this Worker is serving.
 */
export interface CallbackRequest {
  /** The raw callback token from the path. */
  token: string;
  /** The URL the request arrived on. Only its origin is compared. */
  url: string;
}

/** Verify a token and assert its kind, or throw `email/invalid_token`. */
async function verify(
  keys: SigningKeys,
  request: CallbackRequest,
  expected: TokenKind,
  now: Date,
): Promise<VerifiedCallbackToken> {
  const claims = await verifyToken(request.token, keys, now, request.url);
  if (claims.kind !== expected) {
    throw new EmailInvalidTokenError({ detail: `token kind '${claims.kind}' does not match callback '${expected}'` });
  }
  return claims;
}

/** Handle a click: record it, then 302-redirect to the sealed http(s) destination. */
export async function handleClick(
  db: EmailDatabase,
  keys: SigningKeys,
  request: CallbackRequest,
  now: Date,
): Promise<Response> {
  const claims = await verify(keys, request, "click", now);
  const destination = claims.destination ?? "";
  if (!/^https?:\/\//i.test(destination)) {
    throw new EmailInvalidTokenError({ detail: "click token has no http(s) destination" });
  }
  await recordEvent(
    db,
    {
      jobId: claims.jobId,
      recipient: normalizeAddress(claims.recipient),
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
export async function handleOpen(
  db: EmailDatabase,
  keys: SigningKeys,
  request: CallbackRequest,
  now: Date,
): Promise<Response> {
  const claims = await verify(keys, { ...request, token: request.token.replace(/\.png$/i, "") }, "open", now);
  await recordEvent(
    db,
    {
      jobId: claims.jobId,
      recipient: normalizeAddress(claims.recipient),
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

/** The unsubscribe confirmation page. One button, posting back to this URL; nothing in it names the recipient. */
const UNSUBSCRIBE_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;line-height:1.55"><p>Unsubscribe from everything but the mail you ask for? A sign-in link or a security notice still arrives.</p><form method="post"><button type="submit">Unsubscribe</button></form></body></html>';

/**
 * Render the unsubscribe page for a valid token, recording nothing. A forged, expired or misdirected token is refused
 * here exactly as the POST would refuse it, so the page never offers a button that cannot work.
 */
export async function handleUnsubscribePage(keys: SigningKeys, request: CallbackRequest, now: Date): Promise<Response> {
  await verify(keys, request, "unsubscribe", now);
  return new Response(UNSUBSCRIBE_PAGE, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

/**
 * Handle an unsubscribe: suppress the address (shared DB), record the opt-out event (app DB), confirm.
 * An optional `reason` — supplied by the app's own unsubscribe/preferences flow in the POST's form body —
 * is stored on the suppression `detail` and the event, so a project can capture *why* someone
 * opted out using its own logic. It is length-bounded so the link can't be used to stuff the column.
 */
export async function handleUnsubscribe(
  db: EmailDatabase,
  suppressionDb: EmailSuppressionDatabase,
  keys: SigningKeys,
  request: CallbackRequest,
  now: Date,
  reason?: string,
  environment?: string,
): Promise<Response> {
  const claims = await verify(keys, request, "unsubscribe", now);
  const recipient = normalizeAddress(claims.recipient);
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
  // The copy states the scope, because the scope is not what "unsubscribe" implies to most people and
  // getting it wrong in either direction is alarming: somebody who believes this killed their sign-in
  // link, or somebody who believes it stopped everything and then receives a security notice.
  const body =
    "<p>You've been unsubscribed. Messages you ask for — a sign-in link, a security notice — still arrive. Nothing else will.</p>";
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

/** The first value of a form field, or nothing. */
function firstValue(field: string | string[] | undefined): string | undefined {
  return Array.isArray(field) ? field[0] : field;
}

/**
 * Read an unsubscribe POST's form body forgivingly: a body that will not parse reads as an empty form, so the
 * validator after it sees `{}` and the opt-out still lands. Hono's form validator reads the parse this caches.
 */
const forgivingForm: MiddlewareHandler = async (c, next) => {
  const type = c.req.header("content-type") ?? "";
  if (/^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(type)) {
    try {
      await c.req.formData();
    } catch {
      Object.assign(c.req.bodyCache, { formData: Promise.resolve(new FormData()) });
    }
  }
  await next();
};

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

  app.get(
    `${CALLBACK_BASE}/c/:token`,
    describeRoute({
      summary: "Record a click on a tracked link, then send the reader on to it.",
      description:
        "Public: the token's seal is the only gate. A forged, altered, or expired token answers `email/invalid_token` (400) before anything is recorded, and the destination is the http(s) URL sealed into the token, never one from the request.",
      verification: "public",
      responses: { 302: { description: "A redirect to the link's destination, carried in `Location`." } },
    }),
    validate("param", CallbackTokenParam),
    async (c) => {
      const { db, keys } = await setup(c.env as unknown as CallbackEnv);
      return handleClick(db, keys, { token: c.req.valid("param").token, url: c.req.url }, new Date());
    },
  );

  app.get(
    `${CALLBACK_BASE}/o/:token`,
    describeRoute({
      summary: "Record that an email was opened.",
      description:
        "Public: the token's seal is the only gate. The token may carry the `.png` suffix mail clients expect on an image URL.",
      verification: "public",
      responses: { 200: { description: "A 1×1 transparent PNG, never cached.", contentType: "image/png" } },
    }),
    validate("param", CallbackTokenParam),
    async (c) => {
      const { db, keys } = await setup(c.env as unknown as CallbackEnv);
      return handleOpen(db, keys, { token: c.req.valid("param").token, url: c.req.url }, new Date());
    },
  );

  app.get(
    `${CALLBACK_BASE}/u/:token`,
    describeRoute({
      summary: "Show the page that confirms an unsubscribe.",
      description:
        "Public: the token's seal is the only gate. Records nothing, so a mail scanner or a link preview fetching the link changes nothing. The page's button posts back to the same URL.",
      verification: "public",
      responses: {
        200: { description: "A short HTML page with one button that unsubscribes.", contentType: "text/html" },
      },
    }),
    validate("param", CallbackTokenParam),
    async (c) => {
      const { keys } = await setup(c.env as unknown as CallbackEnv);
      return handleUnsubscribePage(keys, { token: c.req.valid("param").token, url: c.req.url }, new Date());
    },
  );

  app.post(
    `${CALLBACK_BASE}/u/:token`,
    describeRoute({
      summary: "Unsubscribe the recipient from everything but the mail they ask for.",
      description:
        "Public: the token's seal is the only gate. The page's button and a mail client's one-click unsubscribe both post here; an empty body works as well as `List-Unsubscribe=One-Click`. The address joins the suppression list shared by every environment.",
      verification: "public",
      responses: { 200: { description: "A short HTML page confirming the opt-out.", contentType: "text/html" } },
    }),
    validate("param", CallbackTokenParam),
    forgivingForm,
    validate("form", UnsubscribeForm),
    async (c) => {
      const env = c.env as unknown as CallbackEnv;
      const { db, suppressionDb, keys } = await setup(env);
      return handleUnsubscribe(
        db,
        suppressionDb,
        keys,
        { token: c.req.valid("param").token, url: c.req.url },
        new Date(),
        firstValue(c.req.valid("form").reason),
        env.ENVIRONMENT,
      );
    },
  );
}
