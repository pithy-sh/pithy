// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { interpolate, lookupMessage, type MessageCatalog, type MessageParams } from "./catalog";
import { localeDirection, type TextDirection } from "./locale";

/**
 * The i18n seam. `@pithy-sh/core` defines this shape; `@pithy-sh/i18n` populates it from the resolved
 * request locale. Every other capability, and every screen, depends only on this object — the same
 * split `AuthContext` uses, and for the same reason: `@pithy-sh/email` and the error module both need
 * a locale and neither may import an i18n capability.
 *
 * **The two locales are both here, as plain strings.** An adopter who already owns their date and
 * number rendering needs the locale as a *value* to hand to `Intl`; forcing it through
 * {@link Translator.formatDate} turns a one-line repair into an every-call-site one, against gates that
 * exist to keep those calls in one place.
 */
export interface Translator {
  /**
   * The locale whose catalog answers {@link Translator.t} — the words the kit actually has.
   *
   * An `es-AR` reader gets `es` here, because `es` is what is written. See
   * {@link Translator.formattingLocale} for the half that does not fall back.
   */
  readonly catalogLocale: string;
  /**
   * The locale handed to `Intl` — what the reader asked for, region and all.
   *
   * An `es-AR` reader gets `es-AR` here, which `Intl` supports natively whether or not anyone wrote a
   * string for it. Collapsing this into {@link Translator.catalogLocale} is the bug where an Argentine
   * reads Spanish and sees `1,234.56`.
   */
  readonly formattingLocale: string;
  /** The catalog locale's text direction — what `lang`/`dir` on the document and the email shell get. */
  readonly direction: TextDirection;
  /**
   * The message `key` names, with `{placeholder}` substitution.
   *
   * Returns the key itself when nothing has it. That is the honest answer — a blank reads like finished
   * copy — and it is unreachable for a kit key, because catalog coverage is a CI gate.
   */
  t(key: string, params?: MessageParams): string;
  /**
   * The message `key` names, or `null` when no layer has it.
   *
   * **The half {@link Translator.t} cannot express, and the error path needs.** `t` is total because a
   * screen always has to render something, so a miss comes back as the key — which is the honest thing
   * to show and is unusable as a signal. An error is the other case: the payload already carries an
   * English `message`, and a client that could not translate the code must render *that*, not the code.
   *
   * So the documented client contract is `t.maybe(payload.code, payload.params) ?? payload.message`.
   * Written against `t` it silently never falls back — `t` returns the key, `??` sees a string, and a
   * caller in an uncovered locale reads `auth/invalid_token` on their screen instead of the sentence
   * the server took care to send them.
   */
  maybe(key: string, params?: MessageParams): string | null;
  /**
   * The message `key` names, in the plural form `count` calls for.
   *
   * Looks up `<key>.<category>` for the `Intl.PluralRules` category of `count` in the catalog locale,
   * falling back to `<key>.other`. `count` is available to the message as `{count}` without being
   * passed twice.
   *
   * Explicit rather than folded into {@link Translator.t}, because plural selection is the thing a
   * second locale exposes: English has two forms, Spanish has two, Russian has three, and a call site
   * that concatenated a number onto a noun has no form at all.
   */
  plural(key: string, count: number, params?: MessageParams): string;
  /** `value` as a number in the formatting locale. */
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  /** `value` as an amount of `currency` in the formatting locale. */
  formatCurrency(value: number, currency: string, options?: Intl.NumberFormatOptions): string;
  /** `value` as a date in the formatting locale. Accepts a `Date` or an epoch-milliseconds number. */
  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  /** `values` as a list in the formatting locale — `a, b y c` in Spanish, `a, b, and c` in English. */
  formatList(values: readonly string[], options?: Intl.ListFormatOptions): string;
  /** `value` `unit`s from now, in the formatting locale — `ayer`, `in 3 days`. */
  formatRelativeTime(
    value: number,
    unit: Intl.RelativeTimeFormatUnit,
    options?: Intl.RelativeTimeFormatOptions,
  ): string;
}

/** What a translator is built from: the locales it answers in, and the layers it looks messages up through. */
export interface TranslatorInput {
  /** The locale whose catalog answers `t()`. */
  readonly catalogLocale: string;
  /** The locale handed to `Intl`; defaults to {@link TranslatorInput.catalogLocale}. */
  readonly formattingLocale?: string;
  /**
   * The catalogs to walk, most-specific first. `@pithy-sh/i18n` passes adopter-locale, adopter-default,
   * kit-locale, kit-default; a copied screen passes its own baked English and nothing else.
   */
  readonly layers: readonly (MessageCatalog | undefined)[];
}

/**
 * A translator over `layers`.
 *
 * The `Intl` formatters are constructed lazily and held for the life of the translator. A translator is
 * per request (or per mounted screen), so nothing here outlives a locale — which is the whole reason
 * `z.config()` is banned repo-wide and a per-request global is not an option.
 */
export function createTranslator(input: TranslatorInput): Translator {
  const catalogLocale = input.catalogLocale;
  const formattingLocale = input.formattingLocale ?? catalogLocale;
  const layers = input.layers;

  let plurals: Intl.PluralRules | undefined;
  const pluralRules = (): Intl.PluralRules => {
    plurals ??= new Intl.PluralRules(catalogLocale);
    return plurals;
  };

  const maybe = (key: string, params?: MessageParams): string | null => {
    const message = lookupMessage(layers, key);
    return message === null ? null : interpolate(message, params);
  };

  const translate = (key: string, params?: MessageParams): string => maybe(key, params) ?? key;

  return {
    catalogLocale,
    formattingLocale,
    direction: localeDirection(catalogLocale),
    t: translate,
    maybe,
    plural(key, count, params) {
      const category = pluralRules().select(count);
      const withCount: MessageParams = { count, ...params };
      const exact = lookupMessage(layers, `${key}.${category}`);
      if (exact !== null) return interpolate(exact, withCount);
      const other = lookupMessage(layers, `${key}.other`);
      return other === null ? key : interpolate(other, withCount);
    },
    formatNumber(value, options) {
      return new Intl.NumberFormat(formattingLocale, options).format(value);
    },
    formatCurrency(value, currency, options) {
      return new Intl.NumberFormat(formattingLocale, { ...options, style: "currency", currency }).format(value);
    },
    formatDate(value, options) {
      return new Intl.DateTimeFormat(formattingLocale, options).format(value);
    },
    formatList(values, options) {
      return new Intl.ListFormat(formattingLocale, options).format(values);
    },
    formatRelativeTime(value, unit, options) {
      return new Intl.RelativeTimeFormat(formattingLocale, options).format(value, unit);
    },
  };
}

/** The locale a project falls back to when nothing else answers, and the locale the kit writes in. */
export const DEFAULT_LOCALE = "en";

/**
 * A translator over one baked catalog — **the seam's behavior when `@pithy-sh/i18n` is not composed.**
 *
 * This is what makes the capability optional. A project that never composes `i18n` renders the baked
 * English fallback, byte for byte as it does today, with no negotiation, no merge and no config. A
 * copied screen builds one from the English it was scaffolded with, which is the only catalog that
 * survives being copied into an adopter's repository.
 */
export function bakedTranslator(catalog: MessageCatalog, locale: string = DEFAULT_LOCALE): Translator {
  return createTranslator({ catalogLocale: locale, layers: [catalog] });
}
