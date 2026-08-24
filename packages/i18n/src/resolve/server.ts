// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { parseAcceptLanguage } from "@pithy-sh/core/src/i18n/acceptLanguage";
import type { I18nConfig, ServerResolver } from "../config/config";
import { type ResolvedLocale, type ResolverLink, resolveChain, tagLink } from "./chain";

/**
 * What a Worker knows about a request's language, before any of it is trusted.
 *
 * Every field is caller-supplied and every one of them is guarded downstream: a `*`, an `en_US`, an
 * empty token or a fragment still carrying `;q=0.9` falls out of the match instead of reaching
 * `Intl.Locale` and raising a `RangeError`.
 */
export interface ServerLocaleSignals {
  /** An explicit choice on the query string — `?lang=es`. */
  readonly param?: string | null;
  /** The signed-in reader's own preference, from `pithy_auth_users.locale`. */
  readonly user?: string | null;
  /** The locale cookie, for a reader who chose one and is not signed in. */
  readonly cookie?: string | null;
  /** The raw `Accept-Language` header, q-weights and all. */
  readonly header?: string | null;
}

/**
 * The request's locale, by the configured server chain.
 *
 * Default order: explicit param, the account, the cookie, `Accept-Language`, the project default. An
 * adopter reorders or shortens it in config; `default` is the last resort whether or not it is listed.
 *
 * `Accept-Language` is honored as the **full q-weighted list**, not as its first entry —
 * `pt-PT;q=1.0, es;q=0.8, en;q=0.5` from a reader with no Portuguese is a request for Spanish, and
 * reading only the head answers English.
 */
export function resolveServerLocale(signals: ServerLocaleSignals, config: I18nConfig): ResolvedLocale {
  const links: ResolverLink[] = config.serverResolvers.map((resolver) => linkFor(resolver, signals, config));
  return resolveChain(links, config);
}

/** One link, by name. A standalone function so the switch stays exhaustive under `verbatimModuleSyntax`. */
function linkFor(resolver: ServerResolver, signals: ServerLocaleSignals, config: I18nConfig): ResolverLink {
  switch (resolver) {
    case "param":
      return tagLink(resolver, signals.param);
    case "user":
      return tagLink(resolver, signals.user);
    case "cookie":
      return tagLink(resolver, signals.cookie);
    case "header":
      return { name: resolver, ranges: parseAcceptLanguage(signals.header).map((entry) => entry.range) };
    case "default":
      return tagLink(resolver, config.defaultLocale);
  }
}
