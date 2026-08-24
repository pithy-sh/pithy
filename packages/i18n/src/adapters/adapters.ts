// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";
import { localeDirection } from "@pithy-sh/core/src/i18n/locale";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { createTranslator } from "@pithy-sh/core/src/i18n/translator";

/**
 * Adapters, so an adopter who already runs an i18n stack plugs it into the seam instead of migrating.
 *
 * **No runtime dependency on any of them, and none is possible here.** Each adapter takes the instance
 * the adopter already constructed and duck-types the minimal shape it needs — three or four members,
 * declared as a structural type in this file. Nothing is imported, nothing is installed, and a version
 * of i18next that moved a method is a compile error in *their* repository rather than a broken
 * dependency in ours.
 *
 * The shapes are minimal on purpose. An adapter that named every member of `i18next.TFunction` would
 * break on a release that added one; naming only what is called means it keeps working across the
 * versions that do not touch those three.
 */

/** Everything the wrapper needs, once the words are somebody else's problem. */
interface Wrapping {
  /** The locale whose catalog answers. */
  readonly catalogLocale: string;
  /** The locale handed to `Intl`. Defaults to the catalog locale. */
  readonly formattingLocale?: string;
  /** The other library's lookup, already bound to its own catalogs. */
  readonly translate: (key: string, params?: MessageParams) => string;
  /** The other library's plural lookup, when it has one worth using. */
  readonly plural?: (key: string, count: number, params?: MessageParams) => string;
}

/**
 * A `Translator` whose words come from `translate` and whose formatting comes from `Intl`.
 *
 * The formatting half is never delegated. Every one of these libraries formats through `Intl` anyway,
 * workerd embeds full ICU, and a `Translator` that formatted through a wrapper would answer a
 * different date for the same locale depending on which adapter was in use.
 */
function wrap(source: Wrapping): Translator {
  const base = createTranslator({
    catalogLocale: source.catalogLocale,
    formattingLocale: source.formattingLocale,
    layers: [],
  });
  const translate = (key: string, params?: MessageParams): string => source.translate(key, params);
  return {
    ...base,
    direction: localeDirection(source.catalogLocale),
    t: translate,
    /**
     * **A miss is the key coming back**, which is what every library this adapts already does:
     * i18next returns the key, FormatJS returns the message id, Lingui returns the id.
     *
     * It has to be implemented here rather than inherited. `wrap` builds its base from
     * `createTranslator` with **no layers**, so an inherited `maybe` answers `null` for everything —
     * and `maybe` is the whole of the documented error contract, `t.maybe(code, params) ?? message`.
     * Left inherited, every adapted translator silently rendered the English fallback for every code
     * it could in fact translate, and nothing failed to say so.
     */
    maybe: (key, params) => {
      const answered = translate(key, params);
      return answered === key ? null : answered;
    },
    plural: (key, count, params) =>
      source.plural ? source.plural(key, count, params) : translate(key, { count, ...params } satisfies MessageParams),
  };
}

/** The part of an i18next instance this adapter calls. */
export interface I18nextLike {
  /** The active language tag. */
  readonly language: string;
  /** i18next's lookup. `count` in the options object is what drives its own plural selection. */
  t(key: string, options?: Record<string, unknown>): string;
}

/**
 * A `Translator` backed by an i18next instance.
 *
 * i18next selects plurals from a `count` option rather than from a key suffix, so `plural` hands it
 * `count` and lets it choose — the kit's `<key>.<category>` convention is not imposed on a catalog
 * i18next already owns.
 */
export function fromI18next(instance: I18nextLike, formattingLocale?: string): Translator {
  return wrap({
    catalogLocale: instance.language,
    formattingLocale,
    translate: (key, params) => instance.t(key, params),
    plural: (key, count, params) => instance.t(key, { count, ...params }),
  });
}

/** The part of a FormatJS / react-intl `IntlShape` this adapter calls. */
export interface IntlShapeLike {
  /** The active locale tag. */
  readonly locale: string;
  /** FormatJS's lookup, keyed by message id. */
  formatMessage(descriptor: { id: string }, values?: Record<string, unknown>): string;
}

/**
 * A `Translator` backed by a FormatJS / react-intl `IntlShape`.
 *
 * FormatJS resolves plurals inside the ICU message itself, so `plural` passes `count` as a value and
 * lets the message's own `{count, plural, …}` arm decide.
 */
export function fromIntl(intl: IntlShapeLike, formattingLocale?: string): Translator {
  return wrap({
    catalogLocale: intl.locale,
    formattingLocale,
    translate: (key, params) => intl.formatMessage({ id: key }, params),
  });
}

/** The part of a Lingui `I18n` instance this adapter calls. */
export interface LinguiLike {
  /** The active locale tag. */
  readonly locale: string;
  /** Lingui's lookup, keyed by message id. */
  _(id: string, values?: Record<string, unknown>): string;
}

/**
 * A `Translator` backed by a Lingui `I18n` instance.
 *
 * Lingui also resolves plurals inside the message, so this is the same shape as {@link fromIntl} — the
 * two differ only in what the lookup is called.
 */
export function fromLingui(i18n: LinguiLike, formattingLocale?: string): Translator {
  return wrap({
    catalogLocale: i18n.locale,
    formattingLocale,
    translate: (key, params) => i18n._(key, params),
  });
}
