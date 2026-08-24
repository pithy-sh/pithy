// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_LOCALE_TAG_LENGTH } from "./locale";

/**
 * The most `Accept-Language` entries this parser will read from one header.
 *
 * A browser sends a handful. A caller that sends ten thousand is not negotiating, and the matcher
 * walks every entry against every supported locale — so the bound is on the input, where it costs
 * nothing, rather than on the loop, where it would have to be argued about at each call site.
 */
const MAX_ACCEPT_LANGUAGE_ENTRIES = 32;

/** The most characters this parser will read from one `Accept-Language` header, for the same reason. */
const MAX_ACCEPT_LANGUAGE_LENGTH = 4096;

/** One entry of an `Accept-Language` header: the tag the caller asked for, and how much they meant it. */
export interface LanguageRange {
  /** The language range, lower-cased. `*` survives as itself — it is a valid range, not a tag. */
  readonly range: string;
  /** The entry's q-weight, `0` through `1`. Absent weights are `1`, per RFC 9110. */
  readonly quality: number;
}

/** Whether a q-weight parameter parses to a usable number. `q=` and `q=abc` are neither, and drop out. */
function quality(parameter: string): number | null {
  const match = /^q=(\d(?:\.\d{0,3})?)$/.exec(parameter);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * An `Accept-Language` header as q-weighted ranges, most-wanted first.
 *
 * **Tokenize, strip q-weights, then validate — in that order, and all of it before anything reaches
 * `Intl`.** The header is caller-supplied and its real-world contents include `*`, `en_US`, empty
 * tokens, and tags still carrying `;q=0.9`; `new Intl.Locale()` throws a `RangeError` on every one of
 * them. A header that cannot be read is an empty list, never a throw, so the resolver chain falls
 * through to its next link instead of 500-ing.
 *
 * The **full** weighted list is returned, not the first entry: `pt-PT;q=1.0, es;q=0.8, en;q=0.5` from a
 * reader who has no Portuguese is a request for Spanish, and reading only the head answers English.
 * Equal weights keep header order, which is what a browser means by listing them that way.
 */
export function parseAcceptLanguage(header: string | null | undefined): LanguageRange[] {
  if (!header || header.length > MAX_ACCEPT_LANGUAGE_LENGTH) return [];
  const ranges: LanguageRange[] = [];
  for (const entry of header.split(",")) {
    if (ranges.length >= MAX_ACCEPT_LANGUAGE_ENTRIES) break;
    const [rawRange, ...parameters] = entry.split(";");
    const range = rawRange?.trim().toLowerCase() ?? "";
    // `*` is a legal range and no tag at all, so it is kept verbatim and special-cased by the matcher.
    // Everything else must look like a tag here, which is what keeps `en_US` and `` out of `Intl`.
    if (range !== "*" && !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(range)) continue;
    if (range.length > MAX_LOCALE_TAG_LENGTH) continue;
    let weight = 1;
    for (const parameter of parameters) {
      const parsed = quality(parameter.trim().toLowerCase());
      if (parsed !== null) weight = parsed;
    }
    // `q=0` is an explicit refusal, not a weak preference. Dropping it here is what keeps it out of
    // the match — a reader who wrote `de;q=0` must not be answered in German by a later fallback.
    if (weight > 0) ranges.push({ range, quality: weight });
  }
  // Stable by construction: `sort` is stable in every runtime Pithy targets, so equal weights keep
  // the order the caller wrote them in.
  return ranges.sort((left, right) => right.quality - left.quality);
}
