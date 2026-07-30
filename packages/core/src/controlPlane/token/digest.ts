import { base64UrlEncode } from "./base64url";

/**
 * The two primitives the body-binding check needs: hash a request body, then compare that hash to the
 * one the token committed to.
 *
 * Body binding is what stops a verified token being lifted off one call and stapled to another. The
 * signature covers the header and claims, never the body — so the claims carry `bodySha256`, and the
 * Worker recomputes it. Without that, an intercepted `keys:rotate` token would authorize *any*
 * `keys:rotate` body, including one registering the interceptor's key.
 */

/** SHA-256 a request body, base64url-encoded — the exact form `bodySha256` is written in. */
export async function sha256Base64Url(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Compare two strings without leaking, through timing, where they first differ.
 *
 * The honest caveat first: `===` on a **digest** is a weak oracle at best. To exploit the early return
 * an attacker must steer the digest byte by byte, which means finding preimages — so this is not the
 * classic "guess the MAC one byte at a time" break that constant-time comparison was invented for.
 *
 * We do it anyway, for two reasons. The threat model is not fixed: this helper is the one every future
 * comparison in the seam will reach for, and the next thing compared may well be a value an attacker
 * *can* choose freely, at which point a plain `===` becomes a real break with no diff to notice it in.
 * And the cost is a loop over 43 characters. Paying it always is cheaper than auditing, every time,
 * whether this particular comparison happened to be safe.
 *
 * The scan runs to the end of the longer string and folds the length difference into the same
 * accumulator, so neither an early match nor an early mismatch changes the work done.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  const width = Math.max(a.length, b.length);
  for (let i = 0; i < width; i++) {
    // Past the end `charCodeAt` yields NaN; `|| 0` makes the overrun a zero rather than a branch. The
    // length xor above is what keeps a NUL-padded string from reading as equal to a shorter one.
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}
