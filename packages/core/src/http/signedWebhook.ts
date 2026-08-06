// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MiddlewareHandler } from "hono";
import type { PithyHonoEnv } from "../capability/capability";
import { InternalError, WebhookUnverifiedError } from "../error/pithyError";

/**
 * The `signed-webhook` strategy, for any sender. Secret, header name, tolerance and the exact received
 * bytes in; verified, or a `PithyError`, out.
 *
 * `signed-webhook` has been a first-class strategy in {@link ./verification.VerificationStrategy} since the
 * contract landed, but the only implementation was `@pithy-sh/payments`' webhook guard — welded to a rail
 * catalog, a D1 table and a dedup insert, because it also records deliveries. So an adopter declaring the
 * strategy on their own route had the word and nothing to put behind it. This is the word's implementation,
 * and `@pithy-sh/payments`' Stripe rail is now one of its callers rather than a second copy of it.
 *
 * **Dedup and persistence stay the caller's**: at-least-once delivery is a property of the sender, not of the
 * signature, and a verifier that also owned a table could not be composed by anyone whose table differs. Say
 * the consequence plainly, because it is a security property and not only an availability one: this proves a
 * delivery is authentic and fresh, never that it is *new*. Inside the tolerance a captured delivery replays
 * as many times as it is sent. A handler that grants, charges, or deletes needs its own uniqueness key —
 * payments spends a `UNIQUE (rail, providerEventId)` insert on exactly this.
 *
 * ## The scheme
 *
 * One header carries both halves of the proof: `<header>: t=1785931200,v1=5257a8…` — the timestamp the
 * delivery claims, then one hex HMAC-SHA256 per signature, each computed over `<timestamp>.<body>`. Stripe's
 * format, deliberately, because it is the one every other sender copied and because it gets the four things
 * below right. The key names are options — a sender writing `v0` costs one line — but the signed payload is
 * fixed. A caller-supplied template would be the one part of the scheme that must be byte-identical at both
 * ends, and getting it wrong yields a verifier that verifies nothing while still returning.
 *
 * ## Why the timestamp is inside the signed payload
 *
 * A signature with no freshness window is valid forever: whoever captures one delivery can replay it for as
 * long as the secret lives. The window only closes that if it cannot be stepped around — and it cannot,
 * because the timestamp is part of what was signed. Re-dating a captured delivery to escape the window
 * invalidates its own signature. A timestamp in a second header, or alongside the signature but outside it,
 * would be a suggestion.
 *
 * The window is checked in **both** directions. A delivery dated far in the future is a clock problem or a
 * crafted one, and neither is a delivery to act on; accepting it would also hand a forger an unbounded replay
 * window the moment a secret leaks.
 *
 * ## Why the comparison is `crypto.subtle.verify`
 *
 * Comparing HMACs with `===` leaks how many leading bytes matched, and that leak is enough to forge a
 * signature one byte at a time given enough attempts. WebCrypto's `verify` does the comparison itself, in
 * constant time, in the platform — so the requirement is met by not hand-writing the compare at all.
 * (`timingSafeEqual` in `../controlPlane/token/digest` is the string equivalent, for values WebCrypto will
 * not compare for you.) Every listed signature is tried, because a sender rotating its secret signs with each
 * active one, and refusing a delivery whose second signature matched would drop every delivery for the length
 * of the rotation.
 *
 * ## What a refusal says
 *
 * `core/webhook_unverified`, 401, one code for every failing step. The step goes in `detail`, which the HTTP
 * codec strips — so an operator reading a log learns which check refused it and the sender learns only that
 * something did. **Never the secret, never a signature, never the body.** A refusal is the one message a
 * hostile caller is guaranteed to receive, so it is the last place to echo anything it supplied or anything
 * it is trying to guess.
 *
 * A caller that must word its own refusal — a rail whose own code is part of its contract — calls
 * {@link checkSignedWebhook}, which reports rather than throws. {@link verifySignedWebhook} is that plus the
 * kit's error.
 */

/** How far a delivery's own timestamp may be from now. Stripe's default, and generous against clock skew. */
export const SIGNED_WEBHOOK_TOLERANCE_SECONDS = 300;

/** The header key naming the timestamp, unless a sender names it otherwise. */
const DEFAULT_TIMESTAMP_KEY = "t";

/** The header key naming a signature, unless a sender names it otherwise. */
const DEFAULT_SIGNATURE_KEY = "v1";

/** HMAC-SHA256 — the algorithm this scheme is. Pinned as a literal, never read from the delivery. */
const HMAC_SHA256 = { name: "HMAC", hash: "SHA-256" } as const;

/** The byte length of an HMAC-SHA256 signature. A candidate of any other length cannot be one. */
const SIGNATURE_BYTES = 32;

/**
 * How many candidate signatures one delivery may spend, after the unusable ones are dropped.
 *
 * The list is written by whoever sent the request, and every entry on it costs a full HMAC over the whole
 * body, once per configured secret. Uncapped, a 16 KiB header holds a few hundred well-formed candidates and
 * one anonymous POST buys hundreds of times the CPU a real delivery does — billed CPU, on a runtime with a
 * burst limit. A sender rotating its secret lists two, occasionally three. Eight is far past generous and
 * turns an unbounded multiplier into a constant.
 */
export const SIGNED_WEBHOOK_MAX_CANDIDATES = 8;

/** What the two ends of the scheme must agree on, beyond the secret. */
export interface SignedWebhookScheme {
  /**
   * The header carrying the proof, lower case — that is how Hono presents a header name. Required and
   * never defaulted: a default would be a header some sender happens not to use, read silently.
   */
  header: string;
  /** The header key holding the timestamp. Defaults to `t`. */
  timestampKey?: string;
  /** The header key holding a signature. Defaults to `v1`. */
  signatureKey?: string;
  /** The freshness window, in seconds, either side of now. Defaults to {@link SIGNED_WEBHOOK_TOLERANCE_SECONDS}. */
  toleranceSeconds?: number;
}

/**
 * The secret(s) this endpoint accepts. An array is the receiver's own rotation overlap: both the outgoing and
 * the incoming secret verify until the sender is switched over. `secretsStore(…).getVersions(NAME)` is what
 * feeds it, through `Object.values(secret.versions)` — it returns `{ currentVersion, versions }`, not an array,
 * and only a `valueType: "text"` secret yields strings to pass here. (The sender's rotation is the other
 * axis — several signatures in one header — and needs nothing from the caller.)
 *
 * An entry that resolved to nothing is dropped rather than tried: a blank version is a configuration fault,
 * and WebCrypto refuses a zero-length key with a `DOMException` that would otherwise escape as a 500 whose
 * text names nothing. An endpoint left with no usable secret is reported as the configuration fault it is.
 */
export type SignedWebhookSecret = string | readonly string[];

/** Everything {@link verifySignedWebhook} needs beyond the bytes and the header value. */
export interface VerifySignedWebhookOptions extends SignedWebhookScheme {
  /** The signing secret, or every secret still honoured during a rotation. */
  secret: SignedWebhookSecret;
  /** The clock. Injectable so the freshness window is deterministic in tests rather than wall-clock dependent. */
  now?: Date;
}

/** Everything {@link requireSignedWebhook} needs, as a route wears it. */
export interface SignedWebhookGuardOptions extends SignedWebhookScheme {
  /**
   * The secret, or a resolver reading it from the Worker env at the point of need. A guard is built at
   * module scope and `env` only exists per request, so a secret read through `@pithy-sh/secrets` can only
   * arrive as the second form — and reading it per request is also what makes a rotation take effect
   * without a deploy.
   */
  secret: SignedWebhookSecret | ((env: Record<string, unknown>) => SignedWebhookSecret | Promise<SignedWebhookSecret>);
  /** The clock, for the freshness window. Injected so tests are deterministic. */
  now?: () => Date;
}

/** A parsed proof header: when the delivery says it was signed, and with what. */
export interface SignedWebhookHeader {
  /** The timestamp value, in seconds since the epoch. Part of the signed payload as well as of the header. */
  timestamp: number;
  /** Every signature value, in the order listed. One per secret the sender currently signs with. */
  signatures: readonly string[];
}

/**
 * Read a proof header, or `undefined` when it is not one.
 *
 * Undefined rather than a throw per unreadable shape, because the caller turns them all into one refusal:
 * distinguishing "no timestamp" from "no signature" would describe our parser to a sender, and neither is
 * actionable by anyone but an operator reading the endpoint's configuration.
 *
 * Unknown keys are dropped rather than refused. A sender may list a scheme this build does not know — Stripe
 * sends `v0` beside `v1` — and a delivery whose known signature is good is authentic whatever else it
 * carries. A header carrying *only* unknown keys has proved nothing, so it yields undefined.
 *
 * The timestamp is the exception: it is read strictly, once, and only in the exact spelling it was signed in.
 * Two of them is a header that has not said when it was signed, and taking the last is how a parser and a
 * sender come to disagree about what was covered. A non-canonical one (`00178…`) could never verify either,
 * because the bytes signed are the digits the sender wrote — refusing it here names the digit rather than
 * sending an operator after a rotated secret.
 */
export function parseSignedWebhookHeader(
  header: string,
  timestampKey: string,
  signatureKey: string,
): SignedWebhookHeader | undefined {
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === timestampKey) {
      // A canonical decimal integer and nothing else. `Number("")` is 0 and `Number("1.5")` is a float, and
      // both would otherwise pass into the window comparison as a plausible-looking date; a leading zero
      // parses to the right instant but is not the string the signature covers. And a second one is refused
      // rather than overwriting the first.
      if (timestamp !== undefined || !/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
      timestamp = Number(value);
    } else if (key === signatureKey) {
      signatures.push(value);
    }
  }

  if (timestamp === undefined || signatures.length === 0) return undefined;
  return { timestamp, signatures };
}

/**
 * Why a delivery did not verify, for a caller that words its own refusal.
 *
 * Three reasons, because there are three checks. They are for the caller's `detail` and an operator's log,
 * never for the response body: a sender that learns which check refused it learns how close it got.
 */
export type SignedWebhookRefusal =
  /** No header, or one carrying no timestamp and signature this scheme can read. */
  | { reason: "unreadable" }
  /** Read, but dated outside the freshness window — a clock, or a replay. */
  | { reason: "stale"; skew: number; tolerance: number }
  /**
   * Read and fresh, and nothing in it verified.
   *
   * `compared` is how many listed values were actually put to a secret — the candidates left after the ones
   * that cannot be an HMAC-SHA256 are dropped and the cap is applied. Zero is a different finding from the
   * rest: no comparison ran at all, so the answer is the sender's signature format, not the endpoint's
   * secret. A refusal that does not carry the number cannot tell an operator which of the two it is.
   */
  | { reason: "unmatched"; compared: number };

/**
 * Check one delivery, and **report** rather than throw: `undefined` when a holder of the secret signed these
 * exact bytes inside the window, a {@link SignedWebhookRefusal} when nobody did.
 *
 * This is the seam a rail composes. `@pithy-sh/payments` must keep raising `payments/verification_failed`
 * with its own Stripe-worded `detail`, and that is a contract of its own — so the scheme lives here once and
 * each caller keeps its vocabulary, rather than the whole verifier existing twice with two sets of comments
 * to keep in step. Most callers want {@link verifySignedWebhook}.
 *
 * It still throws for **our** failure: an endpoint holding no usable secret, or handed a clock that is not a
 * clock, is a configuration fault rather than a refusal, and every caller reports that the same way.
 *
 * `body` must be the **exact received bytes**. A parsed-and-re-serialized object is different bytes — key
 * order alone changes it — and would never verify.
 */
export async function checkSignedWebhook(
  body: string,
  header: string | null,
  options: VerifySignedWebhookOptions,
): Promise<SignedWebhookRefusal | undefined> {
  const declared = typeof options.secret === "string" ? [options.secret] : options.secret;
  // A version that resolved to nothing is dropped, not tried. `importKey` answers a zero-length key with a
  // raw DOMException, so one blank entry would otherwise take the endpoint down — and *which* entry it was
  // would decide whether it did, because the throw lands before the later, good secret is reached.
  const secrets = declared.filter((secret) => secret.length > 0);
  if (secrets.length === 0) {
    // Not the sender's failure, so not the sender's code. An endpoint holding no secret refuses every
    // delivery, and reporting that as an unverified webhook sends an operator hunting a forger who is not
    // there while the real answer is a secret that never resolved.
    throw new InternalError({
      message: "This webhook endpoint is not configured.",
      action: `Give the ${options.header} guard a signing secret.`,
      detail: `The signed-webhook guard on ${options.header} resolved no signing secret, so it can verify nothing.`,
    });
  }

  const timestampKey = options.timestampKey ?? DEFAULT_TIMESTAMP_KEY;
  const signatureKey = options.signatureKey ?? DEFAULT_SIGNATURE_KEY;
  const parsed = header === null ? undefined : parseSignedWebhookHeader(header, timestampKey, signatureKey);
  if (parsed === undefined) return { reason: "unreadable" };

  const tolerance = options.toleranceSeconds ?? SIGNED_WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  // Fail closed on a clock that is not one. `Math.abs(NaN - t) > tolerance` is false, so an invalid Date would
  // pass the window silently — the one check in this file that could fail open, in the file whose whole
  // argument is that it fails closed. Comparing against a sentinel instead would still be a comparison against
  // a number nobody chose. Only a caller-supplied `now` reaches here as NaN: the header's timestamp is a
  // digit-checked string before it is a number, so this is our fault and takes our code, like the secret above.
  if (!Number.isFinite(nowSeconds)) {
    throw new InternalError({
      message: "This webhook endpoint is not configured.",
      action: `Give the ${options.header} guard a valid clock.`,
      detail: `The signed-webhook guard on ${options.header} was handed a clock that is not a valid Date, so no delivery's freshness can be judged.`,
    });
  }
  const skew = Math.abs(nowSeconds - parsed.timestamp);
  if (skew > tolerance) return { reason: "stale", skew, tolerance };

  // The timestamp is signed with the body. That is what makes the window above a boundary: re-dating a
  // captured delivery changes these bytes, so its captured signature stops matching.
  const signed = new TextEncoder().encode(`${parsed.timestamp}.${body}`) as unknown as ArrayBuffer;
  const candidates = parsed.signatures
    .map(hexBytes)
    // A candidate that is not 32 bytes of hex cannot be an HMAC-SHA256, so it is dropped rather than
    // refused on — another entry in the same header may still be the good one. Dropping before the cap is
    // what keeps a flood of malformed entries from crowding the real signature out of the window.
    .filter((bytes): bytes is Uint8Array => bytes !== undefined && bytes.length === SIGNATURE_BYTES)
    .slice(0, SIGNED_WEBHOOK_MAX_CANDIDATES);

  for (const secret of secrets) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret) as unknown as ArrayBuffer,
      HMAC_SHA256,
      false,
      ["verify"],
    );
    for (const candidate of candidates) {
      if (await crypto.subtle.verify(HMAC_SHA256.name, key, candidate as unknown as ArrayBuffer, signed)) {
        return undefined;
      }
    }
  }

  return { reason: "unmatched", compared: candidates.length };
}

/**
 * The kit's wording for each refusal, in one place — so the guard's early exit says exactly what the full
 * check would have said, rather than a second sentence about the same finding.
 *
 * Every string states what was actually determined and nothing more. `detail` is what an operator reads to
 * decide where to look, and a refusal that asserts a comparison it never ran sends them somewhere else.
 */
function webhookRefusal(refusal: SignedWebhookRefusal, scheme: SignedWebhookScheme): WebhookUnverifiedError {
  const timestampKey = scheme.timestampKey ?? DEFAULT_TIMESTAMP_KEY;
  const signatureKey = scheme.signatureKey ?? DEFAULT_SIGNATURE_KEY;
  switch (refusal.reason) {
    case "unreadable":
      return new WebhookUnverifiedError({
        detail: `The delivery carries no readable ${scheme.header} header with a ${timestampKey}= timestamp and a ${signatureKey}= HMAC.`,
      });
    case "stale":
      return new WebhookUnverifiedError({
        detail: `The delivery is dated ${refusal.skew}s from now, outside the ${refusal.tolerance}s tolerance. Check this Worker's clock, or a replayed delivery.`,
      });
    case "unmatched":
      // Two findings wear one code, and they send an operator to different places. When nothing survived the
      // 32-byte hex filter no secret was ever tried, so naming the secret would be an assertion about a
      // comparison that did not happen — the sender's signature format is what is wrong.
      return new WebhookUnverifiedError({
        detail:
          refusal.compared === 0
            ? `No ${signatureKey}= value in the ${scheme.header} header is 32 bytes of hex, so no signature was compared. Check the sender's signature format.`
            : `Compared ${refusal.compared} signature${refusal.compared === 1 ? "" : "s"} from the ${scheme.header} header against every configured signing secret; none matches these bytes. Check that the secret belongs to this endpoint and this environment.`,
      });
  }
}

/**
 * Verify one delivery. Resolves when a holder of the secret signed these exact bytes inside the window, and
 * throws `core/webhook_unverified` otherwise.
 */
export async function verifySignedWebhook(
  body: string,
  header: string | null,
  options: VerifySignedWebhookOptions,
): Promise<void> {
  const refusal = await checkSignedWebhook(body, header, options);
  if (refusal !== undefined) throw webhookRefusal(refusal, options);
}

/**
 * The `signed-webhook` gate, as a route wears it: `app.post(path, requireSignedWebhook({…}), zValidator("json",
 * Body, validationHook), handler)`.
 *
 * ## Why the header is read before anything else
 *
 * The proof header is the cheapest thing to check and the commonest thing to be missing, so it is checked
 * first. A delivery carrying no readable one is refused whatever the body holds — so resolving the secret (a
 * D1 read and a decrypt) and buffering the body before looking would be unauthenticated work bought by an
 * anonymous POST, on the one route whose whole purpose is to refuse unauthenticated callers.
 *
 * The header is then parsed a second time inside the full check rather than threaded through it. Parsing a
 * short header twice costs nothing; two entry points into the verification, one of them holding a
 * half-verified state, would cost the property that there is exactly one way through this scheme.
 *
 * One consequence, and it is the right one: an endpoint whose secret never resolved answers a proof-less POST
 * with the same 401 every other endpoint gives it, and reports the configuration fault to the first delivery
 * that actually carries a proof. A caller with nothing to verify learns nothing about our configuration.
 *
 * ## Why it reads the body itself, and with `c.req.text()`
 *
 * The proof covers the exact received bytes, so the gate must see what arrived rather than a reconstruction.
 * That is the sanctioned use the Biome plugin leaves open under `src/http/**`: `c.req.json()` is banned,
 * `c.req.text()` is not.
 *
 * `c.req.text()` rather than `c.req.raw.text()`, and the distinction is load-bearing. Hono caches its own
 * body reads and serves `c.req.json()` out of the cached text, so a `zValidator("json", …)` after this gate
 * parses identical bytes. Reading `c.req.raw` would consume the stream and leave the validator with nothing.
 */
export function requireSignedWebhook(options: SignedWebhookGuardOptions): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    const { secret: declared, now, ...scheme } = options;

    // The cheapest possible rejection, ahead of every cost an anonymous caller could otherwise buy.
    const proof = c.req.header(scheme.header) ?? null;
    const readable =
      proof !== null &&
      parseSignedWebhookHeader(
        proof,
        scheme.timestampKey ?? DEFAULT_TIMESTAMP_KEY,
        scheme.signatureKey ?? DEFAULT_SIGNATURE_KEY,
      ) !== undefined;
    if (!readable) throw webhookRefusal({ reason: "unreadable" }, scheme);

    // Resolved per request, at the point of need — never cached in a module variable, never logged.
    const secret = typeof declared === "function" ? await declared(c.env as Record<string, unknown>) : declared;

    // The exact received bytes. Hono caches this read, so the route's json validator sees the same ones.
    const body = await c.req.text();

    await verifySignedWebhook(body, proof, { ...scheme, secret, now: now?.() ?? new Date() });

    await next();
  };
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
