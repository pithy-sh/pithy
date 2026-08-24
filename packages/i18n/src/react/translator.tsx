// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { interpolate, type MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { bakedTranslator, createTranslator } from "@pithy-sh/core/src/i18n/translator";
import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * The React bindings — **a first-class public API of this package**, not something the kit's own
 * templates happen to import.
 *
 * An adopter rendering entirely their own screens has to be able to consume the seam without ever
 * touching a kit template, and after the first day most of them are: the screens are *copied*, so
 * `pithy ui add` reaches a project scaffolded after this landed and no command retrofits one that was
 * not. The seam is what an already-scaffolded adopter consumes. So this is the deliverable, and the
 * templates are one of its consumers.
 */

/**
 * What the provider carries: the two locales, and the catalog layers to walk.
 *
 * **The pieces, not a finished `Translator`.** A screen supplies the English it was scaffolded with as
 * a final fallback layer, and that layer can only be appended if the layers are still a list. Handing
 * the context a built translator would make a screen's own English unreachable — which is the one
 * thing that has to keep working, because it is the only catalog that survives being copied.
 */
export interface TranslatorSource {
  /** The locale whose catalog answers `t()`. */
  readonly catalogLocale: string;
  /** The locale handed to `Intl`. May be more specific than the catalog locale — `es-AR` over `es`. */
  readonly formattingLocale: string;
  /** The catalogs to walk, most-specific first: the adopter's, then the kit's translation. */
  readonly layers: readonly (MessageCatalog | undefined)[];
}

/**
 * What a provider may be given: the pieces, or a translator somebody else already built.
 *
 * The second arm is what makes the adapters reachable. `fromI18next`, `fromIntl` and `fromLingui`
 * return a `Translator` — an adopter's whole message layer, already resolved — and with only the
 * pieces arm they had nowhere to go: an adapted translator could be passed screen by screen as a `t`
 * prop, and `useTranslator()` in the adopter's *own* components would never see it. A stack you plug
 * in that only half the tree can read is not plugged in.
 */
export type TranslatorValue = TranslatorSource | Translator;

const TranslatorContext = createContext<TranslatorValue | null>(null);

/** Whether a provider was handed the pieces rather than a finished translator. */
function isSource(value: TranslatorValue): value is TranslatorSource {
  return "layers" in value;
}

/**
 * `primary` first, then `fallback` — the screen's own English behind somebody else's message layer.
 *
 * Built by delegation rather than by spreading `primary`, because a `Translator` may carry getters
 * (the request-scoped one does) and spreading would evaluate them once, here, freezing the answer.
 *
 * `t` and `maybe` consult the fallback because `maybe` is exactly the miss signal they need. `plural`
 * has a weaker one — it answers the key on a miss, which is the documented contract — so it falls back
 * only when it sees that, and an adapter whose library selects plurals itself (i18next does) keeps
 * answering for every key it knows.
 */
function overlay(primary: Translator, fallback: MessageCatalog): Translator {
  const own = (key: string, params?: Parameters<Translator["t"]>[1]): string | null =>
    Object.hasOwn(fallback, key) ? interpolate(fallback[key] as string, params) : null;
  return {
    catalogLocale: primary.catalogLocale,
    formattingLocale: primary.formattingLocale,
    direction: primary.direction,
    t: (key, params) => primary.maybe(key, params) ?? own(key, params) ?? key,
    maybe: (key, params) => primary.maybe(key, params) ?? own(key, params),
    plural: (key, count, params) => {
      const answered = primary.plural(key, count, params);
      if (answered !== key) return answered;
      const withCount = { count, ...params };
      return own(`${key}.other`, withCount) ?? own(key, withCount) ?? key;
    },
    formatNumber: (value, options) => primary.formatNumber(value, options),
    formatCurrency: (value, currency, options) => primary.formatCurrency(value, currency, options),
    formatDate: (value, options) => primary.formatDate(value, options),
    formatList: (values, options) => primary.formatList(values, options),
    formatRelativeTime: (value, unit, options) => primary.formatRelativeTime(value, unit, options),
  };
}

/** Mount a resolved locale over a subtree. Everything under it reads the same translator. */
export function TranslatorProvider({ value, children }: { value: TranslatorValue; children: ReactNode }) {
  return <TranslatorContext.Provider value={value}>{children}</TranslatorContext.Provider>;
}

/**
 * The translator for this subtree, with `fallback` as its last layer.
 *
 * **Never throws when there is no provider**, and that is deliberate rather than lenient. A screen
 * copied into an adopter's repository renders in a project that may not compose `i18n` at all, and in
 * that project it must render the English it was scaffolded with, byte for byte. With no provider this
 * is exactly a `bakedTranslator` over `fallback` — no negotiation, no merge, no config.
 *
 * With a provider, `fallback` goes **last**: the adopter's own catalog, then the kit's translation,
 * then the screen's baked English. So a key nobody translated still renders a sentence.
 *
 * That holds for a provider given a finished `Translator` too — an adapted i18next, FormatJS or Lingui
 * instance answers first and the screen's own English is behind it, so plugging your stack in never
 * costs you the sentences the kit already wrote.
 */
export function useTranslator(fallback?: MessageCatalog): Translator {
  const source = useContext(TranslatorContext);
  return useMemo(() => {
    if (!source) return bakedTranslator(fallback ?? {});
    if (!isSource(source)) return fallback ? overlay(source, fallback) : source;
    return createTranslator({
      catalogLocale: source.catalogLocale,
      formattingLocale: source.formattingLocale,
      layers: fallback ? [...source.layers, fallback] : source.layers,
    });
  }, [source, fallback]);
}

/**
 * The prop every screen that renders copy takes.
 *
 * Optional, and injected the same way `fetch` and `redirect` already are on the kit's screens: a
 * rendered fact no assertion about source text can reach is what earns a prop there, and a
 * locale-dependent render is exactly that. A screen with no `t` passed reads the context, and with no
 * context reads its own English.
 */
export interface TranslatorProp {
  /** The translator this screen renders through. Defaults to the context, then to the baked English. */
  t?: Translator;
}
