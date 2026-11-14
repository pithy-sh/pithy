import * as AppIntegrity from "@expo/app-integrity";
import type { AuthAttestation } from "@pithy-sh/auth/src/client/api";
import {
  ATTESTATION_UNAVAILABLE,
  type Attester,
  appAttestAttester,
  createAttestation,
  playIntegrityAttester,
  testAttester,
} from "@pithy-sh/auth/src/client/attestation";
import type { SecureStore } from "@pithy-sh/auth/src/client/bearer";
import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { useSyncExternalStore } from "react";
import { authConfig, playIntegrityProject } from "./pithy-config";
import { devicePlatform } from "./platform";
import { secureStore, type Transport, transport } from "./transport";

/**
 * How a phone passes the gate on the email send routes: it attests instead of solving Turnstile.
 *
 * Where the build's environment has an attestation block, `auth.<env>.attestation` in the generated config, each
 * send asks the Worker for a challenge and sends the platform's assertion over it in one header:
 *
 * - **`test`**: the documented test assertion, from the iOS Simulator, the Android emulator and CI. No WebView.
 * - **`enforce` on iOS**: App Attest. The first send generates a key in the Secure Enclave and registers it with the
 *   Worker; its id is kept in the Keychain once the Worker has registered it, and every send asserts with it.
 * - **`enforce` on Android**: Play Integrity, for the Google Cloud project `playIntegrity.cloudProjectNumber` names,
 *   once the Worker verifies it. Until then `attestation.platforms.android` is `false` and Android keeps Turnstile.
 *
 * Everywhere else the screen keeps Turnstile: the web build, an environment with no block, a platform the block
 * allows no app for or the Worker cannot yet verify under `enforce` (`attestation.platforms`), an iPhone without
 * App Attest, and an Android build with no project number.
 *
 * A device that cannot attest when it tries, such as a phone without Google Play services or an iPhone whose
 * App Attest keeps refusing, answers `client/attestation_unavailable`. The screens show that code and offer Turnstile
 * for the rest of the launch: the Worker judges a send without the attestation header by Turnstile.
 */

/** The attester for this platform and mode, or `null` where the screen keeps Turnstile. */
export function attesterFor(input: {
  platform: "ios" | "android" | "web";
  mode: "enforce" | "test" | null;
  /** Whether each platform can pass by attesting. Absent, from a config written before it existed, reads as yes. */
  platforms?: { readonly ios: boolean; readonly android: boolean } | undefined;
  store: SecureStore;
  cloudProjectNumber: string | null;
}): Attester | null {
  const { platform, mode } = input;
  if (platform === "web" || mode === null) return null;
  if (input.platforms?.[platform] === false) return null;
  if (mode === "test") return testAttester(platform);
  const attester =
    platform === "ios"
      ? appAttestAttester({ module: AppIntegrity, store: input.store })
      : playIntegrityAttester({ module: AppIntegrity, cloudProjectNumber: input.cloudProjectNumber });
  return attester.available === false ? null : attester;
}

/** SHA-256 through `expo-crypto`: Hermes has no Web Crypto. */
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>));
}

/** The attestation a send carries for `attester`, over `transport`'s auth options, or `null` for none. */
export function attestationFor(attester: Attester | null, over: Transport): AuthAttestation | null {
  if (attester === null) return null;
  return createAttestation({ ...over.auth, attester, digest: sha256 });
}

/** This app's attestation as configured, or `null` where its screens keep Turnstile. Read it through {@link useAttestation}. */
export const attestation: AuthAttestation | null = attestationFor(
  attesterFor({
    platform: devicePlatform(),
    mode: authConfig.enabled ? (authConfig.attestation?.mode ?? null) : null,
    platforms: authConfig.enabled ? authConfig.attestation?.platforms : undefined,
    store: secureStore,
    cloudProjectNumber: playIntegrityProject,
  }),
  transport,
);

let unavailable = false;
const listeners = new Set<() => void>();

/** Stop attesting for the rest of this launch, so every screen offers Turnstile. */
export function attestationUnavailable(): void {
  if (unavailable) return;
  unavailable = true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * `attestation`, with every answer of `client/attestation_unavailable` turned into {@link attestationUnavailable}, so
 * the screen that sent it re-renders with Turnstile.
 */
const watched: AuthAttestation | null =
  attestation === null
    ? null
    : {
        ...attestation,
        async attest(body) {
          const result = await attestation.attest(body);
          if (!result.ok && result.failure.code === ATTESTATION_UNAVAILABLE.code) attestationUnavailable();
          return result;
        },
      };

/** The attestation a screen sends with, or `null` where it shows Turnstile instead. */
export function useAttestation(): AuthAttestation | null {
  return useSyncExternalStore(
    subscribe,
    () => (unavailable ? null : watched),
    () => watched,
  );
}
