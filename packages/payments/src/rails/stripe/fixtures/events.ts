// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { StripeHttpFetch, StripeHttpRequest } from "../api";

/**
 * Test material for Stripe's rail: a known signing secret, a real HMAC over real bytes, and a transport that
 * answers the way Stripe's API does.
 *
 * Stripe's authenticity proof is symmetric — the same secret signs and verifies — so a test can produce a
 * genuinely valid `Stripe-Signature` header rather than stubbing the verifier. That is the whole point: the
 * negative cases below are real failures of real cryptography. A tampered body produces a signature that does
 * not match because the bytes changed, not because a mock was told to say no.
 *
 * The recorded event payloads live beside this module as JSON, unsigned, because a signature is over the exact
 * bytes a test sends — so it must be computed at send time and cannot be recorded.
 *
 * This module signs; the shipped code only verifies. That is why it lives under `fixtures/`.
 */

/**
 * The signing secret every Stripe suite uses. Shaped like Stripe's own (`whsec_` + base64-ish) so a test that
 * accidentally logged it would be recognizable, and obviously fake so nobody mistakes it for a real one.
 */
export const STRIPE_TEST_WEBHOOK_SECRET = "whsec_pithyTestSigningSecretNotARealOne00";

/** The secret key the API fixtures pretend to call Stripe with. Test-mode shaped, and not a real key. */
export const STRIPE_TEST_SECRET_KEY = "sk_test_pithyTestKeyNotARealOne00";

/** What a test varies about the signature header. */
export interface StripeSignatureOptions {
  /** The signing secret. The suite's own unless a case is proving a wrong one is refused. */
  secret?: string;
  /** The timestamp the header claims and the signature covers. Defaults to the clock the case passes in. */
  timestamp?: Date;
  /** The scheme label. `v1` unless a case is proving an unknown scheme is not accepted. */
  scheme?: string;
  /** Extra signature values to list before the real one — how Stripe presents a secret mid-rotation. */
  extra?: readonly string[];
}

/** Hex, lower case — the encoding Stripe puts a `v1` signature in. */
function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Sign a body the way Stripe signs a webhook delivery: HMAC-SHA256 over `<timestamp>.<body>`, keyed with the
 * endpoint's signing secret, presented as `t=<timestamp>,v1=<hex>`.
 *
 * The timestamp is inside the signed payload as well as beside it, which is what makes the replay window real:
 * a delivery cannot be re-dated without invalidating its own signature.
 */
export async function stripeSignatureHeader(
  body: string,
  now: Date,
  options: StripeSignatureOptions = {},
): Promise<string> {
  const timestamp = Math.floor((options.timestamp ?? now).getTime() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret ?? STRIPE_TEST_WEBHOOK_SECRET) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`) as unknown as ArrayBuffer),
  );
  const values = [...(options.extra ?? []), hex(signature)];
  return [`t=${timestamp}`, ...values.map((value) => `${options.scheme ?? "v1"}=${value}`)].join(",");
}

/** One recorded outbound call, so a suite can assert what left the Worker and not only what came back. */
export interface StripeRecordedCall {
  /** The full URL, query string included. */
  url: string;
  /** The request as the transport received it. */
  init?: StripeHttpRequest;
}

/** What the stub answers with. A status alone is a failure; a body alone is a 200. */
export interface StripeStubAnswer {
  /** The status to answer with. 200 unless a case is proving a failure path. */
  status?: number;
  /** The JSON body. Absent answers `{}`. */
  body?: unknown;
}

/**
 * A transport that answers Stripe's endpoints from a table keyed on a path fragment, recording every call.
 *
 * A fragment rather than a full URL because a retrieve carries an id and a query string, and a test that had to
 * spell those out would be asserting its own string building. An unmatched call is a 404, which is the honest
 * answer for an endpoint the case did not stub.
 */
export function stripeStubTransport(
  answers: Record<string, StripeStubAnswer>,
  calls: StripeRecordedCall[] = [],
): StripeHttpFetch {
  return async (url, init) => {
    calls.push({ url, init });
    const matched = Object.entries(answers).find(([fragment]) => url.includes(fragment))?.[1];
    const status = matched?.status ?? (matched === undefined ? 404 : 200);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(matched?.body ?? {}),
    };
  };
}
