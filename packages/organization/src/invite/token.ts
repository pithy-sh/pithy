// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { base64UrlEncode } from "@pithy-sh/core/src/controlPlane/token/base64url";
import { sha256Base64Url } from "@pithy-sh/core/src/controlPlane/token/digest";

/**
 * The one secret an invitation mints, and the one-way function it is filed under.
 *
 * **The token is the whole of what the mail carries, and it is never stored as it was minted.** The row
 * holds a SHA-256 digest, so a database read — a backup, a dumped row, a support query — yields nothing
 * that can be redeemed.
 *
 * **A separate module from the control plane's credential helpers, on purpose.** The construction is
 * identical and the two-line temptation is to import a shared `digestOf`. They are different credential
 * systems with different lifetimes and different blast radii — a device code lives for minutes and
 * yields a connect token, an invitation lives for days and yields a membership — and one shared helper
 * is how a change made for one arrives, unread, in the other. What is shared is the primitive
 * (`sha256Base64Url`), which is the level at which sharing costs nothing.
 *
 * **Unsalted and uniterated, deliberately.** Stretching defends a value an attacker can guess, and this
 * is 256 random bits: there is no dictionary to run. What the digest buys is that the stored form is not
 * the presented form, so a leaked row cannot be replayed. A KDF would add latency to every acceptance
 * for a property the entropy already provides.
 *
 * **The token is not the authorization.** Holding it is necessary and not sufficient: acceptance also
 * requires a signed-in session whose own address equals the invited one. That is what makes a forwarded
 * link useless to whoever it was forwarded to, and it is why this file is small — the security of an
 * invitation is mostly not in its token.
 */

/** 256 bits. The size of anything that authenticates on its own. */
const TOKEN_BYTES = 32;

/**
 * A new invitation token. Returned once, put in the mail, and never held again.
 *
 * URL-safe by construction, because it becomes a path segment in the accept link and a value that
 * needed escaping would be a value somebody eventually forgot to escape.
 */
export function mintInvitationToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** The digest a token is filed under. SHA-256, base64url. */
export function invitationDigest(token: string): Promise<string> {
  return sha256Base64Url(new TextEncoder().encode(token));
}
