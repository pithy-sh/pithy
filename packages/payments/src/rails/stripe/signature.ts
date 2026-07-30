import { PaymentsVerificationFailedError } from "../../error/errors";

/**
 * Stripe's authenticity proof: an HMAC over the exact received bytes, dated, in one header.
 *
 * `Stripe-Signature: t=1768435200,v1=5257a8…` — the timestamp the delivery claims, then one hex HMAC-SHA256 per
 * active signing secret, each computed over `<timestamp>.<body>` and keyed with the endpoint's `whsec_…`.
 *
 * ## Why the timestamp is checked, and why it cannot be bypassed
 *
 * A signature with no freshness window is valid forever: anybody who captures one delivery can replay it for as
 * long as the secret lives. For payments that is not abstract — a captured `customer.subscription.updated` replayed
 * months later is a state claim about a subscription that has since lapsed, and the projection's monotonic rule
 * would correctly ignore it *only because* the stored event time is newer. Relying on that would make the window a
 * happy accident of another rule.
 *
 * So the tolerance is enforced here, and it is real because **the timestamp is inside the signed payload**. Re-dating
 * a captured delivery to escape the window invalidates its own signature, which is why this is a boundary rather
 * than a suggestion. Five minutes is Stripe's own default and is generous against delivery latency and clock skew.
 * The window is checked in both directions: a timestamp far in the future is a clock problem or a crafted one, and
 * neither is a delivery to act on.
 *
 * ## Why the comparison is `crypto.subtle.verify`
 *
 * Comparing HMACs with `===` leaks how many leading bytes matched, and a leak like that is enough to forge a
 * signature one byte at a time given enough attempts. WebCrypto's `verify` does the comparison itself, in constant
 * time, in the platform — so the constant-time requirement is met by not hand-writing the compare at all. Every
 * listed `v1` is tried, because Stripe lists one per active secret while an endpoint's secret is being rotated, and
 * refusing a delivery whose second signature matched would drop every event for the length of the rotation.
 *
 * ## What a refusal says
 *
 * `payments/verification_failed`, with the reason in `detail` and nothing else. Never the secret, never the body,
 * never the signature: `detail` reaches an operator's log, and the webhook guard maps this to
 * `payments/webhook_unverified` (401) before anything reaches the sender — a forger learns only that it failed.
 */

/** The header Stripe puts its proof in. Lower case, because that is how Hono presents a header name. */
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

/** How far a delivery's own timestamp may be from now. Stripe's default, and generous against clock skew. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The one signature scheme this build accepts. `v0` is Stripe's thin-event variant and proves nothing here. */
const ACCEPTED_SCHEME = "v1";

/** HMAC-SHA256 — the only algorithm Stripe signs a webhook with. Pinned as a literal, never read from input. */
const HMAC_SHA256 = { name: "HMAC", hash: "SHA-256" } as const;

/** The byte length of an HMAC-SHA256 signature. A candidate of any other length cannot be one. */
const SIGNATURE_BYTES = 32;

/** A parsed `Stripe-Signature` header: when the delivery says it was signed, and with what. */
export interface StripeSignatureHeader {
  /** The `t` value, in seconds since the epoch. Part of the signed payload as well as of the header. */
  timestamp: number;
  /** Every `v1` value, in the order listed. One per active signing secret during a rotation. */
  signatures: readonly string[];
}

/** What verification needs beyond the bytes: the clock, and how wide the freshness window is. */
export interface VerifyStripeSignatureOptions {
  /** The clock. Injected so the replay window is deterministic in tests rather than wall-clock dependent. */
  now: Date;
  /** The freshness window, in seconds. Defaults to {@link STRIPE_SIGNATURE_TOLERANCE_SECONDS}. */
  toleranceSeconds?: number;
}

/**
 * Read a `Stripe-Signature` header, or `undefined` when it is not one.
 *
 * Undefined rather than a throw for every unreadable shape, because the caller turns them all into one refusal:
 * distinguishing "no `t`" from "no `v1`" would describe our parser to a sender, and neither is actionable by
 * anyone but an operator reading the endpoint's configuration.
 *
 * Unknown schemes are dropped rather than refused. Stripe already sends `v0` alongside `v1` for thin Connect
 * events and may add another after this package shipped, and a delivery whose `v1` is good is authentic whatever
 * else it carries. A header carrying *only* unknown schemes has proved nothing, so it yields undefined.
 */
export function parseStripeSignatureHeader(header: string): StripeSignatureHeader | undefined {
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      // A decimal integer and nothing else. `Number("")` is 0 and `Number("1.5")` is a float, and both would
      // otherwise pass into the window comparison as a plausible-looking date.
      if (!/^\d+$/.test(value)) return undefined;
      timestamp = Number(value);
    } else if (key === ACCEPTED_SCHEME) {
      signatures.push(value);
    }
  }

  if (timestamp === undefined || signatures.length === 0) return undefined;
  return { timestamp, signatures };
}

/**
 * Verify one delivery's `Stripe-Signature`. Resolves when Stripe signed these exact bytes inside the window, and
 * throws `payments/verification_failed` otherwise.
 */
export async function verifyStripeSignature(
  body: string,
  header: string | null,
  secret: string,
  options: VerifyStripeSignatureOptions,
): Promise<void> {
  const parsed = header === null ? undefined : parseStripeSignatureHeader(header);
  if (parsed === undefined) {
    throw new PaymentsVerificationFailedError({
      detail: "Stripe: the delivery carries no readable Stripe-Signature header with a t= timestamp and a v1= HMAC.",
    });
  }

  const tolerance = options.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  const skew = Math.abs(Math.floor(options.now.getTime() / 1000) - parsed.timestamp);
  if (skew > tolerance) {
    throw new PaymentsVerificationFailedError({
      detail: `Stripe: the delivery is dated ${skew}s from now, outside the ${tolerance}s tolerance. Check this Worker's clock, or a replayed delivery.`,
    });
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as ArrayBuffer,
    HMAC_SHA256,
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${parsed.timestamp}.${body}`) as unknown as ArrayBuffer;

  for (const candidate of parsed.signatures) {
    const bytes = hexBytes(candidate);
    // A candidate that is not 32 bytes of hex cannot be an HMAC-SHA256, so it is skipped rather than refused —
    // another entry in the same header may still be the good one.
    if (bytes === undefined || bytes.length !== SIGNATURE_BYTES) continue;
    if (await crypto.subtle.verify(HMAC_SHA256.name, key, bytes as unknown as ArrayBuffer, signed)) return;
  }

  throw new PaymentsVerificationFailedError({
    detail:
      "Stripe: no signature in the Stripe-Signature header matches these bytes under the configured signing secret. Check that the secret belongs to this endpoint and this environment.",
  });
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
