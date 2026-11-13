// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { base64UrlDecode, base64UrlEncode } from "@pithy-sh/core/src/controlPlane/token/base64url";
import { z } from "zod";
import { AttestationPlatform } from "./config";

/**
 * The one header a native app's attestation travels in, on a send route.
 *
 * A header rather than body fields: the send routes' bodies are Better Auth's, forwarded untouched, and the
 * attestation signs over those exact bytes ({@link requestBinding}), so it cannot sit inside them.
 */
export const ATTESTATION_HEADER = "x-pithy-attestation";

/** The longest header value read. A Play Integrity token or an App Attest attestation object fits well inside. */
export const MAX_ATTESTATION_HEADER = 16_384;

/** What a client sends in {@link ATTESTATION_HEADER}, before its base64url encoding. */
export const PresentedAttestation = z
  .object({
    platform: AttestationPlatform,
    challenge: z
      .string()
      .min(1)
      .max(128)
      .describe("The challenge the challenge route issued. Single use: presenting it spends it, pass or fail."),
    assertion: z
      .string()
      .min(1)
      .describe(
        "What the platform produced over the request binding: an App Attest attestation object or assertion on iOS, a Play Integrity token on Android, base64 as the platform hands it over. Or the documented test assertion, in a `test` environment.",
      ),
    keyId: z.string().min(1).max(256).optional().describe("The App Attest key identifier on iOS. Android has none."),
  })
  .describe(
    "A native app attestation as a send route reads it: the platform, the challenge it answers, and the platform's assertion over the request.",
  );
export type PresentedAttestation = z.output<typeof PresentedAttestation>;

/** A decoded header, or why it could not be read. */
export type DecodedAttestation = { ok: true; value: PresentedAttestation } | { ok: false; reason: string };

/** Encode an attestation for {@link ATTESTATION_HEADER}: unpadded base64url over its JSON. */
export function encodeAttestation(presented: PresentedAttestation): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(presented)));
}

/** Read {@link ATTESTATION_HEADER}'s value. Never throws: a header that does not read is the caller's refusal. */
export function decodeAttestation(header: string): DecodedAttestation {
  if (header.length === 0) return { ok: false, reason: "the attestation header is empty" };
  if (header.length > MAX_ATTESTATION_HEADER) {
    return { ok: false, reason: `the attestation header is over ${MAX_ATTESTATION_HEADER} characters` };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(base64UrlDecode(header)));
  } catch {
    return { ok: false, reason: "the attestation header is not base64url-encoded JSON" };
  }
  const parsed = PresentedAttestation.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `the attestation header has the wrong shape: ${parsed.error.issues[0]?.message}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * The bytes a platform's assertion must be made over: SHA-256 of the challenge's UTF-8 and then the request body,
 * byte for byte. App Attest takes it as `clientDataHash`; Play Integrity takes its base64url as `requestHash`. It
 * binds one attestation to one challenge and one body, so it cannot be lifted onto another address.
 */
export async function requestBinding(challenge: string, body: Uint8Array): Promise<Uint8Array> {
  const prefix = new TextEncoder().encode(challenge);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", message));
}
