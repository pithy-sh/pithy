// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Address normalization — the single place an email address becomes a comparable value.
 *
 * Every join in this capability keys on an address: which inbox a message claimed, which sender a
 * thread belongs to, which account it links to, and what the volume guard counts. So there is one
 * normalization, applied on the way in, and comparisons are plain equality afterwards. The
 * alternative — normalizing at each comparison — is how `Ada@Example.com` ends up with two threads,
 * one rate-limit bucket each.
 *
 * **The local part is lowercased too, even though RFC 5321 says it is case-sensitive.** That is
 * deliberate and it is what every mail provider actually does. Treating `Ada@` and `ada@` as two
 * people would split one customer's history in half, and the failure mode of being wrong the other
 * way — two genuinely distinct mailboxes differing only in case — does not exist in practice.
 *
 * Nothing here strips subaddressing (`ada+shop@`) or dots. Gmail collapses both; most providers do
 * not, and folding them would merge addresses that really are different people on a self-hosted
 * domain. A support inbox that occasionally shows one customer as two is recoverable; one that shows
 * two customers as one is not.
 */

/** The longest address accepted. RFC 5321 caps a path at 256 octets; anything longer is malformed. */
const MAX_ADDRESS_LENGTH = 256;

/**
 * Normalize an address for storage and comparison: trim, unwrap `<…>`, lowercase, and reject
 * anything that is not recognizably one address.
 *
 * Returns `undefined` rather than throwing. Inbound mail is attacker-controlled, so a malformed
 * `From` is an expected input, not an exception — the caller decides whether that means "drop the
 * message" or "store it with no sender", and both are reasonable.
 */
export function normalizeAddress(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  let candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_ADDRESS_LENGTH) return undefined;

  // `Ada Lovelace <ada@example.com>` — take what the angle brackets delimit, which is the address
  // even when the display name itself contains an `@`.
  const angled = /<([^<>]*)>\s*$/.exec(candidate);
  if (angled?.[1] !== undefined) candidate = angled[1].trim();

  const at = candidate.lastIndexOf("@");
  if (at <= 0 || at === candidate.length - 1) return undefined;

  const local = candidate.slice(0, at);
  const domain = candidate.slice(at + 1);
  // A domain with no dot is either localhost or a mistake, and a space anywhere means this was never
  // one address. Both are cheap to check and both are worth refusing before anything is stored.
  if (!domain.includes(".") || /[\s,;<>"]/.test(candidate)) return undefined;

  return `${local.toLowerCase()}@${domain.toLowerCase()}`;
}

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
