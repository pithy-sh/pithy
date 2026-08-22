// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PaymentsVerificationFailedError } from "../../error/errors";

/**
 * Paddle's authenticity proof: a timestamp and one or more HMACs, in one header.
 *
 * `Paddle-Signature: ts=1770000000;h1=5257a8…` — elements split on `;`, key and value split on `=`, and
 * the signed payload is the timestamp, **a colon**, and the exact received body. HMAC-SHA256, hex,
 * keyed with the notification destination's `pdl_ntfset_…` secret.
 *
 * ## Why this is a second verifier and not a widened core primitive
 *
 * The issue that scoped this work said Paddle "fits the existing timestamped shape of
 * `requireSignedWebhook` with no new scheme." It does not, and the difference is two characters that
 * decide whether anything is verified at all. `packages/core/src/http/signedWebhook.ts` splits the header
 * on `,` and builds its signed payload as `` `${timestamp}.${body}` `` — Stripe's format. Paddle uses `;`
 * and `:`. Neither is a parameter, and the module doc there argues *deliberately* that the signed payload
 * must never become a caller-supplied template, because a payload a caller can shape is a payload a caller
 * can shape into one that matches.
 *
 * So there were two options, and this is the one taken out loud: generalize the core primitive — editing a
 * package this issue does not scope, against its own written reasoning — or write the scheme here, as the
 * Lemon Squeezy rail already did for its own. This is the sibling precedent, and it keeps the change inside
 * `@pithy-sh/payments`.
 *
 * The cost is real and worth naming: two modules now know how to check an HMAC. What they do not share is
 * a *format*, which is the part that would have had to become configurable, and a configurable format is
 * how #125 shipped a `requireSignedWebhook("lemonSqueezy", …)` that structurally could not verify the
 * signatures it claimed to.
 *
 * ## The freshness window, and why it is 300 seconds and not 5
 *
 * Paddle's own SDKs default to five seconds. This defaults to three hundred, and the reason is what
 * replay protection actually rests on here: `UNIQUE (rail, providerEventId)` over `evt_…`, in the webhook
 * guard, which is absolute. A captured delivery replayed a year later is refused because its event id is
 * already recorded — no window is doing that work. What a five-second window *does* do is convert ordinary
 * clock skew between a Cloudflare edge and Paddle into a dropped renewal.
 *
 * The window still earns its place, in both directions. It bounds how long a captured-but-never-delivered
 * signature stays usable, and it refuses a far-future timestamp — either a broken clock or somebody trying
 * to mint a delivery that never goes stale. Configurable, so an adopter who wants Paddle's number can set
 * it.
 *
 * Paddle re-signs each retry attempt with a fresh `ts`, which is the only way a three-day retry window and
 * a five-second SDK tolerance could both be coherent — so the window does not silently reject retries.
 *
 * ## What a refusal says
 *
 * `payments/verification_failed`, with the reason in `detail` and nothing the delivery carried — not the
 * body, not the candidate signature, never the secret. The webhook guard maps this to
 * `payments/webhook_unverified` (401) before anything reaches the sender, so a forger learns only that it
 * failed.
 */

/** The header Paddle puts its proof in. Lower case, because that is how Hono presents a header name. */
export const PADDLE_SIGNATURE_HEADER = "paddle-signature";

/** How long a delivery stays acceptable, by default. See the module doc for why this is not Paddle's 5. */
export const PADDLE_DEFAULT_FRESHNESS_SECONDS = 300;

/** How many bytes an HMAC-SHA256 is. A candidate of any other length cannot be one, whatever it decodes to. */
const HMAC_SHA256_BYTES = 32;

/**
 * How many `h1` values a header may list.
 *
 * Paddle lists more than one only while a destination's secret is being rotated, which pairs the old and
 * the new — so two is the real number and this is generous. It is bounded at all because each listed
 * candidate costs an HMAC: unbounded, the header would be a free way to make this Worker do arbitrary
 * work. Core's primitive caps its own list for the same reason.
 */
const MAX_SIGNATURES = 5;

/** Why a delivery was refused. Three members: this scheme carries a timestamp, so `stale` is real here. */
type PaddleRefusal = "unreadable" | "stale" | "unmatched";

/** What the verifier needs beyond the bytes: the secret, the clock, and the window. */
export interface VerifyPaddleSignatureOptions {
  /** The notification destination's signing secret — `pdl_ntfset_…`. Never logged. */
  secret: string;
  /** The clock, for the freshness window. Injected so verification is deterministic. */
  now: Date;
  /** How many seconds either side of `now` a delivery may be dated. Undefined uses the default. */
  toleranceSeconds?: number;
}

/** One parsed header: when Paddle says it signed, and every candidate MAC it listed. */
interface ParsedSignature {
  /** The `ts` value, as seconds since the epoch. */
  timestamp: number;
  /** Every `h1` value, decoded. */
  candidates: Uint8Array[];
}

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
 * The signature Paddle would send for these bytes at this second — lower-case hex.
 *
 * Exported for the tests and the fixtures, which mint their own so verification is exercised for real
 * rather than stubbed. Nothing in the request path signs anything: this rail only ever verifies.
 */
export async function signPaddleBody(timestamp: number, body: string, secret: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret, "sign"),
    // The colon, and it is the whole difference from Stripe's scheme. A period here would produce a MAC
    // that never matches, and a verifier that never matches is a rail that never receives a webhook.
    new TextEncoder().encode(`${timestamp}:${body}`),
  );
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse the header into a timestamp and its candidate MACs, or `undefined` when it is not one.
 *
 * Strict about shape on purpose. Everything here is attacker-controlled text, and a lenient parse is how
 * a verifier ends up comparing an empty candidate against an empty expectation and returning happily.
 */
function parse(header: string): ParsedSignature | undefined {
  let timestamp: number | undefined;
  const candidates: Uint8Array[] = [];

  for (const element of header.split(";")) {
    const at = element.indexOf("=");
    if (at <= 0) continue;
    const key = element.slice(0, at).trim();
    const value = element.slice(at + 1).trim();
    if (value === "") continue;

    if (key === "ts") {
      // The first `ts` wins, and a second one is not merged: a header listing two timestamps is not a
      // shape Paddle produces, and picking either would be guessing at what was signed.
      if (timestamp !== undefined) return undefined;
      if (!/^\d+$/.test(value)) return undefined;
      timestamp = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(timestamp)) return undefined;
      continue;
    }

    if (key === "h1") {
      // Refused rather than truncated. Silently taking the first five of a hundred would leave a header
      // that costs bounded work and reads as accepted, which hides the abuse it exists to stop.
      if (candidates.length >= MAX_SIGNATURES) return undefined;
      const bytes = hexBytes(value);
      if (bytes === undefined || bytes.length !== HMAC_SHA256_BYTES) return undefined;
      candidates.push(bytes);
    }
  }

  if (timestamp === undefined || candidates.length === 0) return undefined;
  return { timestamp, candidates };
}

/**
 * Verify one delivery's `Paddle-Signature`. Resolves when Paddle signed these exact bytes at a moment
 * inside the window, and throws `payments/verification_failed` otherwise.
 *
 * The comparison is `crypto.subtle.verify`, never `===` on the hex and never a hand-written loop: the
 * runtime's own compare is constant-time, and a string equality on a MAC leaks how many leading bytes an
 * attacker got right.
 *
 * The freshness check runs **before** the MACs. A stale delivery is refused whatever it carries, and
 * refusing it first means an expired capture does not buy an attacker even one HMAC of work.
 */
export async function verifyPaddleSignature(
  body: string,
  header: string | null,
  options: VerifyPaddleSignatureOptions,
): Promise<void> {
  const parsed = header === null ? undefined : parse(header.trim());
  if (parsed === undefined) throw new PaymentsVerificationFailedError({ detail: refusal("unreadable") });

  const tolerance = options.toleranceSeconds ?? PADDLE_DEFAULT_FRESHNESS_SECONDS;
  const drift = Math.abs(Math.floor(options.now.getTime() / 1000) - parsed.timestamp);
  if (drift > tolerance) throw new PaymentsVerificationFailedError({ detail: refusal("stale") });

  // The timestamp is inside the signed message, so a captured signature cannot be re-dated to slip
  // through the window above: editing `ts` breaks the MAC checked here.
  const key = await signingKey(options.secret, "verify");
  const message = new TextEncoder().encode(`${parsed.timestamp}:${body}`);
  for (const candidate of parsed.candidates) {
    if (await crypto.subtle.verify("HMAC", key, candidate, message)) return;
  }
  throw new PaymentsVerificationFailedError({ detail: refusal("unmatched") });
}

/**
 * This rail's wording for its three refusals.
 *
 * Prefixed `Paddle:` because a payments Worker composes several rails and `detail` is what an operator
 * reads to find out which one refused. The strings say what failed and what to check, and nothing the
 * delivery carried — `detail` reaches a log, and a forger must not be able to write into one.
 */
function refusal(reason: PaddleRefusal): string {
  switch (reason) {
    case "unreadable":
      return "Paddle: the delivery carries no Paddle-Signature header of the form ts=<seconds>;h1=<64 hex chars>.";
    case "stale":
      return "Paddle: the delivery's ts is outside the freshness window. Check this Worker's clock, or widen `paddle.webhookFreshnessSeconds`.";
    case "unmatched":
      return "Paddle: no h1 matches an HMAC-SHA256 of `ts:body` under the configured signing secret. Check that the secret belongs to this notification destination and this environment.";
  }
}
