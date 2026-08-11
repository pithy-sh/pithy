// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Email addresses: the one rule for deciding whether two strings are the same person.
 *
 * Four capabilities compare addresses. `auth` matches a sign-in address, `email` suppresses one,
 * `support` links a sender by `From`, and `testers` invites one. Four rules is four chances to
 * disagree, and a disagreement here does not present as anything about addresses — it presents as "the
 * suppression list did not work", or as one customer with two support threads, or as an invitation
 * nobody can accept because it was minted against `Ada@` and every session carries `ada@`.
 *
 * So the rule is written down once, here, and it is deliberately small.
 *
 * ## What it normalizes
 *
 * - **Surrounding whitespace.** Trimmed. An address pasted out of a spreadsheet carries it.
 * - **Case, in both halves.** RFC 5321 says the local part is case-sensitive; no mail provider in
 *   practice treats it that way, and treating `Ada@` and `ada@` as two people splits one customer's
 *   history in half. The failure the other way — two genuinely distinct mailboxes differing only in
 *   case — does not exist in the wild.
 *
 * ## What it deliberately does not
 *
 * - **Subaddressing (`ada+shop@`) and dots in the local part.** Gmail collapses both. Most providers do
 *   not, and folding them would merge two real people on a self-hosted domain. Showing one customer as
 *   two is recoverable; showing two customers as one is not.
 * - **Unicode normalization.** No NFC, no NFKC, no case folding beyond `toLowerCase`. NFKC in
 *   particular maps distinct codepoints onto ASCII, which is exactly how one address comes to match
 *   another that was never issued to the same person — the confusable-domain attack, performed by us,
 *   on our own comparison. An address whose bytes differ stays a different address.
 * - **Validation.** {@link normalizeAddress} takes any string and returns its normal form. Whether a
 *   string *is* an address is a question for the boundary that accepted it — Zod, or {@link
 *   parseAddress} where the input is a mail header. A normalizer that also rejects is a normalizer
 *   whose callers stop calling it.
 * - **IDN / punycode.** A unicode domain is not converted to its `xn--` form, or back. Both spellings
 *   are stable under this rule; a project that accepts one must accept only one, at its boundary.
 */

/** The longest address accepted. RFC 5321 caps a path at 256 octets; anything longer is malformed. */
export const MAX_ADDRESS_LENGTH = 256;

/**
 * One address, in the one form every comparison in the kit is against.
 *
 * Trimmed and lowercased, and nothing else. Total: every string has a normal form, including the ones
 * that are not addresses. Use {@link parseAddress} where the input is attacker-supplied text that may
 * not contain an address at all.
 */
export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Read one address out of a header-shaped string, or refuse.
 *
 * Unwraps `Ada Lovelace <ada@example.com>`, bounds the length, refuses anything that is not
 * recognizably a single address, and returns it through {@link normalizeAddress}.
 *
 * Returns `undefined` rather than throwing. Inbound mail is attacker-controlled, so a malformed `From`
 * is an expected input, not an exception — the caller decides whether that means "drop the message" or
 * "store it with no sender", and both are reasonable.
 */
export function parseAddress(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  let candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_ADDRESS_LENGTH) return undefined;

  // `Ada Lovelace <ada@example.com>` — take what the angle brackets delimit, which is the address even
  // when the display name itself contains an `@`.
  const angled = /<([^<>]*)>\s*$/.exec(candidate);
  if (angled?.[1] !== undefined) candidate = angled[1].trim();

  const at = candidate.lastIndexOf("@");
  if (at <= 0 || at === candidate.length - 1) return undefined;

  // A domain with no dot is either localhost or a mistake, and a space, comma, semicolon, bracket or
  // quote anywhere means this was never one address. Both are cheap to check and both are worth
  // refusing before anything is stored.
  if (!candidate.slice(at + 1).includes(".") || /[\s,;<>"]/.test(candidate)) return undefined;

  return normalizeAddress(candidate);
}
