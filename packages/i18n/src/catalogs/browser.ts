// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";

/**
 * The kit's catalogs, as one dynamic import per locale.
 *
 * **A static map of thunks, not a computed specifier.** `import(\`./es/${locale}\`)` is a specifier no
 * bundler can resolve, so it either fails the build or pulls every match into one chunk; written out,
 * Rollup emits exactly one chunk per locale and a reader downloads only their own. That is the whole
 * reason catalogs are not on the `virtual:pithy/i18n` projection, which `renderVirtualModule` inlines
 * as a `JSON.stringify` literal into the main chunk.
 *
 * English is absent for the same reason it is absent from {@link KIT_CATALOGS}: a copied screen already
 * carries the English it was scaffolded with, and that is the only catalog that survives being copied.
 */
const LOADERS: Record<string, () => Promise<MessageCatalog>> = {
  es: () => import("./es/index").then((module) => module.es),
};

/**
 * Whether the kit ships a catalog for `locale`. English answers `false` — it is the baked fallback.
 *
 * **`Object.hasOwn`, never `in`.** The argument is a language tag, and a language tag is whatever a
 * reader put after `?lang=`. `"__proto__" in LOADERS` is `true` — the accessor is on `Object.prototype`
 * — so `in` answered yes for a locale the kit has never written, and {@link loadKitCatalog} then read
 * `Object.prototype` back as a loader and called it.
 */
export function hasKitCatalog(locale: string): boolean {
  return Object.hasOwn(LOADERS, locale);
}

/** The kit's catalog for `locale`, or an empty one when the kit writes nothing in that language. */
export async function loadKitCatalog(locale: string): Promise<MessageCatalog> {
  if (!hasKitCatalog(locale)) return {};
  const load = LOADERS[locale];
  return load ? await load() : {};
}
