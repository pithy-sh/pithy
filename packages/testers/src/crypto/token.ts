// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The tester's confirmation credential.
 *
 * **The token is a row, not a signature.** Thirty-two bytes of CSPRNG stored on the member, looked up
 * on every visit — the same shape `@pithy-sh/storage` uses for share links, and chosen here for three
 * reasons that all point the same way.
 *
 * **It can be revoked.** A signed token can only expire; nothing the developer does calls one back. A
 * row means removing a tester kills their link on the next request, which is what you want when someone
 * forwards an invitation to a colleague or leaves the company mid-test.
 *
 * **It needs no secret, so it can be created anywhere.** Signing would mean reading a key from the
 * secrets store, and outside the Worker that is only possible in local dev — reaching a runtime secret
 * through the provisioning client is explicitly not allowed. A random token is generated when the member
 * row is created, so `pithy testers invite` builds a working invitation against any environment and
 * nothing has to be minted at send time.
 *
 * **The statelessness it gives up was never worth anything here.** The argument for a signed token is
 * that it verifies without touching the database — but the opt-in route writes to the database on the
 * same request regardless, so it was never avoiding a lookup. A shape check rejects garbage before the
 * query, which is the only part that mattered.
 *
 * What the token is *not*: it is not what enrols a tester with Google. It records that they followed our
 * link, and the route then sends them on to the store's own opt-in page, which is where enrolment
 * actually happens. See `docs/store-apis.md`.
 */

/** How many bytes of entropy the token carries. The token is the whole credential, so this is the gate. */
const TOKEN_BYTES = 32;

/**
 * A token as it appears in a URL: base64url, unpadded.
 *
 * Bounded and character-restricted so a malformed segment is refused before it reaches a query. This
 * checks *shape*, never authenticity — a well-formed token that matches no row still fails, with the
 * same words, which is what keeps the public route from being an oracle.
 */
export const OPT_IN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Generate a confirmation token.
 *
 * 256 bits, base64url-encoded and unpadded so it is safe in a path segment without escaping. The token
 * is the entire credential standing between a link and anyone guessing one, which is why the entropy is
 * the same as a storage share link rather than something shorter and friendlier.
 */
export function generateOptInToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Whether a path segment is shaped like one of our tokens. Shape only — never authenticity. */
export function isOptInTokenShape(value: string): boolean {
  return OPT_IN_TOKEN_PATTERN.test(value);
}
