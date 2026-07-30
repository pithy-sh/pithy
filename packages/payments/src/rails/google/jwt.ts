import { PaymentsInvalidReceiptError, PaymentsRailNotConfiguredError } from "../../error/errors";

/**
 * The JWT primitives Google's two token jobs share.
 *
 * Google's rail is the only one that both **verifies** a JWT and **signs** one. It verifies the OIDC token a
 * Pub/Sub push carries, which is what proves a notification came from Google; it signs a service-account
 * assertion, which is what buys the access token the Play Developer API demands. Both are compact JWS, so
 * both need base64url in both directions — and the shipped Apple modules need it in one direction only,
 * because Apple hands us signed data and never asks us to sign any.
 *
 * That is why these live here rather than being taken from `rails/apple/der.ts`: that module is an ASN.1
 * reader whose refusals carry DER offsets, it has no encoder, and a Google module reaching into an Apple one
 * would make the rails depend on each other rather than on the shared contract. Small, local, and named for
 * the rail that uses it.
 *
 * **Every input here is hostile.** A push token arrives in an unauthenticated request — verifying it is the
 * whole point — so a malformed segment is refused rather than coerced, and no refusal echoes the bytes it
 * refused. A token is a bearer artifact and `detail` reaches logs.
 */

/** Bytes from one base64url segment. `label` names the segment, so a refusal says which one failed. */
export function base64UrlDecode(value: string, label: string): Uint8Array {
  // Zero bytes is never a valid segment. An empty signature is `alg: none` expressed structurally, and
  // decoding it to an empty buffer would hand a verifier something to compare against nothing.
  if (value.length === 0) throw malformed(`${label} is empty; an unsigned token is not accepted.`);
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch (cause) {
    throw malformed(`${label} is not valid base64url.`, cause);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** One base64url segment from bytes — the unpadded URL alphabet a JWS is assembled from. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** The three segments of a compact JWT, as received. Kept as strings: a signature covers the exact bytes. */
export interface JwtSegments {
  /** The base64url header, still encoded. */
  head: string;
  /** The base64url claim set, still encoded. */
  body: string;
  /** The base64url signature, still encoded. */
  mac: string;
}

/**
 * Split a compact JWT, refusing anything that is not three non-empty segments.
 *
 * The empty-segment check is the structural half of the algorithm pin: `alg: none` produces a header, a
 * payload, and nothing after the final dot, so it is refused here before any header is even decoded.
 */
export function splitJwt(token: string): JwtSegments {
  const segments = token.split(".");
  if (segments.length !== 3) throw malformed(`the token has ${segments.length} segments, expected 3.`);
  const [head, body, mac] = segments as [string, string, string];
  if (head.length === 0 || body.length === 0 || mac.length === 0) {
    throw malformed("a token segment is empty; an unsigned token is not accepted.");
  }
  return { head, body, mac };
}

/** One base64url JSON segment. `unknown` out — decoded bytes are not yet a known shape. */
export function decodeJwtJson(segment: string, label: string): unknown {
  const text = new TextDecoder().decode(base64UrlDecode(segment, label));
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    // Never echo the text. On the push path it is attacker-supplied, and `detail` reaches an operator's logs.
    throw malformed(`${label} is not JSON.`, cause);
  }
}

/** The PEM armour of a PKCS#8 private key — the only form `crypto.subtle.importKey("pkcs8", …)` reads. */
const PKCS8_HEADER = "-----BEGIN PRIVATE KEY-----";

/**
 * PKCS#8 DER from the PEM a Google service-account key file carries.
 *
 * Two accommodations, both earned. Escaped `\n` sequences are honoured because the key lives inside the
 * downloaded JSON as a single line and arrives that way whenever a credential is moved by hand — refusing it
 * would read as a bug in us. And a PKCS#1 body (`BEGIN RSA PRIVATE KEY`) is named rather than passed on,
 * because WebCrypto's answer to one is an opaque `DataError` with nothing an operator can act on.
 *
 * A bad key is `payments/rail_not_configured`: from a caller's side the rail genuinely is not available, and
 * a credential that cannot be read is a provisioning failure rather than a store outage.
 */
export function pemPrivateKey(pem: string): Uint8Array {
  const text = pem.replaceAll("\\n", "\n");
  if (!text.includes(PKCS8_HEADER)) {
    throw new PaymentsRailNotConfiguredError({
      detail: text.includes("PRIVATE KEY")
        ? "Google: the service-account private key is not PKCS#8. Use the `private_key` field of the downloaded JSON key file, which begins `-----BEGIN PRIVATE KEY-----`."
        : "Google: the service-account private key carries no PEM armour. Store the `private_key` field of the downloaded JSON key file verbatim.",
    });
  }
  const body = text
    .slice(text.indexOf(PKCS8_HEADER) + PKCS8_HEADER.length)
    .replace(/-----END PRIVATE KEY-----[\s\S]*$/, "")
    .replaceAll(/\s+/g, "");
  try {
    // The decoder maps `-`/`_` onto `+`/`/` and leaves the standard alphabet alone, so a PEM body — which is
    // standard base64 — decodes through it unchanged. One decoder, one refusal path.
    return base64UrlDecode(body, "the service-account private key");
  } catch (cause) {
    throw new PaymentsRailNotConfiguredError(
      { detail: "Google: the service-account private key's PEM body is not valid base64." },
      { cause },
    );
  }
}

/** A structural refusal. `Google:` prefixed so a log line says which rail failed to read something. */
function malformed(detail: string, cause?: unknown): PaymentsInvalidReceiptError {
  return new PaymentsInvalidReceiptError({ detail: `Google: ${detail}` }, cause === undefined ? undefined : { cause });
}
