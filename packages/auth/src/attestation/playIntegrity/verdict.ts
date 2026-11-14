// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { base64UrlEncode } from "@pithy-sh/core/src/controlPlane/token/base64url";
import { z } from "zod";
import type { AttestationVerdict } from "../verifier";

/** How long after it was requested a token is still accepted, in seconds. */
export const PLAY_INTEGRITY_MAX_AGE_SECONDS = 300;

/** How far ahead of the Worker's clock a token's timestamp may be, in seconds. */
export const PLAY_INTEGRITY_MAX_SKEW_SECONDS = 60;

/** The device label every accepted verdict carries. */
const DEVICE_INTEGRITY = "MEETS_DEVICE_INTEGRITY";

/** The parts of `tokenPayloadExternal` auth judges. Every other field is ignored. */
export const IntegrityTokenPayload = z
  .object({
    requestDetails: z
      .object({
        requestPackageName: z.string().describe("The package name the app requested the token for."),
        requestHash: z
          .string()
          .optional()
          .describe("A standard request's binding: the base64url of SHA-256 over the challenge and the body."),
        nonce: z.string().optional().describe("A classic request's binding, when the app sent one instead."),
        timestampMillis: z.string().describe("When the token was requested, in milliseconds since the epoch."),
      })
      .describe("What the app asked for, as Google recorded it."),
    appIntegrity: z
      .object({
        appRecognitionVerdict: z
          .string()
          .optional()
          .describe("`PLAY_RECOGNIZED` when the binary is the one Google Play distributes."),
        packageName: z
          .string()
          .optional()
          .describe(
            "The package Google Play attested the binary as. Unlike `requestPackageName`, Google vouches for it.",
          ),
      })
      .optional()
      .describe("Google Play's verdict on the app binary."),
    deviceIntegrity: z
      .object({
        deviceRecognitionVerdict: z
          .array(z.string())
          .optional()
          .describe("The integrity labels the device meets, such as `MEETS_DEVICE_INTEGRITY`."),
      })
      .optional()
      .describe("Google Play's verdict on the device."),
  })
  .describe("A decoded Play Integrity token, as `decodeIntegrityToken` returns it in `tokenPayloadExternal`.");
export type IntegrityTokenPayload = z.output<typeof IntegrityTokenPayload>;

/** What a decoded payload is judged against. */
export interface IntegrityExpectation {
  /** {@link import("../wire").requestBinding} for this request. */
  binding: Uint8Array;
  /** The package the token was decoded for, one this environment allows. */
  packageName: string;
  now: Date;
}

const stripPadding = (value: string): string => value.replace(/=+$/, "");

/** The binding check: `requestHash` on a standard request, `nonce` on a classic one, padding ignored. */
function judgeBinding(details: IntegrityTokenPayload["requestDetails"], binding: Uint8Array): AttestationVerdict {
  const expected = base64UrlEncode(binding);
  if (details.requestHash !== undefined) {
    return stripPadding(details.requestHash) === expected
      ? { ok: true }
      : { ok: false, reason: "requestHash: the token is bound to another challenge or body" };
  }
  if (details.nonce !== undefined) {
    return stripPadding(details.nonce) === expected
      ? { ok: true }
      : { ok: false, reason: "nonce: the token is bound to another challenge or body" };
  }
  return { ok: false, reason: "requestHash: the token carries neither a requestHash nor a nonce" };
}

/**
 * Judge a decoded Play Integrity payload. `reason` starts with the check that failed: `format`, `requestHash` or
 * `nonce`, `requestPackageName`, `appRecognitionVerdict`, `appIntegrity` (the package Google attested is another
 * app's), `deviceIntegrity` or `timestamp`.
 */
export function judgeIntegrityVerdict(payload: unknown, expected: IntegrityExpectation): AttestationVerdict {
  const parsed = IntegrityTokenPayload.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: `format: the decoded token has the wrong shape: ${parsed.error.issues[0]?.message}` };
  }
  const { requestDetails, appIntegrity, deviceIntegrity } = parsed.data;

  const binding = judgeBinding(requestDetails, expected.binding);
  if (!binding.ok) return binding;

  if (requestDetails.requestPackageName !== expected.packageName) {
    return {
      ok: false,
      reason: `requestPackageName: the token was requested for ${requestDetails.requestPackageName}, not ${expected.packageName}`,
    };
  }

  const recognition = appIntegrity?.appRecognitionVerdict ?? "absent";
  if (recognition !== "PLAY_RECOGNIZED") {
    return { ok: false, reason: `appRecognitionVerdict: Google Play calls the app ${recognition}` };
  }

  const attested = appIntegrity?.packageName;
  if (attested !== expected.packageName) {
    return {
      ok: false,
      reason: `appIntegrity: Google Play attested the app as ${attested ?? "no package"}, not ${expected.packageName}`,
    };
  }

  const labels = deviceIntegrity?.deviceRecognitionVerdict ?? [];
  if (!labels.includes(DEVICE_INTEGRITY)) {
    return {
      ok: false,
      reason: `deviceIntegrity: the device does not meet ${DEVICE_INTEGRITY} (${labels.length === 0 ? "no label" : labels.join(", ")})`,
    };
  }

  const requestedAt = /^\d+$/.test(requestDetails.timestampMillis)
    ? Number(requestDetails.timestampMillis)
    : Number.NaN;
  if (!Number.isSafeInteger(requestedAt)) {
    return { ok: false, reason: "timestamp: timestampMillis is not a number" };
  }
  const age = expected.now.getTime() - requestedAt;
  if (age > PLAY_INTEGRITY_MAX_AGE_SECONDS * 1000) {
    return {
      ok: false,
      reason: `timestamp: the token was requested ${Math.round(age / 1000)}s ago, over the ${PLAY_INTEGRITY_MAX_AGE_SECONDS}s window`,
    };
  }
  if (-age > PLAY_INTEGRITY_MAX_SKEW_SECONDS * 1000) {
    return {
      ok: false,
      reason: `timestamp: the token is stamped ${Math.round(-age / 1000)}s ahead of the Worker's clock`,
    };
  }
  return { ok: true };
}
