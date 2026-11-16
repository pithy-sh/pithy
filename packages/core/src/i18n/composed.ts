// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "../capability/capability";
import type { MessageCatalog } from "./catalog";
import { isLocale } from "./locale";
import { type LocaleExceptions, matchLocale } from "./match";
import { createTranslator, DEFAULT_LOCALE, type Translator } from "./translator";

/** The part of `@pithy-sh/i18n`'s resolved config this reads, every field unverified until checked. */
interface ConfigLike {
  readonly defaultLocale?: unknown;
  readonly supportedLocales?: unknown;
  readonly exceptions?: unknown;
}

/** The catalog layers for one locale, most-specific first — the shape `@pithy-sh/i18n` publishes as `layersFor`. */
type LayersFor = (locale: string) => readonly (MessageCatalog | undefined)[];

/**
 * A translator in `locale` over the composed i18n capability's layers — for words read in somebody else's language
 * than the request's: a person's own, stored on their account. `c.var.t` answers in the caller's.
 *
 * Found structurally, never imported, so a capability needing it does not depend on `@pithy-sh/i18n`: the capability
 * named `i18n` that publishes `layersFor`, and its resolved config.
 *
 * The stored tag is matched against the config's `supportedLocales` and `exceptions` before any layer is read, the way
 * the request path resolves the same column: `es-MX` reads `es`, and a locale the project does not offer reads the
 * project default rather than a kit catalog the project never serves. A null, unusable or unmatched locale reads the
 * default. Null when no i18n capability is composed, where nothing is translated.
 */
export function composedTranslator(capabilities: readonly Capability[], locale: string | null): Translator | null {
  for (const capability of capabilities) {
    if (capability.name !== "i18n") continue;
    const layersFor = (capability as { layersFor?: unknown }).layersFor;
    if (typeof layersFor !== "function") continue;
    const config = (capability as { i18nConfig?: ConfigLike }).i18nConfig ?? {};
    const configured = config.defaultLocale;
    const fallback = typeof configured === "string" && isLocale(configured) ? configured : DEFAULT_LOCALE;
    const supported = Array.isArray(config.supportedLocales)
      ? config.supportedLocales.filter((entry): entry is string => typeof entry === "string")
      : [fallback];
    const exceptions =
      typeof config.exceptions === "object" && config.exceptions !== null
        ? (config.exceptions as LocaleExceptions)
        : {};
    const matched = locale !== null && isLocale(locale) ? matchLocale([locale], supported, exceptions) : null;
    const tag = matched?.locale ?? fallback;
    return createTranslator({ catalogLocale: tag, layers: (layersFor as LayersFor)(tag) });
  }
  return null;
}
