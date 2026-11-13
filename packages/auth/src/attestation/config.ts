// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { FEATURE_ENVIRONMENT, isValidEnvironment, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { z } from "zod";

/** The platforms a native app attestation can come from. */
export const AttestationPlatform = z
  .enum(["ios", "android"])
  .describe("Where an attestation comes from: `ios`, Apple App Attest; `android`, Google Play Integrity.");
export type AttestationPlatform = z.output<typeof AttestationPlatform>;

/** How an environment treats attestations. */
export const AttestationMode = z
  .enum(["enforce", "test"])
  .describe(
    "`enforce` accepts only a real attestation, judged by its platform's verifier; a platform with no verifier in this release answers `auth/attestation_config`. `test` also accepts the documented test assertion, so simulators, emulators and CI get through. The Worker accepts it only where its `ENVIRONMENT` is `dev`, `staging` or `feature`, whatever this says, and `pithy deploy` refuses a production environment set to `test`.",
  );
export type AttestationMode = z.output<typeof AttestationMode>;

/** An iOS app allowed to attest, as App Attest names it. */
export const AppleAppIdentity = z
  .object({
    teamId: z
      .string()
      .regex(/^[A-Z0-9]{10}$/, "An Apple Team ID is ten uppercase letters or digits.")
      .describe("The Apple Developer Team ID that signs the app: ten uppercase letters or digits."),
    bundleId: z
      .string()
      .min(1)
      .max(255)
      .describe("The app's bundle identifier, such as `com.example.app`. With the Team ID it is the App ID."),
  })
  .describe("An iOS app allowed to attest: its Team ID and bundle identifier.");
export type AppleAppIdentity = z.output<typeof AppleAppIdentity>;

/** An Android app allowed to attest, as Play Integrity names it. */
export const AndroidAppIdentity = z
  .object({
    packageName: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/, "An Android package name is a dotted Java name.")
      .describe("The app's package name as Google Play knows it, such as `com.example.app`."),
  })
  .describe("An Android app allowed to attest: its package name.");
export type AndroidAppIdentity = z.output<typeof AndroidAppIdentity>;

/** One environment's attestation settings. */
export const AttestationEnvironment = z
  .object({
    mode: AttestationMode.default("enforce"),
    ios: z
      .array(AppleAppIdentity)
      .default([])
      .describe("The iOS apps allowed to attest in this environment. Empty refuses every iOS attestation."),
    android: z
      .array(AndroidAppIdentity)
      .default([])
      .describe("The Android apps allowed to attest in this environment. Empty refuses every Android attestation."),
  })
  .refine((block) => block.mode === "test" || block.ios.length + block.android.length > 0, {
    message: "An enforce block must allow at least one app, or no attestation could ever pass it.",
  })
  .describe(
    "One environment's attestation: the apps allowed to attest and the mode. With a block, the send routes accept an attestation in place of a Turnstile token, and require one when turnstile is not composed.",
  );
export type AttestationEnvironment = z.output<typeof AttestationEnvironment>;

/** Auth's `attestation` block. */
export const AttestationConfig = z
  .object({
    challengeExpiresIn: z
      .number()
      .int()
      .positive()
      .max(600)
      .default(300)
      .describe("How long a challenge from the challenge route stays usable, in seconds. Defaults to 5 minutes."),
    environments: z
      .record(
        z.string().refine(isValidEnvironment, "Not an environment name.").describe("An environment name."),
        AttestationEnvironment,
      )
      .default({})
      .describe(
        "The attestation block per environment, keyed by the name the Worker is stamped with: `dev`, `staging`, `prod`, `feature` or one you declared. An environment with no block gates its send routes as before.",
      ),
  })
  .describe(
    "Native app attestation on the email send routes, per environment: Apple App Attest and Google Play Integrity in place of a Turnstile token.",
  );
export type AttestationConfig = z.output<typeof AttestationConfig>;

/** Whether any environment has an attestation block. Without one, nothing attestation adds is mounted. */
export function attestationIsConfigured(config: AttestationConfig): boolean {
  return Object.keys(config.environments).length > 0;
}

/** The block for the environment this Worker is stamped with, or `undefined` for none and for an unstamped Worker. */
export function attestationFor(
  config: AttestationConfig,
  environment: string | null,
): AttestationEnvironment | undefined {
  if (environment === null || !Object.hasOwn(config.environments, environment)) return undefined;
  return config.environments[environment];
}

/**
 * The environments a Worker accepts the test assertion in, when their block is set to `test`: dev, staging and a
 * feature deployment. An allowlist, because the Worker cannot read `seed.productionEnvironments`: a name a project
 * declares, such as `live`, could be production, so the Worker holds it to `enforce` whatever its block says.
 */
export const TEST_ASSERTION_ENVIRONMENTS = [LOCAL_ENVIRONMENT, "staging", FEATURE_ENVIRONMENT] as const;

/** Whether a Worker stamped with `environment` may accept the test assertion. An unstamped Worker may not. */
export function testAssertionAllowedIn(environment: string | null): boolean {
  return environment !== null && (TEST_ASSERTION_ENVIRONMENTS as readonly string[]).includes(environment);
}
