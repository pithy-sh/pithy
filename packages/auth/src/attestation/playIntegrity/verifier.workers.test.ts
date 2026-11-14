// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { base64UrlEncode } from "@pithy-sh/core/src/controlPlane/token/base64url";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { stubSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { AuthDatabase } from "../../data/tables";
import { AUTH_PLAY_INTEGRITY_SERVICE_ACCOUNT, authSecretsRegistry } from "../../instance/secrets";
import {
  googleFetch,
  passingDecode,
  type StubAnswer,
  type TestServiceAccount,
  testServiceAccount,
} from "../../test-utils/googlePlay";
import { AttestationEnvironment } from "../config";
import type { AttestationVerification } from "../verifier";
import { createPlayIntegrityVerifier } from "./verifier";

const PACKAGE = "com.example.app";
const SETTINGS = AttestationEnvironment.parse({ android: [{ packageName: PACKAGE }] });
const BINDING = new Uint8Array(32).fill(9);
const TOKEN = "eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIn0.integrity-token";

let sample: TestServiceAccount;

beforeAll(async () => {
  sample = await testServiceAccount();
});

afterEach(() => {
  resetSharedSecrets();
});

function provision(account: unknown = sample.account): void {
  stubSecrets(authSecretsRegistry, {
    [AUTH_PLAY_INTEGRITY_SERVICE_ACCOUNT]: account as TestServiceAccount["account"],
  });
}

function verification(overrides: Partial<AttestationVerification> = {}): AttestationVerification {
  return {
    presented: { platform: "android", challenge: "c", assertion: TOKEN },
    binding: BINDING,
    environment: "prod",
    settings: SETTINGS,
    db: {} as AuthDatabase,
    env: {},
    now: new Date(),
    ...overrides,
  };
}

/** The recorded passing answer with `tokenPayloadExternal` changed by `change`. */
function altered(change: (payload: Record<string, Record<string, unknown>>) => void): StubAnswer {
  const answer = passingDecode(BINDING, new Date(), PACKAGE);
  const payload = (answer.body as { tokenPayloadExternal: Record<string, Record<string, unknown>> })
    .tokenPayloadExternal;
  change(payload);
  return answer;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    const value = await promise;
    return `answered ${JSON.stringify(value)}`;
  } catch (error) {
    if (error instanceof PithyError) return error.payload.code;
    throw error;
  }
}

describe("the Play Integrity verifier", () => {
  test("accepts a recorded decodeIntegrityToken answer that passes", async () => {
    provision();
    const google = googleFetch({ decode: passingDecode(BINDING, new Date(), PACKAGE) });
    const verdict = await createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification());
    expect(verdict).toEqual({ ok: true });
    expect(google.seen.map((request) => request.url)).toEqual([
      "https://oauth2.googleapis.com/token",
      `https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`,
    ]);
    expect(JSON.parse(google.seen[1]?.body ?? "")).toEqual({ integrity_token: TOKEN });
  });

  test("mints one access token and reuses it for the next attestation", async () => {
    provision();
    const google = googleFetch({ decode: () => passingDecode(BINDING, new Date(), PACKAGE) });
    const verifier = createPlayIntegrityVerifier({ fetch: google.fetch });
    await verifier.verify(verification());
    await verifier.verify(verification());
    expect(google.seen.filter((request) => request.url.includes("oauth2"))).toHaveLength(1);
  });

  test("checks the token's requestHash against the binding over this request's challenge and body", async () => {
    provision();
    const google = googleFetch({
      decode: altered((payload) => {
        payload.requestDetails = {
          ...payload.requestDetails,
          requestHash: base64UrlEncode(new Uint8Array(32).fill(1)),
        };
      }),
    });
    const verdict = await createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification());
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^requestHash: /) });
  });

  test("refuses a token requested for another package", async () => {
    provision();
    const google = googleFetch({
      decode: altered((payload) => {
        payload.requestDetails = { ...payload.requestDetails, requestPackageName: "com.example.impostor" };
      }),
    });
    const verdict = await createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification());
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^requestPackageName: /) });
  });

  test("refuses an app Google Play does not recognize", async () => {
    provision();
    const google = googleFetch({
      decode: altered((payload) => {
        payload.appIntegrity = { appRecognitionVerdict: "UNRECOGNIZED_VERSION" };
      }),
    });
    const verdict = await createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification());
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^appRecognitionVerdict: /) });
  });

  test("refuses a device that does not meet device integrity", async () => {
    provision();
    const google = googleFetch({
      decode: altered((payload) => {
        payload.deviceIntegrity = { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] };
      }),
    });
    const verdict = await createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification());
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^deviceIntegrity: /) });
  });

  test("refuses a stale token", async () => {
    provision();
    const google = googleFetch({
      decode: altered((payload) => {
        payload.requestDetails = {
          ...payload.requestDetails,
          timestampMillis: String(Date.now() - 15 * 60 * 1000),
        };
      }),
    });
    const verdict = await createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification());
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^timestamp: /) });
  });

  test("decodes for each allowed package in turn, and judges against the one that decoded", async () => {
    provision();
    const settings = AttestationEnvironment.parse({
      android: [{ packageName: "com.example.lite" }, { packageName: PACKAGE }],
    });
    const google = googleFetch({
      decode: (request) =>
        request.url.includes("com.example.lite")
          ? { status: 400, body: { error: { message: "Integrity token cannot be decoded" } } }
          : passingDecode(BINDING, new Date(), PACKAGE),
    });
    expect(await createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification({ settings }))).toEqual({
      ok: true,
    });
  });

  test("a token Google decodes for no allowed package fails on decode", async () => {
    provision();
    const google = googleFetch({ decode: { status: 400, body: { error: { message: "invalid token" } } } });
    const verdict = await createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification());
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^decode: .*invalid token/) });
  });

  test("refuses where no Android app is allowed, without calling Google", async () => {
    provision();
    const google = googleFetch({});
    const settings = AttestationEnvironment.parse({ mode: "test" });
    const verdict = await createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification({ settings }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^requestPackageName: /) });
    expect(google.seen).toHaveLength(0);
  });
});

describe("the Play Integrity verifier's own faults are auth/attestation_config, never auth/attestation_failed", () => {
  test("no service account stored", async () => {
    stubSecrets(authSecretsRegistry, {});
    const google = googleFetch({});
    expect(await codeOf(createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification()))).toBe(
      "auth/attestation_config",
    );
    expect(google.seen).toHaveLength(0);
  });

  test("a service account whose private key is not a key", async () => {
    provision({ ...sample.account, private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" });
    const google = googleFetch({});
    expect(await codeOf(createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification()))).toBe(
      "auth/attestation_config",
    );
  });

  test.each([401, 403])("Google's token endpoint answering %i", async (status) => {
    provision();
    const google = googleFetch({ token: { status, body: { error: "invalid_grant" } } });
    expect(await codeOf(createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification()))).toBe(
      "auth/attestation_config",
    );
  });

  test.each([401, 403])(
    "decodeIntegrityToken answering %i, and the next attestation mints a new token",
    async (status) => {
      provision();
      let decodes = 0;
      const google = googleFetch({
        decode: () => {
          decodes += 1;
          return decodes === 1
            ? { status, body: { error: { message: "The caller does not have permission" } } }
            : passingDecode(BINDING, new Date(), PACKAGE);
        },
      });
      const verifier = createPlayIntegrityVerifier({ fetch: google.fetch });
      expect(await codeOf(verifier.verify(verification()))).toBe("auth/attestation_config");
      expect(await verifier.verify(verification())).toEqual({ ok: true });
      expect(google.seen.filter((request) => request.url.includes("oauth2"))).toHaveLength(2);
    },
  );

  test("Google failing outright is core/upstream_failed, which blames neither the user nor the setup", async () => {
    provision();
    const google = googleFetch({ decode: { status: 503, body: {} } });
    expect(await codeOf(createPlayIntegrityVerifier({ fetch: google.fetch }).verify(verification()))).toBe(
      "core/upstream_failed",
    );
  });
});
