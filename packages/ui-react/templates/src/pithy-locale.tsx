import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { LocaleContext } from "@pithy-sh/core/src/i18n/locale";
import { applyProjectedLocale } from "@pithy-sh/i18n/src/browser/document";
import { loadKitCatalog } from "@pithy-sh/i18n/src/catalogs/browser";
import { TranslatorProvider } from "@pithy-sh/i18n/src/react/translator";
import { type ReactNode, useEffect, useState } from "react";
import { i18nConfig } from "./pithy-config";

/**
 * The language this document is in — declared on `<html>` and rendered by every screen under it, from
 * **one** value.
 *
 * ## Why this file exists at all
 *
 * `client.tsx` used to call `applyProjectedLocale` and stop there. That negotiates a locale and writes
 * `lang` and `dir` onto the document, and nothing mounted a translator behind it — so a project that
 * composed `i18n` and met a Spanish reader served `<html lang="es">` over a page rendering the English
 * every screen bakes. That is **worse than never having negotiated at all**: a screen reader believes
 * the attribute, switches voice, and pronounces English words with Spanish phonetics. The page is
 * unreadable to the one reader the attribute exists for.
 *
 * The fix is the shape rather than an extra call. {@link locale} is resolved once, and the same value
 * both goes on the document and selects the catalog this provider mounts. There is no second statement
 * of what language the page is in, so the two cannot disagree.
 *
 * ## What it does when nothing is composed
 *
 * `applyProjectedLocale` answers `null` for a project with no `i18n` capability. Then this renders its
 * children untouched — no provider, no catalog fetched, no chunk downloaded — and every screen reads
 * the English it was scaffolded with, byte for byte. The document keeps the `lang` `index.html`
 * declared. Removing the capability puts the app back exactly where it started.
 */
export const locale: LocaleContext | null = applyProjectedLocale(i18nConfig);

/** What {@link PithyLocale} takes: the tree to render, and your own catalogs if you have any. */
export interface PithyLocaleProps {
  /** The app. Rendered with a translator over it, or untouched when no locale was negotiated. */
  readonly children: ReactNode;
  /**
   * Your own catalogs, keyed by locale — the **top** layer, above the kit's translation and above each
   * screen's baked English.
   *
   * This is where a sentence you want said differently goes, and where a language the kit writes
   * nothing in gets its words: `loadKitCatalog` answers an empty catalog for a locale the kit has no
   * translation for, so `fr` without an entry here renders English under `lang="fr"`. One key is one
   * entry; everything you do not mention keeps flowing from the package.
   */
  readonly messages?: Readonly<Record<string, MessageCatalog | undefined>>;
}

/**
 * Mount the negotiated locale over the app.
 *
 * The catalog arrives by dynamic import, one chunk per locale, so a reader downloads only their own
 * language. Until it lands the children render their baked English — which is the right thing to show
 * for the handful of milliseconds involved, and is exactly what a reader in the default locale sees
 * permanently.
 *
 * **This negotiates at module scope, not through `useNegotiatedLocale`, and the reason is timing.**
 * The hook takes the same `virtual:pithy/i18n` projection this file passes to `applyProjectedLocale`,
 * so there is no shape to convert — but a hook cannot run before the first paint. {@link locale} is
 * resolved as this module loads, which is the difference between a screen that was always in its
 * language and one that changed into it, and it is what keeps a right-to-left reader from watching the
 * page reflow.
 *
 * Reach for the hook alongside this when your app has a session to offer it: a signed-in reader's
 * stored locale outranks this device's memory, and only you know who is signed in. Give it the same
 * `i18nConfig` and the same `messages`, pass `persist` so their choice follows them to their next
 * device, and use its `choose` for a language control. `messages` goes to both because the hook's
 * provider shadows this one rather than merging with it: an override passed only here vanishes the
 * moment that provider mounts. This pre-paint pass stays where it is either way — the hook writes
 * `lang` and `dir` too, one render later.
 *
 * **Running both is two providers and two catalog loads, so mount the hook's provider *inside* this
 * one.** Nothing merges them: this component mounts a `TranslatorProvider` around its children, the
 * hook hands you a `source` you mount in a second one, and every screen reads whichever provider is
 * nearer to it. Inside, the hook's is nearer, so `choose` changes the words on screen. Outside —
 * wrapping `<PithyLocale>` — this one shadows it, and a reader who picks a language gets a fresh `lang`
 * on the document over the words of the locale that was negotiated at load: the same mismatch the top
 * of this file exists to prevent.
 *
 * The second `loadKitCatalog` is cheap where the two agree — same locale, and its chunk is already in
 * the module registry, so the call resolves off it rather than fetching again. It is a real second
 * download when the hook lands somewhere this pass did not, and there is more than one way that
 * happens. A signed-in reader's `account` locale outranks the device's memory, and only the hook is
 * handed it. `choose` moves past whatever either negotiated. And the two read `navigator` differently:
 * this pass offers the reader's first language alone, to stay ahead of the paint, while the hook walks
 * the whole weighted list — so a first language you do not ship and a second you do can part them with
 * no session involved. Landing somewhere else is the whole reason to run the hook at all.
 */
export function PithyLocale({ children, messages }: PithyLocaleProps): ReactNode {
  const [kit, setKit] = useState<MessageCatalog | null>(null);

  useEffect(() => {
    let live = true;
    if (locale !== null) {
      void loadKitCatalog(locale.catalogLocale)
        .then((catalog) => {
          if (live) setKit(catalog);
        })
        // A per-locale chunk that will not load — a 404 after a deploy, an offline tab — must not leave
        // the provider unmounted forever with `lang` already changed on the document. That is the
        // "declares a language it does not speak" failure by another road: a screen reader believes the
        // attribute and mispronounces English. An empty catalog mounts the provider, so every screen
        // falls through to the English it was scaffolded with, which is what is actually on screen.
        .catch(() => {
          if (live) setKit({});
        });
    }
    return () => {
      live = false;
    };
  }, []);

  if (locale === null || kit === null) return children;
  return (
    <TranslatorProvider
      value={{
        // The tag `lang` carries, and the words the kit has.
        catalogLocale: locale.catalogLocale,
        // The tag the reader actually asked for, region and all — `es-AR` where `catalogLocale` is
        // `es`. `Intl` supports it natively whether or not anyone wrote a string for it, so keeping the
        // two apart is what gives Buenos Aires Spanish sentences and Argentine dates. Passing one value
        // to both is the collapse this pair exists to prevent.
        formattingLocale: locale.formattingLocale,
        // Yours first, then the kit's. Each screen's own English is appended by `useTranslator`, last,
        // which is what makes a key nobody translated still render a sentence.
        layers: [messages?.[locale.catalogLocale], kit],
      }}
    >
      {children}
    </TranslatorProvider>
  );
}
