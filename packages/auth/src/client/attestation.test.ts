// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { decodeAttestation, requestBinding } from "../attestation/wire";
import type { AuthFailure, AuthFetch, AuthRequestInit } from "./api";
import {
  APP_ATTEST_KEY_STORAGE_KEY,
  type AppAttestModule,
  ATTESTATION_HEADER,
  ATTESTATION_TEST_ASSERTION,
  ATTESTATION_UNAVAILABLE,
  type AttestationProof,
  AttestationRefusedError,
  type AttestationRequest,
  type AttestationTransport,
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
    expect(decoded.ok && decoded.value).toMatchObject({ platform: "android", assertion: ATTESTATION_TEST_ASSERTION });
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

  test("a refusal is handed on to the attester with the proof of the send the Worker refused", async () => {
    const refused: AttestationProof[] = [];
    let made = 0;
    const attester: Attester = {
      platform: "ios",
      attest: async () => {
        made += 1;
        return { assertion: `assertion-${made}`, keyId: `key-${made}` };
      },
      refused: async (proof) => {
        refused.push(proof);
      },
    };
    const attestation = createAttestation({ origin: ORIGIN, fetch: worker().fetch, attester });
    const first = await attestation.attest("{}");
    await attestation.attest("{}");
    const failure: AuthFailure = { code: "auth/attestation_failed", message: "m", action: null };
    if (!first.ok) throw new Error("expected the first send's headers");
    await attestation.refused?.(failure, first.value);
    expect(refused).toEqual([{ assertion: "assertion-1", keyId: "key-1" }]);
    // Headers this attestation never answered name no proof, so nothing is dropped.
    await attestation.refused?.(failure, { [ATTESTATION_HEADER]: "forged" });
    expect(refused).toHaveLength(1);
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

/** A transport to a Worker that issues `reg-1`, `reg-2`… and registers every key, or answers `refusal` there. */
function registrar(): AttestationTransport & {
  log: string[];
  refusal: AuthFailure | null;
  challengeRefusal: AuthFailure | null;
} {
  let issued = 0;
  return {
    log: [],
    refusal: null,
    challengeRefusal: null,
    async challenge() {
      if (this.challengeRefusal) return { ok: false, failure: this.challengeRefusal };
      issued += 1;
      this.log.push(`challenge reg-${issued}`);
      return { ok: true, value: `reg-${issued}` };
    },
    async registerAppAttestKey(input) {
      this.log.push(`register ${input.keyId} ${input.challenge} ${input.attestation}`);
      return this.refusal ? { ok: false, failure: this.refusal } : { ok: true, value: undefined };
    },
  };
}

/** A transport an attester must not use. */
const offline: AttestationTransport = {
  challenge: async () => {
    throw new Error("no transport");
  },
  registerAppAttestKey: async () => {
    throw new Error("no transport");
  },
};

const REQUEST: AttestationRequest = { challenge: "ch", body: '{"email":"a@b.c"}', binding: new Uint8Array([9]) };
const REFUSED: AuthFailure = { code: "auth/attestation_failed", message: "Did not verify.", action: null };
const stored = (keyId: string) => JSON.stringify({ keyId });

describe("App Attest on iOS", () => {
  test("registers a key once over its own challenge, then asserts over the send's challenge and body", async () => {
    const module = appAttest();
    const store = memoryStore();
    const worker = registrar();
    const attester = appAttestAttester({ module, store });

    expect(await attester.attest(REQUEST, worker)).toEqual({ assertion: "assertion-by-key-1", keyId: "key-1" });
    expect(await attester.attest(REQUEST, worker)).toEqual({ assertion: "assertion-by-key-1", keyId: "key-1" });
    // The module hashes what it is handed into clientDataHash: the challenge alone to register, which is the binding
    // over an empty body, and the challenge followed by the body to assert, which is the send's binding.
    expect(module.log).toEqual([
      "generate key-1",
      "attest key-1 reg-1",
      `assert key-1 ch${REQUEST.body}`,
      `assert key-1 ch${REQUEST.body}`,
    ]);
    expect(worker.log).toEqual(["challenge reg-1", "register key-1 reg-1 attestation-of-key-1"]);
    expect(store.data.get(APP_ATTEST_KEY_STORAGE_KEY)).toBe(stored("key-1"));
  });

  test("the attestation object goes only to the registration route, never in the send", async () => {
    const attester = appAttestAttester({ module: appAttest(), store: memoryStore() });
    const proof = await attester.attest(REQUEST, registrar());
    expect(proof.assertion).not.toMatch(/^attestation-of-/);
  });

  test("a registered key outlives the launch, in the secure store, and is not registered again", async () => {
    const store = memoryStore();
    await appAttestAttester({ module: appAttest(), store }).attest(REQUEST, registrar());
    const later = appAttest();
    const worker = registrar();
    expect(await appAttestAttester({ module: later, store }).attest(REQUEST, worker)).toEqual({
      assertion: "assertion-by-key-1",
      keyId: "key-1",
    });
    expect(later.log).toEqual([`assert key-1 ch${REQUEST.body}`]);
    expect(worker.log).toEqual([]);
  });

  test("a registration the Worker refuses is not kept, answers its code, and the next send registers another", async () => {
    const module = appAttest();
    const store = memoryStore();
    const worker = registrar();
    worker.refusal = REFUSED;
    const attester = appAttestAttester({ module, store });
    const thrown = await attester.attest(REQUEST, worker).catch((failure: unknown) => failure);
    expect(thrown).toBeInstanceOf(AttestationRefusedError);
    expect((thrown as AttestationRefusedError).failure).toEqual(REFUSED);
    expect(store.data.size).toBe(0);
    expect(module.log.filter((line) => line.startsWith("assert"))).toEqual([]);

    worker.refusal = null;
    expect(await attester.attest(REQUEST, worker)).toEqual({ assertion: "assertion-by-key-2", keyId: "key-2" });
    expect(store.data.get(APP_ATTEST_KEY_STORAGE_KEY)).toBe(stored("key-2"));
  });

  test("a registration that never got a challenge is not kept, and answers the Worker's code", async () => {
    const store = memoryStore();
    const worker = registrar();
    worker.challengeRefusal = { code: "core/rate_limited", message: "Slow down.", action: null };
    const thrown = await appAttestAttester({ module: appAttest(), store })
      .attest(REQUEST, worker)
      .catch((failure: unknown) => failure);
    expect((thrown as AttestationRefusedError).failure.code).toBe("core/rate_limited");
    expect(store.data.size).toBe(0);
  });

  test("a key the Worker refused at a send is dropped, and the next send registers a new one", async () => {
    const module = appAttest();
    const store = memoryStore();
    const worker = registrar();
    const attester = appAttestAttester({ module, store });
    const proof = await attester.attest(REQUEST, worker);
    await attester.refused?.(proof);
    expect(store.data.size).toBe(0);
    expect(await attester.attest(REQUEST, worker)).toEqual({ assertion: "assertion-by-key-2", keyId: "key-2" });
    expect(worker.log).toEqual([
      "challenge reg-1",
      "register key-1 reg-1 attestation-of-key-1",
      "challenge reg-2",
      "register key-2 reg-2 attestation-of-key-2",
    ]);
  });

  test("a registered key the device can no longer assert with is dropped, and the same send registers a new one", async () => {
    // The Keychain outlives a reinstall, a restore to a new phone or a migration; the App Attest key does not.
    const store = memoryStore();
    store.data.set(APP_ATTEST_KEY_STORAGE_KEY, stored("lost"));
    const module = appAttest();
    const assert = module.generateAssertionAsync;
    module.generateAssertionAsync = async (keyId, challenge) => {
      if (keyId === "lost") {
        module.log.push("assert lost refused");
        throw new Error("invalidKey");
      }
      return assert(keyId, challenge);
    };
    const worker = registrar();
    const attester = appAttestAttester({ module, store });
    expect(await attester.attest(REQUEST, worker)).toEqual({ assertion: "assertion-by-key-1", keyId: "key-1" });
    expect(module.log).toEqual([
      "assert lost refused",
      "generate key-1",
      "attest key-1 reg-1",
      `assert key-1 ch${REQUEST.body}`,
    ]);
    expect(store.data.get(APP_ATTEST_KEY_STORAGE_KEY)).toBe(stored("key-1"));
  });

  test("a device that cannot attest the key leaves nothing stored and registers nothing", async () => {
    const module = appAttest();
    module.attestKeyAsync = async () => {
      throw new Error("serverUnavailable");
    };
    const store = memoryStore();
    const worker = registrar();
    await expect(appAttestAttester({ module, store }).attest(REQUEST, worker)).rejects.toThrow("serverUnavailable");
    expect(store.data.size).toBe(0);
    expect(worker.log).toEqual(["challenge reg-1"]);
  });

  test("two sends at once register one key between them", async () => {
    const module = appAttest();
    const worker = registrar();
    const attester = appAttestAttester({ module, store: memoryStore() });
    const [first, second] = await Promise.all([attester.attest(REQUEST, worker), attester.attest(REQUEST, worker)]);
    expect(first.keyId).toBe("key-1");
    expect(second.keyId).toBe("key-1");
    expect(worker.log.filter((line) => line.startsWith("register"))).toHaveLength(1);
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
    const worker = registrar();
    const attester = appAttestAttester({ module: appAttest(), store });
    expect(await attester.attest(REQUEST, worker)).toEqual({ assertion: "assertion-by-key-1", keyId: "key-1" });
    expect(await attester.attest(REQUEST, worker)).toEqual({ assertion: "assertion-by-key-1", keyId: "key-1" });
    await expect(attester.refused?.({ assertion: "assertion-by-key-1", keyId: "key-1" })).resolves.toBeUndefined();
    expect(worker.log.filter((line) => line.startsWith("register"))).toHaveLength(1);
  });

  test("a late refusal of an older key drops only that key, never the newer one", async () => {
    const module = appAttest();
    const store = memoryStore();
    const worker = registrar();
    const attester = appAttestAttester({ module, store });
    const old = await attester.attest(REQUEST, worker);
    await attester.refused?.(old);
    const fresh = await attester.attest(REQUEST, worker);
    expect(fresh.keyId).toBe("key-2");
    // The first send's refusal, delivered again after key-2 replaced key-1, leaves key-2 held and stored.
    await attester.refused?.(old);
    expect(store.data.get(APP_ATTEST_KEY_STORAGE_KEY)).toBe(stored("key-2"));
    expect(await attester.attest(REQUEST, worker)).toEqual({ assertion: "assertion-by-key-2", keyId: "key-2" });
    expect(worker.log.filter((line) => line.startsWith("register"))).toHaveLength(2);
  });

  test("on a cold launch, sends that start together read the stored key once and register one key", async () => {
    const module = appAttest();
    const backing = memoryStore();
    let reads = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: SecureStore = {
      ...backing,
      // A second read would answer only once released, after the first send had kept its key: the stale `null`
      // it would then hand back must never replace the key in hand.
      getItem: async (key) => {
        reads += 1;
        if (reads > 1) await held;
        return backing.getItem(key);
      },
    };
    const worker = registrar();
    const attester = appAttestAttester({ module, store });
    const first = attester.attest(REQUEST, worker);
    const second = attester.attest(REQUEST, worker);
    expect((await first).keyId).toBe("key-1");
    release();
    expect((await second).keyId).toBe("key-1");
    expect(reads).toBe(1);
    expect(worker.log.filter((line) => line.startsWith("register"))).toHaveLength(1);
  });

  test("a send whose assertion fails reuses the key another send registered meanwhile", async () => {
    const store = memoryStore();
    store.data.set(APP_ATTEST_KEY_STORAGE_KEY, stored("lost"));
    const module = appAttest();
    const assert = module.generateAssertionAsync;
    let lostAsserts = 0;
    let release: () => void = () => {};
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    module.generateAssertionAsync = async (keyId, challenge) => {
      if (keyId === "lost") {
        lostAsserts += 1;
        // The second send's refusal by the device arrives only after the first has registered key-1.
        if (lostAsserts > 1) await late;
        throw new Error("invalidKey");
      }
      return assert(keyId, challenge);
    };
    const worker = registrar();
    const attester = appAttestAttester({ module, store });
    const first = attester.attest(REQUEST, worker);
    const second = attester.attest(REQUEST, worker);
    expect((await first).keyId).toBe("key-1");
    release();
    expect(await second).toEqual({ assertion: "assertion-by-key-1", keyId: "key-1" });
    expect(worker.log.filter((line) => line.startsWith("register"))).toHaveLength(1);
    expect(store.data.get(APP_ATTEST_KEY_STORAGE_KEY)).toBe(stored("key-1"));
  });

  test("two sends whose shared registration is refused both answer its code, and the next send registers", async () => {
    const module = appAttest();
    const store = memoryStore();
    const worker = registrar();
    worker.refusal = REFUSED;
    const attester = appAttestAttester({ module, store });
    const results = await Promise.allSettled([attester.attest(REQUEST, worker), attester.attest(REQUEST, worker)]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect(result.status === "rejected" && (result.reason as AttestationRefusedError).failure).toEqual(REFUSED);
    }
    expect(worker.log.filter((line) => line.startsWith("register"))).toHaveLength(1);
    expect(store.data.size).toBe(0);

    worker.refusal = null;
    expect(await attester.attest(REQUEST, worker)).toEqual({ assertion: "assertion-by-key-2", keyId: "key-2" });
    expect(worker.log.filter((line) => line.startsWith("register"))).toHaveLength(2);
    expect(store.data.get(APP_ATTEST_KEY_STORAGE_KEY)).toBe(stored("key-2"));
  });

  test.each([
    ["not JSON", "key-1"],
    ["JSON that is not an object", '"key-1"'],
    ["null", "null"],
    ["an empty key id", JSON.stringify({ keyId: "" })],
    ["a key id that is not a string", JSON.stringify({ keyId: 7 })],
  ])("a stored value that is %s is never asserted with, and a new key is registered", async (_case, raw) => {
    const module = appAttest();
    const store = memoryStore();
    store.data.set(APP_ATTEST_KEY_STORAGE_KEY, raw);
    expect(await appAttestAttester({ module, store }).attest(REQUEST, registrar())).toEqual({
      assertion: "assertion-by-key-1",
      keyId: "key-1",
    });
    expect(module.log).toEqual(["generate key-1", "attest key-1 reg-1", `assert key-1 ch${REQUEST.body}`]);
  });

  test("a device without App Attest says so before any send", () => {
    expect(appAttestAttester({ module: appAttest(false), store: memoryStore() }).available).toBe(false);
    expect(appAttestAttester({ module: appAttest(true), store: memoryStore() }).available).toBe(true);
  });
});

describe("App Attest through the Worker's routes", () => {
  /** A Worker that issues `c-1`, `c-2`… and registers keys, answering `registration` there when it is set. */
  function routes(registration?: { status: number; body: unknown }) {
    let issued = 0;
    const calls: Call[] = [];
    const fetch: AuthFetch = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/attestation/challenge")) {
        issued += 1;
        return { ok: true, status: 200, json: async () => ({ challenge: `c-${issued}`, expiresAt: "2999-01-01" }) };
      }
      if (registration)
        return { ok: registration.status < 400, status: registration.status, json: async () => registration.body };
      const { keyId } = JSON.parse(String(init?.body)) as { keyId: string };
      return { ok: true, status: 200, json: async () => ({ keyId, registeredAt: "2026-11-13T00:00:00.000Z" }) };
    };
    return { fetch, calls };
  }

  test("registers at /attestation/ios/keys over its own challenge, then sends an assertion over a fresh one", async () => {
    const { fetch, calls } = routes();
    const module = appAttest();
    const store = memoryStore();
    const attestation = createAttestation({ origin: ORIGIN, fetch, attester: appAttestAttester({ module, store }) });
    const body = JSON.stringify({ email: "ada@example.com", type: "sign-in" });

    const result = await attestation.attest(body);
    expect(calls.map((call) => [call.url, call.init?.method, call.init?.body])).toEqual([
      [`${ORIGIN}/auth/attestation/challenge`, "POST", "{}"],
      [`${ORIGIN}/auth/attestation/challenge`, "POST", "{}"],
      [
        `${ORIGIN}/auth/attestation/ios/keys`,
        "POST",
        JSON.stringify({ challenge: "c-2", keyId: "key-1", attestation: "attestation-of-key-1" }),
      ],
    ]);
    expect(decodeAttestation(header(result))).toEqual({
      ok: true,
      value: { platform: "ios", challenge: "c-1", assertion: "assertion-by-key-1", keyId: "key-1" },
    });
    expect(module.log).toEqual(["generate key-1", "attest key-1 c-2", `assert key-1 c-1${body}`]);
  });

  test("a refused registration answers the Worker's code, keeps nothing, and sends nothing", async () => {
    const refusal = { error: { code: "auth/attestation_failed", message: "Did not verify.", action: null } };
    const { fetch } = routes({ status: 403, body: refusal });
    const store = memoryStore();
    const result = await createAttestation({
      origin: ORIGIN,
      fetch,
      attester: appAttestAttester({ module: appAttest(), store }),
    }).attest("{}");
    expect(result.ok ? null : result.failure.code).toBe("auth/attestation_failed");
    expect(store.data.size).toBe(0);
  });

  test("a registration answer that names another key is not a registration of this one", async () => {
    const { fetch } = routes({ status: 200, body: { keyId: "someone-else", registeredAt: "2026-11-13T00:00:00Z" } });
    const store = memoryStore();
    const result = await createAttestation({
      origin: ORIGIN,
      fetch,
      attester: appAttestAttester({ module: appAttest(), store }),
    }).attest("{}");
    expect(result.ok ? null : result.failure.code).toBe("client/unreadable");
    expect(store.data.size).toBe(0);
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
    expect(await attester.attest({ ...REQUEST, binding }, offline)).toEqual({ assertion: `token-for-${hash}` });
    await attester.attest({ ...REQUEST, binding }, offline);
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
    await expect(attester.attest(REQUEST, offline)).rejects.toThrow("PLAY_SERVICES_NOT_FOUND");
    fail = false;
    await attester.attest(REQUEST, offline);
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
    await expect(attester.attest(REQUEST, offline)).rejects.toThrow("ERR_APP_INTEGRITY_PROVIDER_INVALID");
    fail = false;
    expect(await attester.attest(REQUEST, offline)).toEqual({ assertion: "token" });
    expect(module.log.filter((line) => line.startsWith("prepare"))).toEqual(["prepare 1", "prepare 1"]);
  });

  test("with no cloud project number there is nothing to attest with", () => {
    expect(playIntegrityAttester({ module: playIntegrity(), cloudProjectNumber: null }).available).toBe(false);
    expect(playIntegrityAttester({ module: playIntegrity(), cloudProjectNumber: "" }).available).toBe(false);
    expect(playIntegrityAttester({ module: playIntegrity(), cloudProjectNumber: "42" }).available).toBe(true);
  });
});
