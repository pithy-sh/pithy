// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeAll, describe, expect, test } from "vitest";
import { googleFetch, readJwt, type TestServiceAccount, testServiceAccount } from "../../test-utils/googlePlay";
import {
  createGoogleAccessTokens,
  decodeIntegrityToken,
  PLAY_INTEGRITY_SCOPE,
  signServiceAccountAssertion,
} from "./google";

let sample: TestServiceAccount;
const NOW = new Date("2026-11-13T12:00:00Z");

beforeAll(async () => {
  sample = await testServiceAccount();
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PithyError) return error.payload.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("signServiceAccountAssertion", () => {
  test("signs an RS256 JWT over the Play Integrity scope that the account's key verifies", async () => {
    const jwt = await signServiceAccountAssertion(sample.account, { scope: PLAY_INTEGRITY_SCOPE, now: NOW });
    const { header, claims, verified } = await readJwt(jwt, sample.publicKey);
    expect(verified).toBe(true);
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: sample.account.private_key_id });
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(claims).toEqual({
      iss: sample.account.client_email,
      scope: PLAY_INTEGRITY_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    });
  });

  test("a private key that is not a PKCS#8 PEM is auth/attestation_config", async () => {
    const account = {
      ...sample.account,
      private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
    };
    expect(await codeOf(signServiceAccountAssertion(account, { scope: PLAY_INTEGRITY_SCOPE, now: NOW }))).toBe(
      "auth/attestation_config",
    );
    expect(
      await codeOf(signServiceAccountAssertion({ ...account, private_key: "nope" }, { scope: "s", now: NOW })),
    ).toBe("auth/attestation_config");
  });
});

describe("createGoogleAccessTokens", () => {
  test("exchanges a signed assertion for an access token with the jwt-bearer grant", async () => {
    const google = googleFetch({});
    const tokens = createGoogleAccessTokens(google.fetch);
    expect(await tokens.get(sample.account, NOW)).toBe("ya29.test");
    const [request] = google.seen;
    expect(request?.method).toBe("POST");
    const form = new URLSearchParams(request?.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect((await readJwt(form.get("assertion") ?? "", sample.publicKey)).verified).toBe(true);
  });

  test("caches the token for its lifetime, and mints again once it runs out", async () => {
    const google = googleFetch({});
    const tokens = createGoogleAccessTokens(google.fetch);
    await tokens.get(sample.account, NOW);
    await tokens.get(sample.account, new Date(NOW.getTime() + 3000 * 1000));
    expect(google.seen).toHaveLength(1);
    await tokens.get(sample.account, new Date(NOW.getTime() + 3600 * 1000));
    expect(google.seen).toHaveLength(2);
  });

  test("a dropped token is minted again", async () => {
    const google = googleFetch({});
    const tokens = createGoogleAccessTokens(google.fetch);
    await tokens.get(sample.account, NOW);
    tokens.drop(sample.account);
    await tokens.get(sample.account, NOW);
    expect(google.seen).toHaveLength(2);
  });

  test("keeps one token per service account", async () => {
    const google = googleFetch({});
    const tokens = createGoogleAccessTokens(google.fetch);
    await tokens.get(sample.account, NOW);
    await tokens.get({ ...sample.account, client_email: "other@example-project.iam.gserviceaccount.com" }, NOW);
    expect(google.seen).toHaveLength(2);
  });

  test.each([400, 401, 403])("Google refusing the account with %i is auth/attestation_config", async (status) => {
    const google = googleFetch({ token: { status, body: { error: "invalid_grant" } } });
    expect(await codeOf(createGoogleAccessTokens(google.fetch).get(sample.account, NOW))).toBe(
      "auth/attestation_config",
    );
  });

  test.each([429, 500, 503])("Google failing with %i is core/upstream_failed", async (status) => {
    const google = googleFetch({ token: { status, body: {} } });
    expect(await codeOf(createGoogleAccessTokens(google.fetch).get(sample.account, NOW))).toBe("core/upstream_failed");
  });

  test("an answer with no access token is core/upstream_failed", async () => {
    const google = googleFetch({ token: { status: 200, body: { token_type: "Bearer" } } });
    expect(await codeOf(createGoogleAccessTokens(google.fetch).get(sample.account, NOW))).toBe("core/upstream_failed");
  });

  test("a network failure is core/upstream_failed, and a timeout core/upstream_timeout", async () => {
    const failing = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    expect(await codeOf(createGoogleAccessTokens(failing).get(sample.account, NOW))).toBe("core/upstream_failed");
    const slow = (async () => {
      throw new DOMException("deadline", "TimeoutError");
    }) as typeof fetch;
    expect(await codeOf(createGoogleAccessTokens(slow).get(sample.account, NOW))).toBe("core/upstream_timeout");
  });
});

describe("decodeIntegrityToken", () => {
  const payload = { requestDetails: { requestPackageName: "com.example.app" } };

  test("posts the token for the package with the access token, and answers tokenPayloadExternal", async () => {
    const google = googleFetch({ decode: { status: 200, body: { tokenPayloadExternal: payload } } });
    const decoded = await decodeIntegrityToken(google.fetch, {
      accessToken: "ya29.test",
      packageName: "com.example.app",
      token: "integrity-token",
    });
    expect(decoded).toEqual({ ok: true, payload });
    const [request] = google.seen;
    expect(request?.url).toBe("https://playintegrity.googleapis.com/v1/com.example.app:decodeIntegrityToken");
    expect(request?.headers.get("authorization")).toBe("Bearer ya29.test");
    expect(JSON.parse(request?.body ?? "")).toEqual({ integrity_token: "integrity-token" });
  });

  test("a 400 is the token refused for this package, not a fault", async () => {
    const google = googleFetch({ decode: { status: 400, body: { error: { message: "Integrity token is invalid" } } } });
    const decoded = await decodeIntegrityToken(google.fetch, { accessToken: "a", packageName: "com.a.b", token: "t" });
    expect(decoded).toEqual({ ok: false, reason: expect.stringContaining("Integrity token is invalid") });
  });

  test.each([401, 403, 404])("a %i is auth/attestation_config", async (status) => {
    const google = googleFetch({ decode: { status, body: { error: { message: "denied" } } } });
    expect(
      await codeOf(decodeIntegrityToken(google.fetch, { accessToken: "a", packageName: "com.a.b", token: "t" })),
    ).toBe("auth/attestation_config");
  });

  test.each([429, 500, 502])("a %i is core/upstream_failed", async (status) => {
    const google = googleFetch({ decode: { status, body: {} } });
    expect(
      await codeOf(decodeIntegrityToken(google.fetch, { accessToken: "a", packageName: "com.a.b", token: "t" })),
    ).toBe("core/upstream_failed");
  });

  test("a 200 with no payload is core/upstream_failed", async () => {
    const google = googleFetch({ decode: { status: 200, body: {} } });
    expect(
      await codeOf(decodeIntegrityToken(google.fetch, { accessToken: "a", packageName: "com.a.b", token: "t" })),
    ).toBe("core/upstream_failed");
  });
});
