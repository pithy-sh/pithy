// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHash, randomBytes } from "node:crypto";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { cloudflareRequest, decodeResponse } from "../client/errors";

/**
 * **The Pithy OAuth client: one, owned by us, authorized by each adopter against their own account (#759).**
 *
 * Registered 2026-10-15 on the `pithy.` account as `Pithy CLI` — a public client, so no secret ships in
 * this package: `token_endpoint_auth_method: none`, `authorization_code` with PKCE `S256`, and
 * `refresh_token`. Verified by a DNS TXT record on `pithy.sh`, its `client_uri`, and public, which is
 * what lets a user on any account sign in to it. An identifier, not a credential.
 */
export const PITHY_OAUTH_CLIENT_ID = "5ae99cf157ae3e57d354e9c25ad3f7e2";

/** The endpoints, from `https://dash.cloudflare.com/.well-known/openid-configuration`. */
export const CLOUDFLARE_OAUTH = {
  authorize: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
} as const;

/** How long a token-endpoint call may take before it is a timeout rather than a wait. */
const OAUTH_TIMEOUT_MS = 30_000;

/** The slice of `fetch` this module calls: a form POST. Injected, so no test reaches Cloudflare. */
export type OAuthFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: URLSearchParams; signal: AbortSignal },
) => Promise<Response>;

/** A PKCE verifier and the challenge derived from it. The verifier never leaves the process that made it. */
export interface PkcePair {
  /** 43 base64url characters of randomness — sent only to the token endpoint, with the code. */
  verifier: string;
  /** `BASE64URL(SHA256(verifier))` — sent in the authorize URL. */
  challenge: string;
}

/**
 * A fresh PKCE pair.
 *
 * **This is what makes a pasted address safe to accept.** The code in the address a browser lands on is
 * redeemable only with the verifier, and the verifier exists only in the CLI that opened the flow — so a
 * code read off a screen, typed across an SSH session, or seen by anyone else is worth nothing elsewhere.
 */
export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** A fresh `state`. Cloudflare refuses one under eight characters; this is twenty-two. */
export function oauthState(): string {
  return randomBytes(16).toString("base64url");
}

/** What an authorize URL is built from. */
export interface AuthorizeRequest {
  /** The scopes to request — `sessionScopes`, never a hand-written list. */
  scopes: readonly string[];
  /** The loopback redirect: `http://127.0.0.1:<port>/callback`. */
  redirectUri: string;
  /** The `state` the callback must echo. */
  state: string;
  /** The PKCE challenge. */
  challenge: string;
}

/** The URL a browser opens to sign in and consent. */
export function authorizeUrl(request: AuthorizeRequest): string {
  const url = new URL(CLOUDFLARE_OAUTH.authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: PITHY_OAUTH_CLIENT_ID,
    redirect_uri: request.redirectUri,
    scope: request.scopes.join(" "),
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** The token endpoint's answer to a code exchange or a refresh. */
export const OAuthTokenResponse = z
  .object({
    access_token: z.string().min(1).describe("The bearer token API calls carry. One hour, measured."),
    refresh_token: z
      .string()
      .min(1)
      .optional()
      .describe("Present only when `offline_access` was granted. Rotates on every use."),
    token_type: z.string().describe("Always `bearer`."),
    expires_in: z.number().int().positive().describe("Seconds until the access token expires."),
    scope: z.string().describe("The scopes granted, space-separated. Compare it with what was requested."),
  })
  .describe("Cloudflare's token endpoint response, `POST /oauth2/token`.");
export type OAuthTokenResponse = z.output<typeof OAuthTokenResponse>;

/**
 * The token endpoint's refusal body, per RFC 6749 §5.2.
 *
 * **Not the REST API's `errors[]`, so not `cloudflareRefusal`'s to word.** That composer reads the
 * envelope `api.cloudflare.com` answers with and writes a permission-grant action for it; the OAuth
 * endpoints on `dash.cloudflare.com` answer `{ error, error_description }`, and the remedy is a sign-in,
 * not a grant. They are a service we do not control, so a refusal is `core/upstream_failed`.
 */
const OAuthErrorResponse = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/** A session's tokens, as this kit holds them. */
export interface OAuthGrant {
  /** The bearer token. */
  accessToken: string;
  /** The refresh token, or `null` when `offline_access` was not granted. */
  refreshToken: string | null;
  /** When {@link accessToken} stops working, from `expires_in` and the clock at the answer. */
  expiresAt: Date;
  /** The granted scopes, space-separated, verbatim. */
  scope: string;
}

/** What every token-endpoint call takes beyond its own fields. */
interface EndpointOptions {
  /** Defaults to the global `fetch`. */
  fetch?: OAuthFetch;
  /** Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** One form POST to an OAuth endpoint: the status, and the body parsed as JSON where it is JSON. */
async function post(
  operation: string,
  url: string,
  form: Record<string, string>,
  options: EndpointOptions,
): Promise<{ status: number; body: unknown }> {
  const send = options.fetch ?? (globalThis.fetch as unknown as OAuthFetch);
  return cloudflareRequest(operation, async () => {
    const response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? {} : JSON.parse(text);
    } catch {
      body = { error: "invalid_response", error_description: text.slice(0, 200) };
    }
    return { status: response.status, body };
  });
}

/** The refusal's own words, or `null` when the body is not an RFC 6749 error. */
function refusalOf(body: unknown): { error: string; description: string } | null {
  const parsed = OAuthErrorResponse.safeParse(body);
  if (!parsed.success) return null;
  return { error: parsed.data.error, description: parsed.data.error_description ?? parsed.data.error };
}

function grantOf(body: unknown, context: string, now: Date, keepRefresh: string | null): OAuthGrant {
  const token = decodeResponse(OAuthTokenResponse, body, context);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? keepRefresh,
    expiresAt: new Date(now.getTime() + token.expires_in * 1000),
    scope: token.scope,
  };
}

/**
 * Redeem an authorization code for a session.
 *
 * A refusal is a `core/upstream_failed` carrying Cloudflare's own description — an expired code, a
 * `redirect_uri` that does not match, a verifier that does not fit the challenge. Each is a sign-in that
 * has to start over, and the description is what says which.
 */
export async function exchangeCode(
  request: { code: string; verifier: string; redirectUri: string } & EndpointOptions,
): Promise<OAuthGrant> {
  const now = request.now ?? (() => new Date());
  const answer = await post(
    "exchange the sign-in code",
    CLOUDFLARE_OAUTH.token,
    {
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
      client_id: PITHY_OAUTH_CLIENT_ID,
      code_verifier: request.verifier,
    },
    request,
  );
  if (answer.status !== 200) {
    const refusal = refusalOf(answer.body);
    throw new UpstreamError({
      message: `Cloudflare refused the sign-in: ${refusal?.description ?? `HTTP ${answer.status}`}`,
      action: `Run ${commandName("cloudflare connect")} again. A sign-in code works once, and only for a few minutes.`,
      detail: `token endpoint ${answer.status}: ${refusal?.error ?? "no error body"}`,
    });
  }
  return grantOf(answer.body, "token exchange", now(), null);
}

/** What a refresh comes back as: a new grant, or the server's refusal in its own words. */
export type RefreshResult =
  | { kind: "refreshed"; grant: OAuthGrant }
  | { kind: "refused"; error: string; description: string };

/**
 * Renew a session without a browser.
 *
 * **A refusal is an answer, not a throw.** A spent, revoked or expired refresh token means *sign in
 * again*, and the caller decides how to say so — at dispatch it is deferred to the first command that
 * actually needs Cloudflare. Only a transport failure throws, because that one is worth retrying.
 *
 * The refresh token **rotates** on every use (measured). The one handed back must replace the one sent,
 * on disk, before anything else reads it; the caller holds the profile's lock across that write.
 */
export async function refreshGrant(request: { refreshToken: string } & EndpointOptions): Promise<RefreshResult> {
  const now = request.now ?? (() => new Date());
  const answer = await post(
    "renew the Cloudflare session",
    CLOUDFLARE_OAUTH.token,
    { grant_type: "refresh_token", refresh_token: request.refreshToken, client_id: PITHY_OAUTH_CLIENT_ID },
    request,
  );
  if (answer.status !== 200) {
    const refusal = refusalOf(answer.body) ?? { error: `http_${answer.status}`, description: `HTTP ${answer.status}` };
    return { kind: "refused", ...refusal };
  }
  return { kind: "refreshed", grant: grantOf(answer.body, "token refresh", now(), request.refreshToken) };
}

/**
 * Revoke one token at Cloudflare. Throws on a refusal, so `disconnect` never reports a revocation that did
 * not happen — the local file is deleted either way, and the operator is told which half held.
 */
export async function revokeToken(
  request: { token: string; hint: "access_token" | "refresh_token" } & EndpointOptions,
): Promise<void> {
  const answer = await post(
    "revoke the Cloudflare session",
    CLOUDFLARE_OAUTH.revoke,
    { token: request.token, token_type_hint: request.hint, client_id: PITHY_OAUTH_CLIENT_ID },
    request,
  );
  if (answer.status !== 200) {
    const refusal = refusalOf(answer.body);
    throw new UpstreamError({
      message: `Cloudflare did not revoke the session: ${refusal?.description ?? `HTTP ${answer.status}`}`,
      action: "Sign in to the Cloudflare dashboard and revoke the Pithy CLI's access to your account there.",
      detail: `revoke endpoint ${answer.status}: ${refusal?.error ?? "no error body"}`,
    });
  }
}
