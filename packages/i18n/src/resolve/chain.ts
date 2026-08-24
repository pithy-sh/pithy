// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { LocaleContext } from "@pithy-sh/core/src/i18n/locale";
import { formattingLocaleOf, localeDirection } from "@pithy-sh/core/src/i18n/locale";
import { matchLocale } from "@pithy-sh/core/src/i18n/match";
import type { I18nConfig } from "../config/config";

/** One link of a resolver chain: where the ranges came from, and what they were. */
export interface ResolverLink {
  /** The link's name, as it appears in `serverResolvers` / `browserResolvers`. */
  readonly name: string;
  /** The language ranges this link offers, most-wanted first. Empty when the link has nothing to say. */
  readonly ranges: readonly string[];
}

/** A resolved locale, plus which link answered — so `pithy doctor` and a log can say why. */
export interface ResolvedLocale extends LocaleContext {
  /** The chain link that answered, or `"default"` when the chain fell through to the project default. */
  readonly resolvedBy: string;
}

/**
 * A single tag as a one-element range list, or nothing when there is no tag.
 *
 * The links that read a stored or supplied value all have this shape. A blank string is nothing, not a
 * range: a cookie the browser cleared and a cookie that was never set mean the same thing here.
 */
export function tagLink(name: string, tag: string | null | undefined): ResolverLink {
  const trimmed = tag?.trim();
  return { name, ranges: trimmed ? [trimmed] : [] };
}

/**
 * Walk `links` in order and take the first that matches a supported locale.
 *
 * **The two locales are decided here, and only one of them falls back.** The catalog locale is what
 * matched — the words the kit actually has. The formatting locale is the *range the reader sent*, kept
 * whole when it is a tag `Intl` accepts: an `es-AR` visitor reads the `es` catalog and formats as
 * `es-AR`, which `Intl` supports natively whether or not anyone wrote a string for it.
 *
 * Total. Every construction on the way through is guarded, so a chain fed nothing but malformed input
 * lands on the project default rather than throwing.
 */
export function resolveChain(links: readonly ResolverLink[], config: I18nConfig): ResolvedLocale {
  for (const link of links) {
    if (link.ranges.length === 0) continue;
    const match = matchLocale(link.ranges, config.supportedLocales, config.exceptions);
    if (!match) continue;
    // The reader's own tag, canonicalized and stripped of extension subtags — `es-ar` becomes `es-AR`,
    // and `en-u-nu-hanidec` becomes `en`. A range that is not a constructible tag (a wildcard, an
    // exception-map key) formats as the catalog locale.
    const requested = formattingLocaleOf(match.range);
    return {
      catalogLocale: match.locale,
      formattingLocale: requested ?? match.locale,
      direction: localeDirection(match.locale),
      resolvedBy: link.name,
    };
  }
  return {
    catalogLocale: config.defaultLocale,
    formattingLocale: config.defaultLocale,
    direction: localeDirection(config.defaultLocale),
    resolvedBy: "default",
  };
}
