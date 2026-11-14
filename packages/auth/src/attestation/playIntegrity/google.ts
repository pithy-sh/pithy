// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import { base64UrlEncode } from "@pithy-sh/core/src/controlPlane/token/base64url";
import { UpstreamError, UpstreamTimeoutError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { AUTH_PLAY_INTEGRITY_SERVICE_ACCOUNT, type PlayIntegrityServiceAccount } from "../../instance/secrets";
import { AttestationConfigError } from "../errors";

/** The OAuth scope `decodeIntegrityToken` takes. */
export const PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";

/** Google's token endpoint, where a service account's file names none. */
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** How long one call to Google may take, in milliseconds. */
export const GOOGLE_DEADLINE_MS = 10_000;

/** The longest-lived assertion Google's token endpoint accepts, in seconds. */
const ASSERTION_LIFETIME_SECONDS = 3600;

/** How long before its stated expiry a cached access token is replaced, in milliseconds. */
const TOKEN_EARLY_REFRESH_MS = 60_000;

const PLAY_INTEGRITY_API = "https://playintegrity.googleapis.com/v1";

/** The operator's remedy for a service account that is missing, malformed or refused. */
export const SERVICE_ACCOUNT_ACTION = `Store the Google Cloud service account's JSON key with \`${pithyCommand("secrets create", { args: [AUTH_PLAY_INTEGRITY_SERVICE_ACCOUNT] })}\` for this environment, and link its Google Cloud project to the app in Play Console. See the auth package's docs/attestation.md.`;

/** The token endpoint's answer, as far as auth reads it. */
const AccessTokenAnswer = z
  .object({
    access_token: z.string().min(1).describe("The OAuth access token."),
    expires_in: z.number().positive().describe("How long the token lives, in seconds."),
  })
  .describe("Google's answer to a jwt-bearer grant.");

/** `decodeIntegrityToken`'s answer, as far as auth reads it. */
const DecodeAnswer = z
  .object({
    tokenPayloadExternal: z.record(z.string(), z.unknown()).describe("The decoded token payload."),
  })
  .describe("Google's answer to decodeIntegrityToken.");

function decodePem(pem: string): Uint8Array | undefined {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  if (body.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return undefined;
  try {
    return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function importPrivateKey(account: PlayIntegrityServiceAccount): Promise<CryptoKey> {
  const der = decodePem(account.private_key);
  try {
    if (der === undefined) throw new TypeError("not a PEM");
    return await crypto.subtle.importKey(
      "pkcs8",
      der as Uint8Array<ArrayBuffer>,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new AttestationConfigError({
      detail: `the Play Integrity service account ${account.client_email} has a private_key that is not an RSA PKCS#8 PEM`,
      action: SERVICE_ACCOUNT_ACTION,
    });
  }
}

function encodeJson(value: Record<string, unknown>): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/** Sign the RS256 assertion a service account exchanges for an access token. */
export async function signServiceAccountAssertion(
  account: PlayIntegrityServiceAccount,
  options: { scope: string; now: Date },
): Promise<string> {
  const key = await importPrivateKey(account);
  const iat = Math.floor(options.now.getTime() / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(account.private_key_id ? { kid: account.private_key_id } : {}) };
  const claims = {
    iss: account.client_email,
    scope: options.scope,
    aud: account.token_uri ?? GOOGLE_TOKEN_URI,
    iat,
    exp: iat + ASSERTION_LIFETIME_SECONDS,
  };
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** One call to Google under {@link GOOGLE_DEADLINE_MS}. A call that never answers is the upstream pair's. */
async function callGoogle(fetchImpl: typeof fetch, url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(GOOGLE_DEADLINE_MS) });
  } catch (error) {
    const name = error instanceof Error || error instanceof DOMException ? error.name : "";
    if (name === "TimeoutError") {
      throw new UpstreamTimeoutError({ detail: `${what}: Google did not answer within ${GOOGLE_DEADLINE_MS}ms` });
    }
    throw new UpstreamError({ detail: `${what}: Google could not be reached: ${String(error)}` });
  }
}

/** Google's own wording for a refusal, from an `{ error }` or `{ error: { message } }` body. */
async function googleReason(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    if (typeof body.error === "string") {
      return typeof body.error_description === "string" ? `${body.error}: ${body.error_description}` : body.error;
    }
    if (typeof body.error === "object" && body.error !== null) {
      const message = (body.error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Not JSON: the status alone is the reason.
  }
  return `HTTP ${response.status}`;
}

/** The access tokens a verifier holds, one per service account, each kept until shortly before it expires. */
export interface GoogleAccessTokens {
  /** A live access token for `account`, minted when none is held. */
  get(account: PlayIntegrityServiceAccount, now: Date): Promise<string>;
  /** Forget `account`'s token, so the next {@link get} mints a new one. */
  drop(account: PlayIntegrityServiceAccount): void;
}

function cacheKey(account: PlayIntegrityServiceAccount): string {
  return `${account.client_email}\n${account.private_key_id ?? ""}\n${account.token_uri ?? GOOGLE_TOKEN_URI}`;
}

/**
 * Access tokens for the Play Integrity scope. Google refusing the account is `auth/attestation_config`; Google
 * failing, or answering something that is not a token, is `core/upstream_failed` or `core/upstream_timeout`.
 */
export function createGoogleAccessTokens(fetchImpl: typeof fetch): GoogleAccessTokens {
  const held = new Map<string, { token: string; expiresAt: number }>();
  return {
    async get(account, now) {
      const key = cacheKey(account);
      const cached = held.get(key);
      if (cached !== undefined && now.getTime() < cached.expiresAt) return cached.token;

      const assertion = await signServiceAccountAssertion(account, { scope: PLAY_INTEGRITY_SCOPE, now });
      const tokenUri = account.token_uri ?? GOOGLE_TOKEN_URI;
      const response = await callGoogle(
        fetchImpl,
        tokenUri,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
        },
        "token",
      );
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new AttestationConfigError({
          detail: `Google refused the Play Integrity service account ${account.client_email} at ${tokenUri} (${response.status}): ${await googleReason(response)}`,
          action: SERVICE_ACCOUNT_ACTION,
        });
      }
      if (!response.ok) {
        throw new UpstreamError({
          detail: `token: ${tokenUri} answered ${response.status}: ${await googleReason(response)}`,
        });
      }
      const answer = AccessTokenAnswer.safeParse(await response.json().catch(() => undefined));
      if (!answer.success) throw new UpstreamError({ detail: `token: ${tokenUri} answered 200 with no access token` });
      held.set(key, {
        token: answer.data.access_token,
        expiresAt: now.getTime() + answer.data.expires_in * 1000 - TOKEN_EARLY_REFRESH_MS,
      });
      return answer.data.access_token;
    },
    drop(account) {
      held.delete(cacheKey(account));
    },
  };
}

/** A token decoded, or refused by Google for this package. */
export type DecodedIntegrityToken = { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Call `decodeIntegrityToken` for `packageName`. A 400 is the token refused for this package; a 401, 403 or 404 is
 * the server's credential or project setup, `auth/attestation_config`; anything else Google gets wrong is the
 * upstream pair's.
 */
export async function decodeIntegrityToken(
  fetchImpl: typeof fetch,
  input: { accessToken: string; packageName: string; token: string },
): Promise<DecodedIntegrityToken> {
  const url = `${PLAY_INTEGRITY_API}/${encodeURIComponent(input.packageName)}:decodeIntegrityToken`;
  const response = await callGoogle(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ integrity_token: input.token }),
    },
    "decode",
  );
  if (response.status === 400) {
    return {
      ok: false,
      reason: `Google would not decode it for ${input.packageName}: ${await googleReason(response)}`,
    };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new AttestationConfigError({
      detail: `decodeIntegrityToken for ${input.packageName} answered ${response.status}: ${await googleReason(response)}`,
      action: `Enable the Play Integrity API in the service account's Google Cloud project, and link that project to ${input.packageName} in Play Console under Test and release > App integrity.`,
    });
  }
  if (!response.ok) {
    throw new UpstreamError({
      detail: `decode: decodeIntegrityToken for ${input.packageName} answered ${response.status}: ${await googleReason(response)}`,
    });
  }
  const answer = DecodeAnswer.safeParse(await response.json().catch(() => undefined));
  if (!answer.success) {
    throw new UpstreamError({ detail: `decode: decodeIntegrityToken answered 200 with no tokenPayloadExternal` });
  }
  return { ok: true, payload: answer.data.tokenPayloadExternal };
}
