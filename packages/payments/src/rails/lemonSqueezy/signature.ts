// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PaymentsVerificationFailedError } from "../../error/errors";

/**
 * Lemon Squeezy's authenticity proof: a bare HMAC over the exact received bytes, in one header.
 *
 * `X-Signature: 5257a8…` — one hex HMAC-SHA256 of the body, keyed with the webhook's signing secret. No
 * timestamp, no scheme prefix, no list.
 *
 * ## Why this does not go through core's `signed-webhook` primitive
 *
 * That primitive implements Stripe's format — `t=…,v1=…` — and every security property it enforces is a
 * property *of that format*: the freshness window in both directions, the timestamp being inside the signed
 * payload, a cap on how many signatures a header may list. Lemon Squeezy's scheme has none of them to
 * enforce. Generalizing the primitive to carry a scheme would mean giving it a variant whose `now` and
 * `toleranceSeconds` are accepted and ignored, and a parameter a caller can set that changes nothing is
 * worse than no parameter: somebody eventually reads the call site and believes the window is there.
 *
 * So the absence is expressed in the type. {@link verifyLemonSqueezySignature} takes no options bag and no
 * clock — there is nowhere to pass a tolerance, so no call site can claim a window this rail does not
 * honor, and the refusal union below has two members where Stripe's has three. There is no `stale`.
 *
 * ## Where replay protection actually lives
 *
 * Entirely in the webhook guard's `UNIQUE (rail, providerEventId)` insert. A captured delivery replayed a
 * year later carries a signature that is still valid — that is a true fact about this scheme, not a defect
 * in this module — and is refused because its event id is already in `pithy_payments_webhook_events`. The
 * projection's monotonic `providerEventAt` rule is the second line: a replayed state claim about a
 * subscription that has since moved on is staler than the row and is ignored.
 *
 * Worth stating plainly because it is the one property an operator might assume from the other rails and
 * not have here.
 *
 * ## What a refusal says
 *
 * `payments/verification_failed`, with the reason in `detail` and nothing the delivery carried — not the
 * body, not the candidate signature, never the secret. `detail` reaches an operator's log, and the webhook
 * guard maps this to `payments/webhook_unverified` (401) before anything reaches the sender, so a forger
 * learns only that it failed. That code is this rail's contract with its guard.
 */

/** The header Lemon Squeezy puts its proof in. Lower case, because that is how Hono presents a header name. */
export const LEMON_SQUEEZY_SIGNATURE_HEADER = "x-signature";

/** How many bytes an HMAC-SHA256 is. A candidate of any other length cannot be one, whatever it decodes to. */
const HMAC_SHA256_BYTES = 32;

/** Why a delivery was refused. Two members, not Stripe's three — this scheme carries no timestamp to be stale. */
type LemonSqueezyRefusal = "unreadable" | "unmatched";

/** Decode lower- or upper-case hex, or `undefined` when it is not hex at all. */
function hexBytes(value: string): Uint8Array | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Import a signing secret for HMAC-SHA256. */
async function signingKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/**
 * The signature Lemon Squeezy would send for these bytes — lower-case hex.
 *
 * Exported for the tests and the fixtures, which mint their own so verification is exercised for real
 * rather than stubbed. Nothing in the request path signs anything: this rail only ever verifies.
 */
export async function signLemonSqueezyBody(body: string, secret: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await signingKey(secret, "sign"), new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify one delivery's `X-Signature`. Resolves when Lemon Squeezy signed these exact bytes, and throws
 * `payments/verification_failed` otherwise.
 *
 * The comparison is `crypto.subtle.verify`, never `===` on the hex and never a hand-written loop: the
 * runtime's own compare is constant-time, and a string equality on a MAC leaks how many leading bytes an
 * attacker got right.
 */
export async function verifyLemonSqueezySignature(body: string, header: string | null, secret: string): Promise<void> {
  const candidate = header === null ? undefined : hexBytes(header.trim());
  if (candidate === undefined || candidate.length !== HMAC_SHA256_BYTES) {
    throw new PaymentsVerificationFailedError({ detail: refusal("unreadable") });
  }

  const matched = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secret, "verify"),
    candidate,
    new TextEncoder().encode(body),
  );
  if (!matched) throw new PaymentsVerificationFailedError({ detail: refusal("unmatched") });
}

/**
 * This rail's wording for its two refusals.
 *
 * Prefixed `Lemon Squeezy:` because a payments Worker composes several rails and `detail` is what an
 * operator reads to find out which one refused. The strings say what failed and what to check, and nothing
 * the delivery carried.
 */
function refusal(reason: LemonSqueezyRefusal): string {
  return reason === "unreadable"
    ? "Lemon Squeezy: the delivery carries no X-Signature header holding 32 bytes of hex."
    : "Lemon Squeezy: the X-Signature does not match these bytes under the configured signing secret. Check that the secret belongs to this webhook and this store.";
}
