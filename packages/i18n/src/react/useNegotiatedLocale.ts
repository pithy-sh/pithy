// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { localeDirection } from "@pithy-sh/core/src/i18n/locale";
import { useCallback, useEffect, useMemo, useState } from "react";
import { applyDocumentLocale, readBrowserSignals, rememberBrowserLocale } from "../browser/signals";
import { loadKitCatalog } from "../catalogs/browser";
import type { I18nConfig } from "../config/config";
import { resolveBrowserLocale } from "../resolve/browser";
import type { TranslatorSource } from "./translator";

/** What the hook hands back: what to mount, what was chosen, and how to choose again. */
export interface NegotiatedLocale {
  /** Pass this straight to `TranslatorProvider`. `null` until the locale's catalog has loaded. */
  readonly source: TranslatorSource | null;
  /** The catalog locale in force — the words the app has. */
  readonly locale: string;
  /** Choose a language. Remembers it on this device and puts `lang`/`dir` on the document. */
  readonly choose: (locale: string) => void;
}

/** What the caller knows that the browser cannot work out for itself. */
export interface NegotiatedLocaleOptions {
  /** The signed-in reader's stored locale, when the app knows it. Outranks this device's memory. */
  readonly account?: string | null;
  /** The adopter's own catalogs, keyed by locale — the top layer, above the kit's translation. */
  readonly messages?: Readonly<Record<string, MessageCatalog | undefined>>;
  /**
   * Write a signed-in reader's choice through to their account. Omit it and a choice is remembered on
   * this device only.
   *
   * **A seam rather than something this package does for you, because it cannot.** `pithy_auth_users.locale`
   * is written through `updateUser` (`@pithy-sh/auth/src/client/api`) — a call `@pithy-sh/auth` owns and
   * this package never imports. What it can do is call you at the moment the choice is made.
   *
   * It matters more than a convenience: `account` outranks `storage` in the browser chain precisely so
   * a reader who picks Spanish on their phone is not reading French on their laptop. Without the
   * write-through, that ordering describes a value nothing updates, and the second device keeps
   * answering from its own older memory forever. Pass this whenever a reader is signed in.
   *
   * **Failures are yours to handle, inside this function.** It is called and not awaited, and a
   * rejection is caught rather than reported: the reader already has the language they asked for and
   * the device already remembers it, so a failed preference write must not become an unhandled
   * rejection in their console or an error in your Worker. If a dropped write is worth knowing about,
   * catch it here where you know what your API meant.
   */
  readonly persist?: (locale: string) => void | Promise<void>;
}

/**
 * Negotiate the reader's locale in the browser, load that locale's catalog, and keep the document in
 * step.
 *
 * `config` is what `virtual:pithy/i18n` projects, so a screen reads the order **this project**
 * configured rather than one the front end assumed.
 *
 * The catalog arrives by dynamic import, one Vite chunk per locale, so a reader downloads only their
 * own language. Until it lands, `source` is `null` and every screen renders the English it was
 * scaffolded with — which is the right thing to show for the handful of milliseconds involved, and is
 * also exactly what a reader in the default locale sees permanently.
 */
export function useNegotiatedLocale(config: I18nConfig, options: NegotiatedLocaleOptions = {}): NegotiatedLocale {
  const resolved = useMemo(
    () => resolveBrowserLocale({ ...readBrowserSignals(config), account: options.account }, config),
    [config, options.account],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [kit, setKit] = useState<{ locale: string; catalog: MessageCatalog } | null>(null);

  const locale = chosen ?? resolved.catalogLocale;
  // A chosen locale is a catalog locale, so it carries no region; the negotiated one may be more
  // specific than the catalog it reads, and that specificity is what `Intl` should keep.
  const formattingLocale = chosen ?? resolved.formattingLocale;

  useEffect(() => {
    let live = true;
    loadKitCatalog(locale)
      .then((catalog) => {
        if (live) setKit({ locale, catalog });
      })
      // A per-locale chunk that will not load — a 404 after a deploy, an offline tab — must not leave
      // the provider unmounted forever with `lang` already changed on the document. That is the
      // "declares a language it does not speak" failure by another road: a screen reader believes the
      // attribute and mispronounces English. An empty catalog mounts the provider, so every screen
      // falls through to the English it was scaffolded with, which is what is actually on screen.
      .catch(() => {
        if (live) setKit({ locale, catalog: {} });
      });
    return () => {
      live = false;
    };
  }, [locale]);

  // Derived from the locale in force, never taken off `resolved`. `resolveBrowserLocale` answers for
  // what the *chain* negotiated, and `choose` moves past it: a reader who picks Arabic from a language
  // menu on an English page would otherwise be served `lang="ar" dir="ltr"` — the words right and the
  // layout backwards, which is the one failure a suite that only reads sentences cannot see. Same
  // derivation the chain itself uses (`localeDirection(match.locale)`), so the negotiated path is
  // byte-identical to what it answered before.
  const direction = localeDirection(locale);

  useEffect(() => {
    applyDocumentLocale(locale, direction);
  }, [locale, direction]);

  const persist = options.persist;
  const choose = useCallback(
    (next: string) => {
      if (!config.supportedLocales.includes(next)) return;
      // The device first, always: it is synchronous, it cannot fail in a way worth waiting for, and it
      // is what answers on the next visit if the account write does not land.
      rememberBrowserLocale(next, config);
      setChosen(next);
      // Then the account, when the app knows who is reading. Not awaited — a language switch is a
      // render, not a round trip, and nothing on screen should wait for a preference.
      //
      // **Caught, and that is not the same as swallowed by accident.** An unawaited promise that
      // rejects is an unhandled rejection: noise in a browser console, and a reported error in a
      // Worker. A failed preference write must not do either, because the reader already has the
      // language they asked for and the device already remembers it. Whether that failure is worth
      // reporting is a question about the adopter's own API, so it is answered inside `persist`.
      Promise.resolve(persist?.(next)).catch(() => undefined);
    },
    [config, persist],
  );

  const source = useMemo<TranslatorSource | null>(() => {
    // Only once the catalog for *this* locale has landed. Mounting the previous locale's catalog under
    // the new locale's tag is a page that says it is Spanish and reads English.
    if (kit?.locale !== locale) return null;
    return {
      catalogLocale: locale,
      formattingLocale,
      layers: [options.messages?.[locale], options.messages?.[config.defaultLocale], kit.catalog],
    };
  }, [kit, locale, formattingLocale, options.messages, config.defaultLocale]);

  return { source, locale, choose };
}
