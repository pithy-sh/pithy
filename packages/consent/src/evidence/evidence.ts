// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import { ConsentEvidenceStoreMissingError } from "../error/errors";

/**
 * The evidence behind a signed grant, kept where it can be produced again.
 *
 * A document is text, small, and read beside the row, so it rests in D1 (`pithy_consent_documents`). A drawn
 * signature and a provider's completion certificate are bytes, so they rest in R2 under their own SHA-256: one
 * object per distinct content, written once, and named by what it is rather than by who gave it, so the key
 * reveals nothing and a second grant with the same image costs nothing.
 */

/** The binding the evidence bucket is reached through. */
export const CONSENT_EVIDENCE_BINDING = "CONSENT_EVIDENCE";

/** The R2 key prefix for each kind of evidence. */
export const EVIDENCE_PREFIX = { drawn: "consent/drawn/", certificate: "consent/certificates/" } as const;

/** What kind of bytes an evidence object holds. */
export type EvidenceKind = keyof typeof EVIDENCE_PREFIX;

/** The SHA-256 of `bytes`, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** The SHA-256 of `text`'s UTF-8 bytes — what a document is kept under, and what a grant records. */
export function documentHash(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/** Decode standard base64 into bytes; `null` for anything that is not. */
export function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** The evidence bucket off an env, or `undefined` where none is bound. */
export function evidenceBucket(env: Record<string, unknown>): R2Bucket | undefined {
  const bucket = env[CONSENT_EVIDENCE_BINDING];
  return typeof bucket === "object" && bucket !== null ? (bucket as R2Bucket) : undefined;
}

/**
 * Keep one evidence object under its own hash and answer the hash. Written once: an object already there is the same
 * bytes by construction, so a second put is skipped. Refused, naming the binding, where no bucket is bound.
 */
export async function keepEvidence(
  bucket: R2Bucket | undefined,
  kind: EvidenceKind,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  if (!bucket) throw new ConsentEvidenceStoreMissingError({ detail: `no ${CONSENT_EVIDENCE_BINDING} binding` });
  const hash = await sha256Hex(bytes);
  const key = `${EVIDENCE_PREFIX[kind]}${hash}`;
  if ((await bucket.head(key)) === null) {
    await bucket.put(key, bytes, { httpMetadata: { contentType } });
  }
  return hash;
}

/** One evidence object by hash, from whichever prefix holds it, or `null` where none does. */
export async function readEvidence(
  bucket: R2Bucket | undefined,
  hash: string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  if (!bucket) throw new ConsentEvidenceStoreMissingError({ detail: `no ${CONSENT_EVIDENCE_BINDING} binding` });
  for (const prefix of Object.values(EVIDENCE_PREFIX)) {
    const object = await bucket.get(`${prefix}${hash}`);
    if (object !== null) {
      return {
        bytes: await object.arrayBuffer(),
        contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      };
    }
  }
  return null;
}
