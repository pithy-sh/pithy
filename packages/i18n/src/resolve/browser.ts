// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BrowserResolver, I18nConfig } from "../config/config";
import { type ResolvedLocale, type ResolverLink, resolveChain, tagLink } from "./chain";

/**
 * What a browser knows about the reader's language.
 *
 * A separate chain from the server's, because half the server's links do not exist here and half of
 * these do not exist there: `localStorage` is absent from a Worker, and `navigator.language` inside
 * workerd is the constant `"en"`, carrying no request information at all.
 */
export interface BrowserLocaleSignals {
  /** An explicit choice on the URL — `?lang=es`. */
  readonly query?: string | null;
  /** The signed-in reader's own preference, as the app already holds it. */
  readonly account?: string | null;
  /** What this device remembers, from `localStorage`. */
  readonly storage?: string | null;
  /**
   * The reader's own browser languages, most-wanted first, from `navigator.languages`.
   *
   * The browser's equivalent of `Accept-Language`, and the only link that answers for a first-time
   * visitor who has chosen nothing and is signed in to nothing. A list rather than one tag, because
   * `navigator.languages` is one and the whole of it is a preference order worth honoring.
   */
  readonly navigator?: readonly string[] | null;
  /** What the server negotiated for the document, off `<html lang>`. */
  readonly server?: string | null;
}

/**
 * The reader's locale, by the configured browser chain.
 *
 * Default order: `?lang=`, the account, local storage, the server's answer, the project default.
 *
 * **The account outranks the device.** `pithy_auth_users.locale` is where a person's locale lives, so a
 * signed-in reader who picks a language on one device must not silently be reading another language on
 * the next. A `?lang=` choice by a signed-in reader is written through to their account rather than
 * only to `localStorage`, which is what keeps the fact in one home; `docs/I18N.md` states it once.
 */
export function resolveBrowserLocale(signals: BrowserLocaleSignals, config: I18nConfig): ResolvedLocale {
  const links: ResolverLink[] = config.browserResolvers.map((resolver) => linkFor(resolver, signals, config));
  return resolveChain(links, config);
}

/** One link, by name. A standalone function so the switch stays exhaustive under `verbatimModuleSyntax`. */
function linkFor(resolver: BrowserResolver, signals: BrowserLocaleSignals, config: I18nConfig): ResolverLink {
  switch (resolver) {
    case "query":
      return tagLink(resolver, signals.query);
    case "account":
      return tagLink(resolver, signals.account);
    case "storage":
      return tagLink(resolver, signals.storage);
    case "navigator":
      // The whole weighted list, not its head — `navigator.languages` is already in preference order,
      // and a reader whose first language the project does not ship still gets their second.
      return { name: resolver, ranges: (signals.navigator ?? []).filter((tag) => tag.trim().length > 0) };
    case "server":
      return tagLink(resolver, signals.server);
    case "default":
      return tagLink(resolver, config.defaultLocale);
  }
}
