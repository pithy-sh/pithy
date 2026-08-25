// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { localeDirection } from "@pithy-sh/core/src/i18n/locale";
import { useCallback, useEffect, useMemo, useState } from "react";
import { applyDocumentLocale, readBrowserSignals, rememberBrowserLocale } from "../browser/signals";
import { loadKitCatalog } from "../catalogs/browser";
import type { I18nClientProjection } from "../client/projection";
import { resolveBrowserLocale } from "../resolve/browser";
import type { TranslatorSource } from "./translator";

/** What the hook hands back: what to mount, what was chosen, and how to choose again. */
export interface NegotiatedLocale {
  /**
   * Pass this straight to `TranslatorProvider`. `null` until the locale's catalog has loaded — and
   * permanently `null` for a project with no `i18n` composed, which is the same branch and needs no
   * second one: render the children untouched and every screen keeps its baked English.
   */
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
 * What `locale` answers, and what nothing writes to the document, when the capability is not composed.
 *
 * The kit writes in English and a scaffolded `templates/index.html` ships `lang="en"` as static text —
 * so this is both the language on screen and the tag already on the document. Nothing negotiated it,
 * which is exactly why the document is left alone rather than restamped with it.
 */
const UNNEGOTIATED_LOCALE = "en";

/**
 * Negotiate the reader's locale in the browser, load that locale's catalog, and keep the document in
 * step.
 *
 * **It takes what a browser holds.** `projection` is `virtual:pithy/i18n` — locale metadata and nothing
 * else — so a screen reads the chain order **this project** configured rather than one the front end
 * assumed, and no page is asked for the catalogs, the cookie name or the server chain that only a
 * Worker has. Your own catalogs reach it through `options.messages`, above the kit's translation.
 *
 * The catalog arrives by dynamic import, one Vite chunk per locale, so a reader downloads only their
 * own language. Until it lands, `source` is `null` and every screen renders the English it was
 * scaffolded with — which is the right thing to show for the handful of milliseconds involved, and is
 * also exactly what a reader in the default locale sees permanently.
 *
 * **`{ enabled: false }` is an answer, not an error, and it costs the caller no branch of its own.** A
 * project that never composed `i18n` projects it, and the hook then negotiates nothing, downloads no
 * chunk, writes nothing to `localStorage`, and leaves the `lang` `index.html` declared exactly where it
 * is: `source` stays `null` permanently, `locale` is `en`, and `choose` does nothing. `source === null`
 * is the same null a caller already renders through while a catalog is in flight — so the screen shows
 * the English it was scaffolded with, byte for byte as it did before any of this landed, and removing
 * the capability puts the app back where it started.
 */
export function useNegotiatedLocale(
  projection: I18nClientProjection,
  options: NegotiatedLocaleOptions = {},
): NegotiatedLocale {
  // Narrowed once, at the top. `null` is the whole of what "the capability is not composed" means here,
  // and every hook below runs either way and answers for it rather than being skipped — a hook behind a
  // condition is the one thing React does not allow.
  const config = projection.enabled ? projection : null;
  // The same fact as a boolean, and the two effects below depend on **this** rather than on `config`.
  // Composed, `config` is `projection` under another name, so its identity is the caller's — and a
  // caller is free to hand the hook a fresh object every render (`{ ...i18nConfig }`, or a parse in a
  // component body). An effect keyed on that identity re-runs on every render; the catalog effect sets
  // state, so it re-renders itself, forever, with no error anywhere to read. Both effects want nothing
  // from `config` but whether it is there, and a boolean is stable by value however the caller spells
  // its projection.
  const enabled = projection.enabled;

  const resolved = useMemo(
    () =>
      config === null
        ? null
        : resolveBrowserLocale({ ...readBrowserSignals(config), account: options.account }, config),
    [config, options.account],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [kit, setKit] = useState<{ locale: string; catalog: MessageCatalog } | null>(null);

  const locale = chosen ?? resolved?.catalogLocale ?? UNNEGOTIATED_LOCALE;
  // A chosen locale is a catalog locale, so it carries no region; the negotiated one may be more
  // specific than the catalog it reads, and that specificity is what `Intl` should keep.
  const formattingLocale = chosen ?? resolved?.formattingLocale ?? UNNEGOTIATED_LOCALE;
  // The project's default locale, whose layer catches a key the reader's own locale has not
  // translated. `en` when nothing is composed — both the language on screen and the only layer a
  // project without the capability could mean.
  const defaultLocale = config?.defaultLocale ?? UNNEGOTIATED_LOCALE;

  useEffect(() => {
    // No chunk is asked for at all with the capability uncomposed, and that is the whole of what keeps
    // `source` null there: `kit` never arrives, so the memo below has nothing to mount and the caller
    // renders through the same null it already renders through while a catalog is in flight.
    if (!enabled) return;
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
  }, [enabled, locale]);

  // Derived from the locale in force, never taken off `resolved`. `resolveBrowserLocale` answers for
  // what the *chain* negotiated, and `choose` moves past it: a reader who picks Arabic from a language
  // menu on an English page would otherwise be served `lang="ar" dir="ltr"` — the words right and the
  // layout backwards, which is the one failure a suite that only reads sentences cannot see. Same
  // derivation the chain itself uses (`localeDirection(match.locale)`), so the negotiated path is
  // byte-identical to what it answered before.
  const direction = localeDirection(locale);

  useEffect(() => {
    // Nothing negotiated it, so nothing declares it. A project without the capability keeps the `lang`
    // its `index.html` shipped — restamping the document with a locale no chain chose would be the
    // "declares a language it does not speak" failure with the negotiation removed rather than added.
    if (!enabled) return;
    applyDocumentLocale(locale, direction);
  }, [enabled, locale, direction]);

  const persist = options.persist;
  const choose = useCallback(
    (next: string) => {
      // No languages to choose between, and no `storageKey` to remember one under.
      if (config === null) return;
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
    // the new locale's tag is a page that says it is Spanish and reads English. This is also the one
    // test the uncomposed case has to pass: nothing ever loads a catalog there, so `kit` stays null
    // and no provider is ever mounted over screens already rendering their baked English.
    if (kit?.locale !== locale) return null;
    return {
      catalogLocale: locale,
      formattingLocale,
      layers: [options.messages?.[locale], options.messages?.[defaultLocale], kit.catalog],
    };
  }, [kit, locale, formattingLocale, options.messages, defaultLocale]);

  return { source, locale, choose };
}
