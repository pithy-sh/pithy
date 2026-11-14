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
  /** The App Attest attestation object or assertion, the Play Integrity token, or the test assertion. */
  readonly assertion: string;
  /** The App Attest key id, on iOS. */
  readonly keyId?: string;
}

/** One platform's attestation, injected. */
export interface Attester {
  /** The platform the Worker judges the assertion as. */
  readonly platform: "ios" | "android";
  /** Whether this device can attest at all. Absent means it can. A screen offers Turnstile where it cannot. */
  readonly available?: boolean;
  /** The assertion over `request`. May throw: the caller turns a throw into {@link ATTESTATION_UNAVAILABLE}. */
  attest(request: AttestationRequest): Promise<AttestationProof>;
  /** The Worker refused what this produced. An attester holding a key drops it, so the next send starts over. */
  refused?(): Promise<void>;
  /** The send carrying what this produced succeeded. An attester registering a key keeps it as registered. */
  accepted?(): Promise<void>;
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

/** An App Attest key as stored: its id, and whether the Worker has been sent its attestation. */
interface StoredKey {
  keyId: string;
  registered: boolean;
}

/** A stored key read back, or `null` when the value is not one this module wrote. */
function readKey(raw: string | null): StoredKey | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { keyId, registered } = parsed as Record<string, unknown>;
    if (typeof keyId !== "string" || keyId === "" || typeof registered !== "boolean") return null;
    return { keyId, registered };
  } catch {
    return null;
  }
}

/**
 * Apple App Attest. A send with no registered key generates one and sends Apple's attestation of it; once that send
 * succeeds the key is kept as registered, in `store`, the Keychain on a phone, and every later send asserts with it.
 * A key whose send did not succeed is never asserted with: the Worker may not have seen it, and App Attest attests
 * a key only once, so the next send generates another. A registered key the device cannot assert with, which is what
 * a Keychain entry outliving a reinstall or a restore leaves, is dropped and a new one registered in its place.
 *
 * `@expo/app-integrity` hashes the string it is handed into `clientDataHash`, so it is handed the binding's
 * preimage, the challenge followed by the body, and the hash it makes is the binding.
 */
export function appAttestAttester(input: {
  module: AppAttestModule;
  store: SecureStore;
  storageKey?: string;
}): Attester {
  const { module, store } = input;
  const key = input.storageKey ?? APP_ATTEST_KEY_STORAGE_KEY;
  let held: StoredKey | null | undefined;
  let pending: string | null = null;

  async function load(): Promise<StoredKey | null> {
    if (held !== undefined) return held;
    try {
      held = readKey(await store.getItem(key));
    } catch {
      held = null;
    }
    return held;
  }

  async function keep(next: StoredKey): Promise<void> {
    held = next;
    try {
      await store.setItem(key, JSON.stringify(next));
    } catch {
      // Kept for this launch. The next launch registers a new key.
    }
  }

  return {
    platform: "ios",
    available: module.isSupported,
    async attest(request) {
      const message = `${request.challenge}${request.body}`;
      const current = await load();
      if (current?.registered) {
        try {
          return { assertion: await module.generateAssertionAsync(current.keyId, message), keyId: current.keyId };
        } catch {
          // The Keychain outlives a reinstall, a restore and a migration; the key itself does not. Drop it and
          // register a new one over this same request.
          await forget();
        }
      }
      pending = null;
      const keyId = await module.generateKeyAsync();
      const attestation = await module.attestKeyAsync(keyId, message);
      pending = keyId;
      return { assertion: attestation, keyId };
    },
    async accepted() {
      if (pending === null) return;
      const keyId = pending;
      pending = null;
      await keep({ keyId, registered: true });
    },
    async refused() {
      pending = null;
      await forget();
    },
  };

  async function forget(): Promise<void> {
    held = null;
    try {
      await store.deleteItem(key);
    } catch {
      // Nothing left to try. A key the store kept is refused again, and dropped again.
    }
  }
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
  return {
    async attest(body): Promise<AuthResult<Record<string, string>>> {
      const issued = await callAuth(
        "/attestation/challenge",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        options,
        isChallenge,
      );
      if (!issued.ok) return issued;
      const { challenge } = issued.value;
      const encoder = new TextEncoder();
      const prefix = encoder.encode(challenge);
      const bytes = encoder.encode(body);
      const message = new Uint8Array(prefix.length + bytes.length);
      message.set(prefix, 0);
      message.set(bytes, prefix.length);
      let proof: AttestationProof;
      try {
        proof = await attester.attest({ challenge, body, binding: await digest(message) });
      } catch {
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
    async accepted() {
      try {
        await attester.accepted?.();
      } catch {
        // The send succeeded either way. A key not kept is registered again on a later send.
      }
    },
  };
}
