// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import { APPLE_ROOT_CERTIFICATES } from "./certs";
import { decodeBase64, decodeBase64Url } from "./der";
import { verifyCertificateChain } from "./x509";

/**
 * App Store Server Notification V2 signature verification — the authenticity boundary on Apple's webhook,
 * and on every transaction a client submits.
 *
 * Apple signs its notifications and transactions as compact JWS, carrying the whole issuing certificate
 * chain in the header's `x5c`. Verifying one means three things, in this order, and the order matters:
 *
 * 1. **Pin the algorithm before touching the key.** `alg` is attacker-controlled — it is in a header nobody
 *    has verified yet — so it is parsed against a literal `ES256` rather than looked up in a table. That is
 *    what makes the two published confusions unreachable: `none`, which asks for the signature to be
 *    skipped, and `HS256`, which asks the verifier to HMAC using the public key it just found in the
 *    header as if it were a shared secret. Neither survives a literal.
 * 2. **Verify the chain, not the leaf.** `x5c` is a claim, not evidence. The chain must link, every window
 *    must contain the clock, and the root must be one shipped in `certs.ts` — see `x509.ts`.
 * 3. **Verify the signature with the leaf's key, over the exact received bytes** — `header.payload` as
 *    encoded, not re-serialized. A JSON round-trip would reorder keys and change what was signed.
 *
 * `alg: ES256` also fixes the curve at P-256, so a P-384 leaf under an ES256 header is refused. That is the
 * same confusion one layer down, and checking only the string would let it through.
 *
 * The payload is returned as `unknown`. Verification proves who sent the bytes, never what they mean, so
 * the caller Zod-parses. Handing back a typed object here would blur the two.
 */

/**
 * The JWS header, exactly as tightly as it can be. `alg` is a literal for the reason above; `x5c` must be
 * at least two certificates because a single one would be trusted on its own word.
 */
const AppleJwsHeader = z
  .object({
    alg: z
      .literal("ES256")
      .describe(
        "The signing algorithm. A literal, not a lookup: `alg` arrives in an unverified header, and accepting `none` or `HS256` from it is how JWS verifiers are bypassed.",
      ),
    x5c: z
      .array(z.string().min(1).describe("One certificate, base64-encoded DER."))
      .min(2)
      .describe(
        "The issuing certificate chain, leaf first and root last. A claim rather than evidence — every link is verified and the root must be one pinned in certs.ts.",
      ),
  })
  .describe("The header of an Apple-signed JWS, constrained to the one shape Apple sends.");

/** Which roots to trust and what clock to judge certificate validity against. */
export interface VerifyAppleJwsOptions {
  /** base64 DER of every acceptable root. Defaults to the pinned Apple roots. */
  roots?: readonly string[];
  /** The clock. Injected so a certificate-window refusal is deterministic in tests. */
  now?: Date;
}

/**
 * Verify a compact JWS against Apple's pinned certificate chain and return its decoded payload.
 *
 * Throws `payments/invalid_receipt` when the JWS is malformed — wrong segment count, a header Apple would
 * never send, an unreadable certificate — and `payments/verification_failed` when it is well-formed but
 * does not verify. Both are 400s; the distinction is for the operator reading `detail`, and the webhook
 * guard maps either to `payments/webhook_unverified` on its own path.
 */
export async function verifyAppleJws(jws: string, options: VerifyAppleJwsOptions): Promise<unknown> {
  const segments = jws.split(".");
  if (segments.length !== 3) {
    throw new PaymentsInvalidReceiptError({ detail: `JWS: ${segments.length} segments, expected 3.` });
  }
  const [head, body, mac] = segments as [string, string, string];
  // An empty signature segment is `alg: none` expressed structurally. Refused before anything is decoded.
  if (head.length === 0 || body.length === 0 || mac.length === 0) {
    throw new PaymentsInvalidReceiptError({ detail: "JWS: a segment is empty; an unsigned token is not accepted." });
  }

  const header = AppleJwsHeader.safeParse(decodeJson(head, "header"));
  if (!header.success) {
    throw new PaymentsInvalidReceiptError({
      detail: `JWS: header rejected — ${header.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`).join(", ")}.`,
    });
  }

  const leaf = await verifyCertificateChain(header.data.x5c.map(decodeBase64), {
    roots: options.roots ?? APPLE_ROOT_CERTIFICATES,
    now: options.now ?? new Date(),
  });
  // ES256 is P-256 with SHA-256. The header claimed ES256; if the leaf is on another curve the two
  // disagree, and the header is the half that cannot be trusted.
  if (leaf.curve !== "P-256") {
    throw new PaymentsVerificationFailedError({
      detail: `JWS: header claims ES256 but the leaf certificate is on ${leaf.curve}.`,
    });
  }

  const signed = new TextEncoder().encode(`${head}.${body}`);
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    leaf.key,
    decodeBase64Url(mac) as unknown as ArrayBuffer,
    signed as unknown as ArrayBuffer,
  );
  if (!verified) {
    throw new PaymentsVerificationFailedError({ detail: "JWS: the signature does not match the signed segments." });
  }

  return decodeJson(body, "payload");
}

/** One base64url JSON segment. `unknown` out — a verified byte string is not yet a known shape. */
function decodeJson(segment: string, label: string): unknown {
  const text = new TextDecoder().decode(decodeBase64Url(segment));
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    // Never echo the text: on the client-submission path it is caller-supplied.
    throw new PaymentsInvalidReceiptError({ detail: `JWS: ${label} is not JSON.` }, { cause });
  }
}
