// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { parseLocale } from "./locale";

/**
 * A declared exception map: a language range the truncation walk would miss, and the supported locale
 * it means. `{ nb: "no", tl: "fil" }` — the pairs no algorithm derives, because they are historical
 * rather than structural.
 */
export type LocaleExceptions = Readonly<Record<string, string>>;

/** How a match was reached, so a caller can tell an answer from a default. */
export interface LocaleMatch {
  /** The supported locale that answered, exactly as the caller spelled it in `supported`. */
  readonly locale: string;
  /** The range that matched it, lower-cased — `*` when a wildcard took the first supported locale. */
  readonly range: string;
}

/** Lower-cased index of the supported list, so matching is case-insensitive without lower-casing answers. */
function index(supported: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const locale of supported) {
    const key = locale.toLowerCase();
    if (!map.has(key)) map.set(key, locale);
  }
  return map;
}

/**
 * RFC 4647 §3.4 lookup: `tag`, then `tag` with its right-most subtag removed, and so on.
 *
 * A trailing single-character subtag is removed with the one before it, as the RFC requires —
 * `en-a-bbb` truncates to `en`, never to the meaningless `en-a`.
 */
function truncationWalk(tag: string, supported: Map<string, string>): string | null {
  let candidate = tag.toLowerCase();
  while (candidate.length > 0) {
    const hit = supported.get(candidate);
    if (hit) return hit;
    const cut = candidate.lastIndexOf("-");
    if (cut < 0) return null;
    candidate = candidate.slice(0, cut);
    const tail = candidate.lastIndexOf("-");
    if (tail >= 0 && candidate.length - tail === 2) candidate = candidate.slice(0, tail);
  }
  return null;
}

/**
 * The supported locale that best answers one range, or `null`.
 *
 * Three passes, in the order that makes each one earn its place: the declared exception map first,
 * because it exists to override what follows; then the truncation walk on the range as written, which
 * answers `es-AR` with `es`; then the walk again over the **maximized** form, which answers `zh-TW`
 * with `zh-Hant` by way of `zh-Hant-TW`.
 *
 * **Maximizing is the third step, not the first.** `Intl.Locale` throws on input the first step handles
 * fine, and maximizing a range before trying it as written turns `es` into `es-Latn-ES` and then walks
 * back down to `es` — the same answer, three constructions later, and a `RangeError` away from a 500.
 */
function lookupRange(range: string, supported: Map<string, string>, exceptions: LocaleExceptions): string | null {
  // `Object.hasOwn`, never a bare index — `exceptions` is a plain object built by Zod, so
  // `exceptions["constructor"]` answers `Object` and `exceptions["__proto__"]` answers the prototype.
  // Read bare, both are truthy and neither is a string, so `declared.toLowerCase()` threw a
  // `TypeError` — inside a global middleware, which makes `?lang=constructor` a 500 on every request,
  // and a stale `pithy_locale=__proto__` cookie a 500 on every request that client makes until it is
  // cleared. `catalogs/browser.ts` already guards its own thunk map for exactly this reason.
  const key = range.toLowerCase();
  const declared = Object.hasOwn(exceptions, key) ? exceptions[key] : undefined;
  if (declared) {
    const hit = supported.get(declared.toLowerCase());
    if (hit) return hit;
  }
  const direct = truncationWalk(range, supported);
  if (direct) return direct;
  const maximized = parseLocale(range)?.maximize().toString();
  return maximized ? truncationWalk(maximized, supported) : null;
}

/**
 * The first supported locale any of `desired` asks for, most-wanted first, or `null` when none does.
 *
 * `desired` is already in preference order — {@link parseAcceptLanguage} sorts by q-weight, and a
 * browser resolver chain builds it from the reader's explicit choice downward. A `*` range takes the
 * first supported locale, which is what "anything you have" means; it is checked in place rather than
 * up front, so a reader who wrote `de, *` is answered in German when German ships.
 *
 * Total, and never throws: every `Intl` construction on the way through is guarded, so a header full
 * of `en_US` and `;q=0.9` fragments falls through to `null` and the caller's default.
 */
export function matchLocale(
  desired: readonly string[],
  supported: readonly string[],
  exceptions: LocaleExceptions = {},
): LocaleMatch | null {
  if (supported.length === 0) return null;
  const lookup = index(supported);
  for (const range of desired) {
    const normalized = range.trim().toLowerCase();
    if (normalized.length === 0) continue;
    if (normalized === "*") {
      const first = supported[0];
      return first ? { locale: first, range: normalized } : null;
    }
    const hit = lookupRange(normalized, lookup, exceptions);
    if (hit) return { locale: hit, range: normalized };
  }
  return null;
}
