// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Truncation that counts **bytes**, because the limits it serves are byte limits.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a bound written as "256 KB" admits 256 K
 * *characters* — three times that in bytes for CJK, four for most emoji. The bounds in this package
 * exist to keep a row under D1's 2,000,000-byte ceiling, and a character-counted bound does not do
 * that: a large CJK message sails through every check and then fails the insert, at which point the
 * inbound handler swallows the error and the customer's mail is gone. Counting the thing the limit is
 * about is the whole fix.
 *
 * Truncation lands on a code-point boundary, so the result is never a lone surrogate — which would be
 * invalid text in the database and could break a JSON encode downstream.
 */

const encoder = new TextEncoder();

/** How many bytes this string occupies as UTF-8. */
export function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * `value`, cut to at most `maxBytes` UTF-8 bytes, never mid-code-point.
 *
 * **Binary search, because the obvious loop is quadratic.** Walking down one code unit at a time and
 * re-encoding the prefix each step is O(n) encodes of O(n) bytes, and the starting point makes it
 * worse: `maxBytes` *code units* can be four times `maxBytes` *bytes*, so multi-byte text starts far
 * above the answer and decrements toward it. Measured on the real constants, a 400k-character CJK
 * body took 174,763 iterations and about three minutes of CPU — inside an `email()` handler, which
 * the runtime kills long before that, so the message was never stored and every redelivery hit the
 * same wall. A size bound that loses the message is worse than no bound.
 *
 * The search runs over `[0, min(length, maxBytes)]`: `maxBytes` code units is an upper bound because
 * every code unit is at least one byte, and the predicate is monotone, so O(log n) encodes settle it.
 */ export function truncateToBytes(value: string, maxBytes: number): string {
  // The common case by far, and it costs one encode rather than a search.
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;

  // Largest code-unit count whose UTF-8 encoding still fits. Monotone in `end`, so bisect it.
  let low = 0;
  let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }

  // `slice` on a code-unit index can split a surrogate pair; stepping back one unit repairs it.
  const cut = value.slice(0, low);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
