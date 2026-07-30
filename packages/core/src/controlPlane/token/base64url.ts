import { ControlPlaneInvalidCredentialError } from "../error/errors";

/**
 * base64url, the encoding every part of a compact JWS is written in (RFC 4648 §5). Core ships no
 * base64 helper, so the seam brings its own rather than reaching into another package's crypto.
 *
 * Two properties matter here and nowhere else in the tree.
 *
 * **Decoding is strict.** A token segment is attacker-supplied by definition, and `atob` is famously
 * forgiving — it will happily digest whitespace and, on some runtimes, characters that mean nothing.
 * Silently decoding malformed input produces bytes that parse into *something*, and something is
 * exactly what an attacker wants a verifier to work with. So anything outside the url alphabet is a
 * throw, and the throw is a credential failure that renders as a 401 through the one handler.
 *
 * **Padding is rejected, not tolerated.** RFC 7515 §2 mandates unpadded segments. Accepting `=`
 * would give one token two spellings, and a token with two spellings is two strings to log, two to
 * compare, and one more thing an equality check can be wrong about.
 */

/** The url alphabet, unpadded. Whitespace, `+`, `/` and `=` are all outside it, deliberately. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** Encode raw bytes as unpadded base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  // Built one character at a time. `String.fromCharCode(...bytes)` overflows the argument stack on
  // inputs this seam genuinely sees — a request body digest, an exported key — so the loop is the
  // implementation, not a style choice. (Same reason as `secrets/src/crypto/envelope.ts`.)
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode unpadded base64url to raw bytes, or throw {@link ControlPlaneInvalidCredentialError}.
 *
 * Every rejection is the same error for the same reason the verification steps are: a caller learns
 * that the credential is not valid here, never which character gave it away.
 */
export function base64UrlDecode(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new ControlPlaneInvalidCredentialError({
      detail: "token segment is not unpadded base64url (RFC 4648 §5)",
    });
  }
  // A base64 group is 2, 3 or 4 characters. One leftover character encodes no byte at all, so a
  // length of 1 mod 4 is unrepresentable rather than merely odd — reject it before `atob` guesses.
  if (value.length % 4 === 1) {
    throw new ControlPlaneInvalidCredentialError({ detail: "token segment has an impossible base64url length" });
  }

  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch (cause) {
    throw new ControlPlaneInvalidCredentialError({ detail: "token segment failed base64url decode" }, { cause });
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
