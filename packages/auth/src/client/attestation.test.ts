// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ATTESTATION_TEST_ASSERTION as SERVER_TEST_ASSERTION } from "../attestation/verifier";
import { decodeAttestation, requestBinding, ATTESTATION_HEADER as SERVER_HEADER } from "../attestation/wire";
import type { AuthFetch, AuthRequestInit } from "./api";
import {
  APP_ATTEST_KEY_STORAGE_KEY,
  type AppAttestModule,
  ATTESTATION_HEADER,
  ATTESTATION_TEST_ASSERTION,
  ATTESTATION_UNAVAILABLE,
  type AttestationRequest,
  type Attester,
  appAttestAttester,
  base64Url,
  createAttestation,
  type PlayIntegrityModule,
  playIntegrityAttester,
  testAttester,
} from "./attestation";
import type { SecureStore } from "./bearer";

const ORIGIN = "https://api.example.test";

/** One request the attestation made. */
interface Call {
  url: string;
  init: AuthRequestInit | undefined;
}

/** A Worker that issues `challenge` from the challenge route, or answers `refusal` there. */
function worker(
  challenge = "c".repeat(43),
  refusal?: { status: number; body: unknown },
): { fetch: AuthFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (refusal) return { ok: false, status: refusal.status, json: async () => refusal.body };
      return { ok: true, status: 200, json: async () => ({ challenge, expiresAt: "2999-01-01T00:00:00.000Z" }) };
    },
  };
}

/** A secure store backed by a map. */
function memoryStore(): SecureStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    deleteItem: async (key) => {
      data.delete(key);
    },
  };
}

/** The header value out of a result that must have one. */
function header(result: Awaited<ReturnType<ReturnType<typeof createAttestation>["attest"]>>): string {
  if (!result.ok) throw new Error(`expected a header, got ${result.failure.code}`);
  return result.value[ATTESTATION_HEADER] ?? "";
}

describe("the client speaks the gate's wire", () => {
  test("the header and the test assertion are the ones the Worker reads", () => {
    expect(ATTESTATION_HEADER).toBe(SERVER_HEADER);
    expect(ATTESTATION_TEST_ASSERTION).toBe(SERVER_TEST_ASSERTION);
  });

  test("base64url is unpadded and URL-safe, for every length", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00, 0x7f]);
    for (let length = 0; length <= bytes.length; length += 1) {
      const slice = bytes.slice(0, length);
      expect(base64Url(slice)).toBe(Buffer.from(slice).toString("base64url"));
    }
  });
});

describe("an attestation over one send", () => {
  test("asks for a challenge, attests over it and the exact body, and encodes what the gate decodes", async () => {
    const { fetch, calls } = worker("the-challenge");
    const seen: AttestationRequest[] = [];
    const attester: Attester = {
      platform: "ios",
      attest: async (request) => {
        seen.push(request);
        return { assertion: "assertion-bytes", keyId: "key-1" };
      },
    };
    const body = JSON.stringify({ email: "ada@example.com", type: "sign-in" });
    const result = await createAttestation({ origin: ORIGIN, fetch, attester }).attest(body);

    expect(calls.map((call) => [call.url, call.init?.method])).toEqual([
      [`${ORIGIN}/auth/attestation/challenge`, "POST"],
    ]);
    expect(seen[0]?.challenge).toBe("the-challenge");
    expect(seen[0]?.body).toBe(body);
    expect(seen[0]?.binding).toEqual(await requestBinding("the-challenge", new TextEncoder().encode(body)));
    expect(decodeAttestation(header(result))).toEqual({
      ok: true,
      value: { platform: "ios", challenge: "the-challenge", assertion: "assertion-bytes", keyId: "key-1" },
    });
  });

  test("the test attester sends the documented test assertion, and no key", async () => {
    const { fetch } = worker();
    const result = await createAttestation({ origin: ORIGIN, fetch, attester: testAttester("android") }).attest("{}");
    const decoded = decodeAttestation(header(result));
    expect(decoded.ok && decoded.value).toMatchObject({ platform: "android", assertion: SERVER_TEST_ASSERTION });
    expect(decoded.ok && "keyId" in decoded.value).toBe(false);
  });

  test("the digest is the one injected, for a platform with no Web Crypto", async () => {
    const { fetch } = worker("ch");
    const digested: Uint8Array[] = [];
    let binding: Uint8Array | undefined;
    await createAttestation({
      origin: ORIGIN,
      fetch,
      digest: async (bytes) => {
        digested.push(bytes);
        return new Uint8Array([1, 2, 3]);
      },
      attester: {
        platform: "android",
        attest: async (request) => {
          binding = request.binding;
          return { assertion: "a" };
        },
      },
    }).attest("{}");
    expect(new TextDecoder().decode(digested[0])).toBe("ch{}");
    expect(binding).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("a challenge route that refuses is the failure, with the Worker's code", async () => {
    const refusal = { error: { code: "auth/attestation_config", message: "App attestation is not configured." } };
    const { fetch } = worker("x", { status: 500, body: refusal });
    const result = await createAttestation({ origin: ORIGIN, fetch, attester: testAttester("ios") }).attest("{}");
    expect(result.ok ? null : result.failure.code).toBe("auth/attestation_config");
  });

  test("a challenge answer with no challenge in it is unreadable", async () => {
    const fetch: AuthFetch = async () => ({ ok: true, status: 200, json: async () => ({ challenge: "" }) });
    const result = await createAttestation({ origin: ORIGIN, fetch, attester: testAttester("ios") }).attest("{}");
    expect(result.ok ? null : result.failure.code).toBe("client/unreadable");
  });

  test("a platform that will not attest is a failure to render, never a throw", async () => {
    const { fetch } = worker();
    const attester: Attester = {
      platform: "ios",
      attest: async () => {
        throw new Error("DCError.featureUnsupported");
      },
    };
    const result = await createAttestation({ origin: ORIGIN, fetch, attester }).attest("{}");
    expect(result).toEqual({ ok: false, failure: ATTESTATION_UNAVAILABLE });
  });

  test("a refusal is handed on to the attester, so it can start over", async () => {
    let reset = 0;
    const attester: Attester = {
      ...testAttester("ios"),
      refused: async () => {
        reset += 1;
      },
    };
    const attestation = createAttestation({ origin: ORIGIN, fetch: worker().fetch, attester });
    await attestation.refused?.({ code: "auth/attestation_failed", message: "m", action: null });
    expect(reset).toBe(1);
  });

  test("an acceptance is handed on to the attester, and an attester that throws on it costs nothing", async () => {
    let kept = 0;
    const attester: Attester = {
      ...testAttester("ios"),
      accepted: async () => {
        kept += 1;
        throw new Error("keychain locked");
      },
    };
    const attestation = createAttestation({ origin: ORIGIN, fetch: worker().fetch, attester });
    await expect(attestation.accepted?.()).resolves.toBeUndefined();
    expect(kept).toBe(1);
  });
});

/** `@expo/app-integrity`'s App Attest half, recording what it was asked. */
function appAttest(supported = true): AppAttestModule & { log: string[] } {
  const log: string[] = [];
  let keys = 0;
  return {
    log,
    isSupported: supported,
    generateKeyAsync: async () => {
      keys += 1;
      log.push(`generate key-${keys}`);
      return `key-${keys}`;
    },
    attestKeyAsync: async (keyId, challenge) => {
      log.push(`attest ${keyId} ${challenge}`);
      return `attestation-of-${keyId}`;
    },
    generateAssertionAsync: async (keyId, challenge) => {
      log.push(`assert ${keyId} ${challenge}`);
      return `assertion-by-${keyId}`;
    },
  };
}

const REQUEST: AttestationRequest = { challenge: "ch", body: '{"email":"a@b.c"}', binding: new Uint8Array([9]) };

describe("App Attest on iOS", () => {
  test("generates a key once, registers it with an attestation, then asserts with it", async () => {
    const module = appAttest();
    const store = memoryStore();
    const attester = appAttestAttester({ module, store });

    expect(await attester.attest(REQUEST)).toEqual({ assertion: "attestation-of-key-1", keyId: "key-1" });
    await attester.accepted?.();
    expect(await attester.attest(REQUEST)).toEqual({ assertion: "assertion-by-key-1", keyId: "key-1" });
    // The module hashes what it is handed into clientDataHash, so it is handed the binding's preimage.
    expect(module.log).toEqual(["generate key-1", `attest key-1 ch${REQUEST.body}`, `assert key-1 ch${REQUEST.body}`]);
  });

  test("the key and its registration outlive the launch, in the secure store", async () => {
    const store = memoryStore();
    const first = appAttestAttester({ module: appAttest(), store });
    await first.attest(REQUEST);
    await first.accepted?.();
    const later = appAttest();
    expect(await appAttestAttester({ module: later, store }).attest(REQUEST)).toEqual({
      assertion: "assertion-by-key-1",
      keyId: "key-1",
    });
    expect(later.log).toEqual([`assert key-1 ch${REQUEST.body}`]);
  });

  test("a key the Worker refused is dropped, and the next send registers a new one", async () => {
    const module = appAttest();
    const store = memoryStore();
    const attester = appAttestAttester({ module, store });
    await attester.attest(REQUEST);
    await attester.accepted?.();
    await attester.refused?.();
    expect(store.data.size).toBe(0);
    expect(await attester.attest(REQUEST)).toEqual({ assertion: "attestation-of-key-2", keyId: "key-2" });
  });

  test("a registered key the device can no longer assert with is dropped, and the same send registers a new one", async () => {
    // The Keychain outlives a reinstall, a restore to a new phone or a migration; the App Attest key does not.
    const store = memoryStore();
    const first = appAttestAttester({ module: appAttest(), store });
    await first.attest(REQUEST);
    await first.accepted?.();
    const later = appAttest();
    later.generateAssertionAsync = async (keyId) => {
      later.log.push(`assert ${keyId} refused`);
      throw new Error("invalidKey");
    };
    let generated = 0;
    later.generateKeyAsync = async () => {
      generated += 1;
      later.log.push(`generate fresh-${generated}`);
      return `fresh-${generated}`;
    };
    const attester = appAttestAttester({ module: later, store });
    expect(await attester.attest(REQUEST)).toEqual({ assertion: "attestation-of-fresh-1", keyId: "fresh-1" });
    expect(later.log).toEqual(["assert key-1 refused", "generate fresh-1", `attest fresh-1 ch${REQUEST.body}`]);
    expect(store.data.size).toBe(0);
    await attester.accepted?.();
    expect(JSON.parse(store.data.values().next().value ?? "{}")).toEqual({ keyId: "fresh-1", registered: true });
  });

  test("a registered key that cannot assert and a device that cannot register leave nothing stored", async () => {
    const store = memoryStore();
    const first = appAttestAttester({ module: appAttest(), store });
    await first.attest(REQUEST);
    await first.accepted?.();
    const later = appAttest();
    later.generateAssertionAsync = async () => {
      throw new Error("invalidKey");
    };
    later.attestKeyAsync = async () => {
      throw new Error("serverUnavailable");
    };
    const attester = appAttestAttester({ module: later, store });
    await expect(attester.attest(REQUEST)).rejects.toThrow("serverUnavailable");
    expect(store.data.size).toBe(0);
    later.attestKeyAsync = async (keyId) => `attestation-of-${keyId}`;
    expect(await attester.attest(REQUEST)).toMatchObject({ assertion: expect.stringMatching(/^attestation-of-/) });
  });

  test("a key whose attestation failed is not kept as registered", async () => {
    const module = appAttest();
    module.attestKeyAsync = async () => {
      throw new Error("serverUnavailable");
    };
    const store = memoryStore();
    await expect(appAttestAttester({ module, store }).attest(REQUEST)).rejects.toThrow("serverUnavailable");
    expect(store.data.size).toBe(0);
  });

  test("a store that refuses costs the key's permanence, never the send", async () => {
    const store: SecureStore = {
      getItem: async () => {
        throw new Error("locked");
      },
      setItem: async () => {
        throw new Error("locked");
      },
      deleteItem: async () => {
        throw new Error("locked");
      },
    };
    const attester = appAttestAttester({ module: appAttest(), store });
    expect(await attester.attest(REQUEST)).toEqual({ assertion: "attestation-of-key-1", keyId: "key-1" });
    await expect(attester.accepted?.()).resolves.toBeUndefined();
    expect(await attester.attest(REQUEST)).toEqual({ assertion: "assertion-by-key-1", keyId: "key-1" });
    await expect(attester.refused?.()).resolves.toBeUndefined();
  });

  test("a key whose send never succeeded is not registered, and the next send attests a new one", async () => {
    const module = appAttest();
    const store = memoryStore();
    const attester = appAttestAttester({ module, store });
    await attester.attest(REQUEST);
    // The send was lost, rate limited, or refused for a reason other than the attestation: no accepted().
    expect(store.data.size).toBe(0);
    expect(await attester.attest(REQUEST)).toEqual({ assertion: "attestation-of-key-2", keyId: "key-2" });
    await attester.accepted?.();
    expect(await attester.attest(REQUEST)).toEqual({ assertion: "assertion-by-key-2", keyId: "key-2" });
    expect(module.log.filter((line) => line.startsWith("assert"))).toEqual([`assert key-2 ch${REQUEST.body}`]);
  });

  test("an acceptance with no attestation outstanding changes nothing", async () => {
    const store = memoryStore();
    const attester = appAttestAttester({ module: appAttest(), store });
    await attester.accepted?.();
    expect(store.data.size).toBe(0);
    await attester.attest(REQUEST);
    await attester.accepted?.();
    await attester.accepted?.();
    expect(store.data.get(APP_ATTEST_KEY_STORAGE_KEY)).toBe(JSON.stringify({ keyId: "key-1", registered: true }));
  });

  test.each([
    ["not JSON", "key-1"],
    ["JSON that is not an object", '"key-1"'],
    ["null", "null"],
    ["an empty key id", JSON.stringify({ keyId: "", registered: true })],
    ["a key id that is not a string", JSON.stringify({ keyId: 7, registered: true })],
    ["a registration that is not a boolean", JSON.stringify({ keyId: "key-9", registered: "yes" })],
    ["a key never registered", JSON.stringify({ keyId: "key-9", registered: false })],
  ])("a stored value that is %s is never asserted with, and a new key is registered", async (_case, raw) => {
    const module = appAttest();
    const store = memoryStore();
    store.data.set(APP_ATTEST_KEY_STORAGE_KEY, raw);
    expect(await appAttestAttester({ module, store }).attest(REQUEST)).toEqual({
      assertion: "attestation-of-key-1",
      keyId: "key-1",
    });
    expect(module.log).toEqual(["generate key-1", `attest key-1 ch${REQUEST.body}`]);
  });

  test("a device without App Attest says so before any send", () => {
    expect(appAttestAttester({ module: appAttest(false), store: memoryStore() }).available).toBe(false);
    expect(appAttestAttester({ module: appAttest(true), store: memoryStore() }).available).toBe(true);
  });
});

/** `@expo/app-integrity`'s Play Integrity half, recording what it was asked. */
function playIntegrity(): PlayIntegrityModule & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    prepareIntegrityTokenProviderAsync: async (project) => {
      log.push(`prepare ${project}`);
    },
    requestIntegrityCheckAsync: async (hash) => {
      log.push(`request ${hash}`);
      return `token-for-${hash}`;
    },
  };
}

describe("Play Integrity on Android", () => {
  test("prepares the provider once, then asks for a token bound to the binding's base64url", async () => {
    const module = playIntegrity();
    const attester = playIntegrityAttester({ module, cloudProjectNumber: "123456789" });
    const binding = new Uint8Array(32).fill(0xff);
    const hash = Buffer.from(binding).toString("base64url");
    expect(await attester.attest({ ...REQUEST, binding })).toEqual({ assertion: `token-for-${hash}` });
    await attester.attest({ ...REQUEST, binding });
    expect(module.log).toEqual(["prepare 123456789", `request ${hash}`, `request ${hash}`]);
  });

  test("a provider that failed to prepare is prepared again on the next send", async () => {
    const module = playIntegrity();
    let fail = true;
    module.prepareIntegrityTokenProviderAsync = async (project) => {
      module.log.push(`prepare ${project}`);
      if (fail) throw new Error("PLAY_SERVICES_NOT_FOUND");
    };
    const attester = playIntegrityAttester({ module, cloudProjectNumber: "1" });
    await expect(attester.attest(REQUEST)).rejects.toThrow("PLAY_SERVICES_NOT_FOUND");
    fail = false;
    await attester.attest(REQUEST);
    expect(module.log.filter((line) => line.startsWith("prepare"))).toEqual(["prepare 1", "prepare 1"]);
  });

  test("a token request that fails after the provider was prepared prepares it again on the next send", async () => {
    const module = playIntegrity();
    let fail = true;
    module.requestIntegrityCheckAsync = async (hash) => {
      module.log.push(`request ${hash}`);
      if (fail) throw new Error("ERR_APP_INTEGRITY_PROVIDER_INVALID");
      return "token";
    };
    const attester = playIntegrityAttester({ module, cloudProjectNumber: "1" });
    await expect(attester.attest(REQUEST)).rejects.toThrow("ERR_APP_INTEGRITY_PROVIDER_INVALID");
    fail = false;
    expect(await attester.attest(REQUEST)).toEqual({ assertion: "token" });
    expect(module.log.filter((line) => line.startsWith("prepare"))).toEqual(["prepare 1", "prepare 1"]);
  });

  test("with no cloud project number there is nothing to attest with", () => {
    expect(playIntegrityAttester({ module: playIntegrity(), cloudProjectNumber: null }).available).toBe(false);
    expect(playIntegrityAttester({ module: playIntegrity(), cloudProjectNumber: "" }).available).toBe(false);
    expect(playIntegrityAttester({ module: playIntegrity(), cloudProjectNumber: "42" }).available).toBe(true);
  });
});
