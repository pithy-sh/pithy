// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  AUTH_UNREADABLE,
  type AuthAttestation,
  type AuthClientOptions,
  type AuthFailure,
  type AuthResult,
  callAuth,
} from "./api";
import type { SecureStore } from "./bearer";

/**
 * A native app's attestation on the two send routes: a challenge from the Worker, the platform's assertion over
 * that challenge and the send's exact body, and the one header that carries both.
 *
 * **The platform is an injected adapter.** {@link appAttestAttester} and {@link playIntegrityAttester} take
 * `@expo/app-integrity`'s functions as a structural argument, so this package never depends on it: the scaffolded
 * React Native app installs it and hands it in, and a web-only or server-only project installs nothing for this.
 * {@link testAttester} sends the documented test assertion, for simulators, emulators and CI.
 *
 * Nothing here throws. A platform that will not attest, and a Worker that will not issue a challenge, are each an
 * {@link AuthFailure}.
 */

/** The request header the attestation travels in. The Worker's own name for it is in `../attestation/wire`. */
export const ATTESTATION_HEADER = "x-pithy-attestation";

/** The assertion a `test` environment accepts in place of a real one. */
export const ATTESTATION_TEST_ASSERTION = "pithy-test-attestation";

/** Where an App Attest key id is kept between launches, by default. */
export const APP_ATTEST_KEY_STORAGE_KEY = "pithy.attestation.appAttestKey";

/** The platform would not attest: no App Attest on this device, Play services missing, or a key it refused. */
export const ATTESTATION_UNAVAILABLE: AuthFailure = {
  code: "client/attestation_unavailable",
  message: "This device couldn't prove it is running the app.",
  action: "Try again. If it keeps happening, update the app or sign in on another device.",
};

/** What an attester is asked to attest over. */
export interface AttestationRequest {
  /** The challenge the Worker issued. */
  readonly challenge: string;
  /** The send's body, exactly as it goes on the wire. */
  readonly body: string;
  /** SHA-256 of the challenge's UTF-8 followed by the body's: what the Worker checks the assertion against. */
  readonly binding: Uint8Array;
}

/** What an attester produced. */
export interface AttestationProof {
  /** The App Attest assertion, the Play Integrity token, or the test assertion. */
  readonly assertion: string;
  /** The App Attest key id, on iOS. */
  readonly keyId?: string;
}

/** What an attester may ask of the Worker besides the send it attests: the calls a key's registration makes. */
export interface AttestationTransport {
  /** A fresh single-use challenge from `POST {basePath}/attestation/challenge`. */
  challenge(): Promise<AuthResult<string>>;
  /** Register an App Attest key with Apple's attestation of it, at `POST {basePath}/attestation/ios/keys`. */
  registerAppAttestKey(input: { challenge: string; keyId: string; attestation: string }): Promise<AuthResult<void>>;
}

/**
 * The Worker refused a call an attester made through its {@link AttestationTransport}. Thrown by an attester and
 * answered by the send as {@link AttestationRefusedError.failure}, so a refused registration reaches the screen with
 * the Worker's code rather than as {@link ATTESTATION_UNAVAILABLE}.
 */
export class AttestationRefusedError extends Error {
  readonly failure: AuthFailure;
  constructor(failure: AuthFailure) {
    super(failure.message);
    this.name = "AttestationRefusedError";
    this.failure = failure;
  }
}

/** One platform's attestation, injected. */
export interface Attester {
  /** The platform the Worker judges the assertion as. */
  readonly platform: "ios" | "android";
  /** Whether this device can attest at all. Absent means it can. A screen offers Turnstile where it cannot. */
  readonly available?: boolean;
  /**
   * The assertion over `request`. `transport` reaches the Worker for anything the assertion needs first, such as
   * registering a key. May throw: the caller answers an {@link AttestationRefusedError} with its failure and any
   * other throw with {@link ATTESTATION_UNAVAILABLE}.
   */
  attest(request: AttestationRequest, transport: AttestationTransport): Promise<AttestationProof>;
  /** The Worker refused what this produced. An attester holding a key drops it, so the next send starts over. */
  refused?(): Promise<void>;
}

/** The test assertion from `platform`. A `test` environment accepts it; nothing else does. */
export function testAttester(platform: "ios" | "android"): Attester {
  return { platform, attest: async () => ({ assertion: ATTESTATION_TEST_ASSERTION }) };
}

/** The App Attest half of `@expo/app-integrity`, as this module calls it. */
export interface AppAttestModule {
  /** Whether this device provides App Attest. */
  readonly isSupported: boolean;
  /** A new key in the Secure Enclave, by its id. */
  generateKeyAsync(): Promise<string>;
  /** Apple's attestation of the key, over SHA-256 of `challenge`'s UTF-8. */
  attestKeyAsync(keyId: string, challenge: string): Promise<string>;
  /** An assertion by the key, over SHA-256 of `challenge`'s UTF-8. */
  generateAssertionAsync(keyId: string, challenge: string): Promise<string>;
}

/** A stored key id read back, or `null` when the value is not one this module wrote. */
function readKeyId(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { keyId } = parsed as Record<string, unknown>;
    return typeof keyId === "string" && keyId !== "" ? keyId : null;
  } catch {
    return null;
  }
}

/**
 * Apple App Attest.
 *
 * **A key is registered once, then asserts.** With no registered key, a send generates one, asks the Worker for a
 * challenge, has Apple attest the key over it, and posts the attestation object to `/attestation/ios/keys`. The key
 * is kept in `store`, the Keychain on a phone, only when that route answers success; a key it refused, or that never
 * reached it, is never asserted with, and the next send registers another. Then that send, and every later one,
 * asserts with the key over its own challenge and exact body.
 *
 * **A key that stops working is replaced.** A key the device can no longer assert with, which is what a Keychain
 * entry outliving a reinstall or a restore leaves, is dropped and a new one registered on the same send. A send the
 * Worker refuses with `auth/attestation_failed` drops the key too, through {@link Attester.refused}, so the next
 * send registers a new one.
 *
 * **What the module is handed is what the Worker hashes.** `@expo/app-integrity` hashes the string it is handed into
 * `clientDataHash`. Registration hands it the challenge alone, whose SHA-256 is the binding over the challenge and an
 * empty body; an assertion hands it the challenge followed by the send's body, whose SHA-256 is the send's binding.
 */
export function appAttestAttester(input: {
  module: AppAttestModule;
  store: SecureStore;
  storageKey?: string;
}): Attester {
  const { module, store } = input;
  const key = input.storageKey ?? APP_ATTEST_KEY_STORAGE_KEY;
  let held: string | null | undefined;
  let registering: Promise<string> | null = null;

  async function load(): Promise<string | null> {
    if (held !== undefined) return held;
    try {
      held = readKeyId(await store.getItem(key));
    } catch {
      held = null;
    }
    return held;
  }

  async function keep(keyId: string): Promise<void> {
    held = keyId;
    try {
      await store.setItem(key, JSON.stringify({ keyId }));
    } catch {
      // Kept for this launch. The next launch registers a new key.
    }
  }

  async function forget(): Promise<void> {
    held = null;
    try {
      await store.deleteItem(key);
    } catch {
      // Nothing left to try. A key the store kept is refused again, and dropped again.
    }
  }

  /** Generate a key, have Apple attest it over a fresh challenge, and register it. Kept only once registered. */
  async function register(transport: AttestationTransport): Promise<string> {
    const keyId = await module.generateKeyAsync();
    const issued = await transport.challenge();
    if (!issued.ok) throw new AttestationRefusedError(issued.failure);
    const attestation = await module.attestKeyAsync(keyId, issued.value);
    const registered = await transport.registerAppAttestKey({ challenge: issued.value, keyId, attestation });
    if (!registered.ok) throw new AttestationRefusedError(registered.failure);
    await keep(keyId);
    return keyId;
  }

  /** One registration at a time, so two sends at once register one key between them. */
  function registerOnce(transport: AttestationTransport): Promise<string> {
    registering ??= register(transport).finally(() => {
      registering = null;
    });
    return registering;
  }

  return {
    platform: "ios",
    available: module.isSupported,
    async attest(request, transport) {
      const message = `${request.challenge}${request.body}`;
      const current = await load();
      if (current !== null) {
        try {
          return { assertion: await module.generateAssertionAsync(current, message), keyId: current };
        } catch {
          // The Keychain outlives a reinstall, a restore and a migration; the key itself does not. Drop it and
          // register a new one for this same send.
          if (held === current) await forget();
        }
      }
      const keyId = await registerOnce(transport);
      return { assertion: await module.generateAssertionAsync(keyId, message), keyId };
    },
    async refused() {
      await forget();
    },
  };
}

/** The Play Integrity half of `@expo/app-integrity`, as this module calls it. */
export interface PlayIntegrityModule {
  /** Warm up the token provider for a Google Cloud project, by its number. */
  prepareIntegrityTokenProviderAsync(cloudProjectNumber: string): Promise<void>;
  /** A Play Integrity token bound to `requestHash`. */
  requestIntegrityCheckAsync(requestHash: string): Promise<string>;
}

/**
 * Google Play Integrity, standard requests. The provider is prepared for the Google Cloud project the app is linked
 * to in Play Console, and prepared again after any failure, since the module does not prepare an invalid provider
 * again by itself; each send asks for a token whose `requestHash` is the binding's base64url. With no project
 * number there is nothing to prepare, and {@link Attester.available} is `false`.
 */
export function playIntegrityAttester(input: {
  module: PlayIntegrityModule;
  cloudProjectNumber: string | null;
}): Attester {
  const { module, cloudProjectNumber } = input;
  let prepared: Promise<void> | null = null;
  const prepare = (): Promise<void> => {
    prepared ??= module.prepareIntegrityTokenProviderAsync(cloudProjectNumber ?? "").catch((failure: unknown) => {
      prepared = null;
      throw failure;
    });
    return prepared;
  };
  return {
    platform: "android",
    available: cloudProjectNumber !== null && cloudProjectNumber !== "",
    async attest(request) {
      await prepare();
      try {
        return { assertion: await module.requestIntegrityCheckAsync(base64Url(request.binding)) };
      } catch (failure) {
        prepared = null;
        throw failure;
      }
    },
  };
}

/** Unpadded base64url, the encoding the attestation header and Play Integrity's `requestHash` take. */
export function base64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at] ?? 0;
    const b = bytes[at + 1] ?? 0;
    const c = bytes[at + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    const chars = Math.min(4, Math.ceil(((bytes.length - at) * 8) / 6));
    for (let index = 0; index < chars; index += 1) out += alphabet[(triple >> (18 - index * 6)) & 0x3f];
  }
  return out;
}

/** SHA-256 over Web Crypto, where the platform has it. React Native passes `expo-crypto`'s instead. */
async function webDigest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** Whether a value is the challenge route's answer. */
function isChallenge(value: unknown): value is { challenge: string; expiresAt: string } {
  if (typeof value !== "object" || value === null) return false;
  const { challenge } = value as Record<string, unknown>;
  return typeof challenge === "string" && challenge !== "";
}

/** Whether a value is the key registration route's answer. */
function isRegistration(value: unknown): value is { keyId: string; registeredAt: string } {
  if (typeof value !== "object" || value === null) return false;
  const { keyId } = value as Record<string, unknown>;
  return typeof keyId === "string" && keyId !== "";
}

/** The Worker calls an attester makes, over `options`. */
function transportOver(options: AuthClientOptions): AttestationTransport {
  const post = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    async challenge() {
      const issued = await callAuth("/attestation/challenge", post({}), options, isChallenge);
      return issued.ok ? { ok: true, value: issued.value.challenge } : issued;
    },
    async registerAppAttestKey(input) {
      const registered = await callAuth("/attestation/ios/keys", post(input), options, isRegistration);
      if (!registered.ok) return registered;
      // The route echoes the key id it registered. Any other answer is not a registration of this key.
      return registered.value.keyId === input.keyId
        ? { ok: true, value: undefined }
        : { ok: false, failure: AUTH_UNREADABLE };
    },
  };
}

/**
 * The attestation a gated send takes as `options.attestation`: one challenge per send, the attester's assertion
 * over it and the body, and the header that carries them. `options` reaches the challenge route the way every
 * other auth call does, so on a phone it is the bearer session's.
 */
export function createAttestation(
  input: AuthClientOptions & {
    attester: Attester;
    /** SHA-256. Web Crypto's by default. */
    digest?: (bytes: Uint8Array) => Promise<Uint8Array>;
  },
): AuthAttestation {
  const { attester, digest: _digest, attestation: _attestation, gate: _gate, ...options } = input;
  const digest = input.digest ?? webDigest;
  const transport = transportOver(options);
  return {
    async attest(body): Promise<AuthResult<Record<string, string>>> {
      const issued = await transport.challenge();
      if (!issued.ok) return issued;
      const challenge = issued.value;
      const encoder = new TextEncoder();
      const prefix = encoder.encode(challenge);
      const bytes = encoder.encode(body);
      const message = new Uint8Array(prefix.length + bytes.length);
      message.set(prefix, 0);
      message.set(bytes, prefix.length);
      let proof: AttestationProof;
      try {
        proof = await attester.attest({ challenge, body, binding: await digest(message) }, transport);
      } catch (failure) {
        if (failure instanceof AttestationRefusedError) return { ok: false, failure: failure.failure };
        return { ok: false, failure: ATTESTATION_UNAVAILABLE };
      }
      if (typeof proof.assertion !== "string" || proof.assertion === "") {
        return { ok: false, failure: AUTH_UNREADABLE };
      }
      const presented = {
        platform: attester.platform,
        challenge,
        assertion: proof.assertion,
        ...(proof.keyId === undefined ? {} : { keyId: proof.keyId }),
      };
      return { ok: true, value: { [ATTESTATION_HEADER]: base64Url(encoder.encode(JSON.stringify(presented))) } };
    },
    async refused() {
      try {
        await attester.refused?.();
      } catch {
        // The refusal is the caller's answer either way.
      }
    },
  };
}
