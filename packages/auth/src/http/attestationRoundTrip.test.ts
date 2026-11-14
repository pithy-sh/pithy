// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "vitest";
import { type AuthFetch, sendMagicLink, sendOtp, signInWithOtp } from "../client/api";
import { createAttestation, testAttester } from "../client/attestation";
import { createBearerSession, type SecureStore } from "../client/bearer";
import { type LiveApp, resetLiveSecrets, startLiveApp } from "../test-utils/liveApp";

/**
 * A native app's sign-in against the real routes, attested the way a simulator or an emulator attests: a bearer
 * session, a challenge from the Worker, the test assertion, and no Turnstile token anywhere.
 */

const BASE_PATH = "/auth";

/** A fetch with no cookie jar, as a phone's is. */
const nativeFetch: AuthFetch = async (url, init) =>
  fetch(url, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body });

/** A secure store backed by a map. */
function memoryStore(): SecureStore {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    deleteItem: async (key) => {
      data.delete(key);
    },
  };
}

let app: LiveApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  resetLiveSecrets();
});

/** A phone's bearer session and its test attestation, against `live`. */
function phone(live: LiveApp, platform: "ios" | "android") {
  const session = createBearerSession({
    origin: live.origin,
    basePath: BASE_PATH,
    store: memoryStore(),
    device: { id: `device-${platform}`, platform },
    fetch: nativeFetch,
  });
  const attestation = createAttestation({ ...session.options, attester: testAttester(platform) });
  return { session, options: { ...session.options, attestation } };
}

describe("a simulator signs in against a test environment", () => {
  for (const platform of ["ios", "android"] as const) {
    test(`on ${platform}, with the test assertion and no humanity check`, async () => {
      app = await startLiveApp({
        basePath: BASE_PATH,
        environment: "staging",
        turnstile: { mode: "visible", secretKey: "1x0000000000000000000000000000000AA" },
        attestation: { environments: { staging: { mode: "test" } } },
      });
      const { session, options } = phone(app, platform);
      const email = `${platform}@example.com`;

      const sent = await sendOtp({ email, type: "sign-in" }, options);
      expect(sent.ok).toBe(true);
      const otp = await app.mailedOtp(email);
      expect(otp).not.toBeNull();

      const signedIn = await signInWithOtp({ email, otp: otp ?? "" }, options);
      expect(signedIn.ok && typeof signedIn.value.token).toBe("string");
      await session.adopt(signedIn.ok ? String(signedIn.value.token) : "");
      expect(session.signedIn()).toBe(true);

      const linked = await sendMagicLink({ email, callbackURL: "https://app.example.com/callback" }, options);
      expect(linked.ok).toBe(true);
    });
  }
});

describe("a refused send names the gate's code", () => {
  test("the test assertion where the environment enforces is auth/attestation_failed", async () => {
    app = await startLiveApp({
      basePath: BASE_PATH,
      environment: "prod",
      attestation: { environments: { prod: { mode: "enforce", android: [{ packageName: "com.example.app" }] } } },
    });
    const sent = await sendOtp({ email: "ada@example.com", type: "sign-in" }, phone(app, "android").options);
    expect(sent.ok ? null : sent.failure.code).toBe("auth/attestation_failed");
    expect(await app.enqueued()).toEqual([]);
  });

  test("no attestation and no token, with Turnstile composed, is turnstile/missing_token", async () => {
    app = await startLiveApp({
      basePath: BASE_PATH,
      environment: "staging",
      turnstile: { mode: "visible", secretKey: "1x0000000000000000000000000000000AA" },
      attestation: { environments: { staging: { mode: "test" } } },
    });
    const { session } = phone(app, "ios");
    const sent = await sendOtp({ email: "ada@example.com", type: "sign-in" }, session.options);
    expect(sent.ok ? null : sent.failure.code).toBe("turnstile/missing_token");
  });
});
