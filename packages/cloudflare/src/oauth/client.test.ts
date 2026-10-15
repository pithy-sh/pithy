// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  authorizeUrl,
  CLOUDFLARE_OAUTH,
  exchangeCode,
  type OAuthFetch,
  oauthState,
  PITHY_OAUTH_CLIENT_ID,
  pkcePair,
  refreshGrant,
  revokeToken,
} from "./client";

/** A fetch that records each call and answers with the next queued response. */
function fakeFetch(...answers: Array<{ status: number; body: unknown }>): OAuthFetch & {
  calls: Array<{ url: string; body: URLSearchParams }>;
} {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const fn: OAuthFetch = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body) });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("unexpected call");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  return Object.assign(fn, { calls });
}

const NOW = new Date("2026-10-15T12:00:00Z");

describe("pkcePair", () => {
  test("the challenge is the S256 of the verifier, both base64url", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  test("two pairs never share a verifier", () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });
});

describe("oauthState", () => {
  test("is long enough for Cloudflare, which refuses a state under eight characters", () => {
    // Measured: `state=x` came back as `invalid_state` — "must be at least be 8 characters long".
    expect(oauthState().length).toBeGreaterThanOrEqual(16);
    expect(oauthState()).not.toBe(oauthState());
  });
});

describe("authorizeUrl", () => {
  test("asks for a code with S256, for the Pithy client, carrying every parameter the flow checks", () => {
    const url = new URL(
      authorizeUrl({
        scopes: ["user-details.read", "d1.write"],
        redirectUri: "http://127.0.0.1:5123/callback",
        state: "abcdefghijklmnop",
        challenge: "CHALLENGE",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(CLOUDFLARE_OAUTH.authorize);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: PITHY_OAUTH_CLIENT_ID,
      redirect_uri: "http://127.0.0.1:5123/callback",
      scope: "user-details.read d1.write",
      state: "abcdefghijklmnop",
      code_challenge: "CHALLENGE",
      code_challenge_method: "S256",
    });
  });
});

describe("exchangeCode", () => {
  test("redeems the code with the verifier and no secret, and dates the expiry from now", async () => {
    const fetch = fakeFetch({
      status: 200,
      body: {
        access_token: "AT",
        refresh_token: "RT",
        token_type: "bearer",
        expires_in: 3600,
        scope: "user-details.read offline_access",
      },
    });
    const grant = await exchangeCode({
      code: "cfoac_x",
      verifier: "VERIFIER",
      redirectUri: "http://127.0.0.1:5123/callback",
      fetch,
      now: () => NOW,
    });
    expect(grant).toEqual({
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: new Date("2026-10-15T13:00:00Z"),
      scope: "user-details.read offline_access",
    });
    expect(fetch.calls[0]?.url).toBe(CLOUDFLARE_OAUTH.token);
    expect(Object.fromEntries(fetch.calls[0]?.body ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "cfoac_x",
      redirect_uri: "http://127.0.0.1:5123/callback",
      client_id: PITHY_OAUTH_CLIENT_ID,
      code_verifier: "VERIFIER",
    });
  });

  test("a grant without offline_access carries no refresh token, and says so rather than inventing one", async () => {
    const fetch = fakeFetch({
      status: 200,
      body: { access_token: "AT", token_type: "bearer", expires_in: 3600, scope: "user-details.read" },
    });
    const grant = await exchangeCode({ code: "c", verifier: "v", redirectUri: "r", fetch, now: () => NOW });
    expect(grant.refreshToken).toBeNull();
  });

  test("a refusal from the token endpoint is a PithyError carrying Cloudflare's own words", async () => {
    const fetch = fakeFetch({
      status: 400,
      body: { error: "invalid_grant", error_description: "The authorization code has expired." },
    });
    const failure = await exchangeCode({ code: "c", verifier: "v", redirectUri: "r", fetch, now: () => NOW }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toMatch(/authorization code has expired/);
  });

  test("an answer that is not a token is refused, never half-trusted", async () => {
    const fetch = fakeFetch({ status: 200, body: { token_type: "bearer" } });
    await expect(exchangeCode({ code: "c", verifier: "v", redirectUri: "r", fetch, now: () => NOW })).rejects.toThrow(
      PithyError,
    );
  });
});

describe("refreshGrant", () => {
  test("renews with the refresh token and hands back the rotated one", async () => {
    const fetch = fakeFetch({
      status: 200,
      body: { access_token: "AT2", refresh_token: "RT2", token_type: "bearer", expires_in: 3600, scope: "s" },
    });
    const result = await refreshGrant({ refreshToken: "RT1", fetch, now: () => NOW });
    expect(result).toEqual({
      kind: "refreshed",
      grant: { accessToken: "AT2", refreshToken: "RT2", expiresAt: new Date("2026-10-15T13:00:00Z"), scope: "s" },
    });
    expect(Object.fromEntries(fetch.calls[0]?.body ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "RT1",
      client_id: PITHY_OAUTH_CLIENT_ID,
    });
  });

  test("a refresh token the server no longer honors is a refusal the caller can act on, not a throw", async () => {
    // A spent, revoked or expired refresh token is the "sign in again" case. It is an answer, and the
    // caller decides what to say about it; a network failure is the thing that throws.
    const fetch = fakeFetch({
      status: 400,
      body: { error: "invalid_grant", error_description: "The refresh token is malformed or not valid." },
    });
    expect(await refreshGrant({ refreshToken: "RT1", fetch, now: () => NOW })).toEqual({
      kind: "refused",
      error: "invalid_grant",
      description: "The refresh token is malformed or not valid.",
    });
  });

  test("keeps the refresh token it was handed when the server does not rotate it", async () => {
    const fetch = fakeFetch({
      status: 200,
      body: { access_token: "AT2", token_type: "bearer", expires_in: 3600, scope: "s" },
    });
    const result = await refreshGrant({ refreshToken: "RT1", fetch, now: () => NOW });
    expect(result.kind === "refreshed" && result.grant.refreshToken).toBe("RT1");
  });
});

describe("revokeToken", () => {
  test("revokes with the hint and the client id", async () => {
    const fetch = fakeFetch({ status: 200, body: {} });
    await revokeToken({ token: "RT", hint: "refresh_token", fetch });
    expect(fetch.calls[0]?.url).toBe(CLOUDFLARE_OAUTH.revoke);
    expect(Object.fromEntries(fetch.calls[0]?.body ?? [])).toEqual({
      token: "RT",
      token_type_hint: "refresh_token",
      client_id: PITHY_OAUTH_CLIENT_ID,
    });
  });

  test("a refused revoke is a PithyError, so a disconnect never claims a revocation that did not happen", async () => {
    const fetch = fakeFetch({ status: 500, body: { error: "server_error" } });
    await expect(revokeToken({ token: "RT", hint: "refresh_token", fetch })).rejects.toThrow(PithyError);
  });
});
