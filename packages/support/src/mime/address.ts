// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a MIME header contributes that an address rule does not.
 *
 * Addresses themselves are `@pithy-sh/core/src/address/address` — `parseAddress` reads one out of a
 * header and `normalizeAddress` puts it in the form every comparison in the kit is against. This
 * capability used to own that rule; it does not any more, because `auth`, `email` and `testers`
 * compare addresses too, and four rules is four chances to disagree about whether two strings are the
 * same person. That disagreement presents as one customer with two threads, not as anything about
 * addresses.
 *
 * What is left here is the display name, which is this capability alone: nobody else stores one, and it
 * is the half of a `From` header that is free text an attacker wrote.
 */

/**
 * A display name, made safe to store.
 *
 * Trimmed, bounded, and stripped of control characters — including the bidirectional overrides that
 * let `moc.elpmaxe@ada` render as something else entirely. The result is still untrusted text that a
 * renderer must escape; this only guarantees it is text.
 */
export function normalizeDisplayName(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    // C0/C1 controls, plus the LTR/RTL overrides and embeddings (U+202A–U+202E, U+2066–U+2069).
    // biome-ignore-start lint/suspicious/noControlCharactersInRegex: stripping control
    // characters is the entire purpose — a bidi override renders a filename or a display name as
    // something other than what it is, which is the oldest trick in inbound mail.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    // biome-ignore-end lint/suspicious/noControlCharactersInRegex: see above
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : undefined;
}
