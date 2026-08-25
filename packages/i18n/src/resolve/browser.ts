// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BrowserResolver } from "../config/config";
import { type LocaleSet, type ResolvedLocale, type ResolverLink, resolveChain, tagLink } from "./chain";

/**
 * What the browser side of this package reads: the languages, the chain order, and the two names a page
 * looks itself up by.
 *
 * **The shape `I18nClientProjection` and `I18nConfig` both already are.** The browser holds the
 * projection — locale metadata and nothing else, no catalogs, no cookie name, no server chain — so
 * asking a page for an `I18nConfig` asks it for three fields it has no business knowing, and every
 * adopter widens one into the other the same five ways. Declaring what is actually read costs nothing
 * on the server, where the resolved config satisfies it as it stands.
 *
 * `browserResolvers` is `readonly string[]` for the same reason the projection's is: the ambient
 * declaration `pithy ui add react` copies into an adopter's Worker cannot name a type it does not
 * import. The chain is walked by name — see {@link recognizedResolvers}.
 */
export interface BrowserChain extends LocaleSet {
  /** The query parameter an explicit choice arrives on — `?lang=es`. */
  readonly queryParam: string;
  /** The `localStorage` key this device's remembered locale is written under. */
  readonly storageKey: string;
  /** The browser chain, in the order it is asked. Names this build does not know contribute nothing. */
  readonly browserResolvers: readonly string[];
}

/**
 * Every link this build knows, as a record rather than a list.
 *
 * **A record so a new `BrowserResolver` cannot be forgotten here.** Adding a member to the enum leaves
 * this object missing a property, which is a red build — the same guarantee the exhaustive switch in
 * {@link linkFor} gives, in the one place a `string[]` has to be turned back into enum members.
 *
 * Written out rather than read off `BrowserResolver.options`, and that is a bundle decision, not a
 * preference. `config/config.ts` is a Zod module, and everything under `src/browser/**` and
 * `src/react/**` imports the config type-only precisely so that no scaffolded SPA ships Zod to walk a
 * chain of six names. A value import here would put it in every adopter's main chunk.
 */
const KNOWN_RESOLVERS: Readonly<Record<BrowserResolver, true>> = {
  query: true,
  account: true,
  storage: true,
  navigator: true,
  server: true,
  default: true,
};

/**
 * The links of `names` this build recognizes, in the order given, dropping the rest.
 *
 * The browser walks its chain by name because that is how the projection carries it, so a link this
 * build has never heard of — a project one release ahead of the SPA bundle it is serving — contributes
 * nothing rather than throwing. The links around it are still asked, each in its own place.
 */
export function recognizedResolvers(names: readonly string[]): BrowserResolver[] {
  return names.filter((name): name is BrowserResolver => Object.hasOwn(KNOWN_RESOLVERS, name));
}

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
export function resolveBrowserLocale(signals: BrowserLocaleSignals, config: BrowserChain): ResolvedLocale {
  const chain = recognizedResolvers(config.browserResolvers);
  const links: ResolverLink[] = chain.map((resolver) => linkFor(resolver, signals, config));
  return resolveChain(links, config);
}

/** One link, by name. A standalone function so the switch stays exhaustive under `verbatimModuleSyntax`. */
function linkFor(resolver: BrowserResolver, signals: BrowserLocaleSignals, config: LocaleSet): ResolverLink {
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
