// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { formattingLocaleOf, type LocaleContext, localeDirection } from "@pithy-sh/core/src/i18n/locale";
import { matchLocale } from "@pithy-sh/core/src/i18n/match";
import type { I18nClientProjection } from "../client/projection";
import { applyDocumentLocale } from "./signals";

/**
 * The document's opening language, negotiated from what `virtual:pithy/i18n` projects.
 *
 * **The entry point a scaffolded `client.tsx` calls, and the reason it is one line there.** A template
 * is copied into an adopter's repository and never rewritten, so anything it does by hand is frozen on
 * the day they scaffold. Two things in particular must not be: the guarded storage reads — `localStorage`
 * throws in a private window, behind a site-data block, and inside some embedded views — and the chain
 * order itself, which is the project's configuration rather than the front end's assumption.
 *
 * **It takes the projection, not an `I18nConfig`.** The projection is browser-safe by construction and
 * is what a client actually holds: `browserResolvers` arrives as `string[]` because the generated
 * ambient declaration in an adopter's Worker cannot name a type it does not import, so the chain is
 * walked by name and an unrecognized link contributes nothing rather than throwing.
 *
 * **This is the first pass, not the decision.** It reaches only what a page can see before it renders:
 * the URL, this device's memory, and whatever the server put on `<html lang>`. A signed-in reader's
 * stored preference needs a session, which needs a render — `useNegotiatedLocale` picks that up and
 * calls {@link applyDocumentLocale} again if it lands somewhere else. Doing it here as well is what
 * keeps a right-to-left reader from watching the page reflow after the first paint.
 *
 * Answers **both** locales it resolved, or `null` when the capability is not composed and there was
 * nothing to negotiate — a project without it keeps the `lang` its `index.html` shipped.
 *
 * **Both, and not the one tag `lang` carries.** This returned a single string at first, and the
 * scaffolded provider then passed it as `catalogLocale` *and* `formattingLocale` — which is exactly the
 * collapse the two-locale design exists to prevent, reintroduced in the one place a reader actually
 * looks at a page. An `es-AR` visitor got Argentine dates from the Worker and Spanish-from-Spain dates
 * from the SPA, on the same account, in the same session. The region survives here for the same reason
 * `resolveChain` keeps it on the server: the range the reader asked for is a fact the match already
 * knows, and throwing it away is a decision, not an omission.
 */
export function applyProjectedLocale(projection: I18nClientProjection): LocaleContext | null {
  if (!projection.enabled) return null;
  const wanted: string[] = [];
  for (const resolver of projection.browserResolvers) {
    const tag = signal(resolver, projection);
    if (tag) wanted.push(tag);
  }
  const matched = matchLocale(wanted, projection.supportedLocales, projection.exceptions);
  const catalogLocale = matched?.locale ?? projection.defaultLocale;
  // The reader's own tag, canonicalized, when the range that matched is one `Intl` accepts — `es-ar`
  // becomes `es-AR`. A range that is not a constructible tag (a wildcard, an exception-map key)
  // formats as the catalog locale, which is the same rule the server chain applies.
  const requested = matched ? formattingLocaleOf(matched.range) : null;
  const resolved: LocaleContext = {
    catalogLocale,
    formattingLocale: requested ?? catalogLocale,
    direction: localeDirection(catalogLocale),
  };
  applyDocumentLocale(resolved.catalogLocale, resolved.direction);
  return resolved;
}

/**
 * One link of the browser chain, by name.
 *
 * `account` answers nothing: there is no session before a render, and inventing one here would be a
 * second source of truth for a fact `pithy_auth_users.locale` owns. It stays in the list so the
 * configured order is walked whole, and so the link that follows it is still asked in its own place.
 */
function signal(resolver: string, projection: Extract<I18nClientProjection, { enabled: true }>): string | null {
  switch (resolver) {
    case "query":
      return read(() => new URL(window.location.href).searchParams.get(projection.queryParam));
    case "storage":
      return read(() => window.localStorage.getItem(projection.storageKey));
    case "navigator":
      // The pre-render pass takes only the reader's first choice: this runs before paint to keep an
      // RTL page from reflowing, and each link here offers one range. The full weighted list is walked
      // a moment later by `useNegotiatedLocale`, which can afford it.
      return read(() => window.navigator.languages?.[0] ?? window.navigator.language ?? null);
    case "server":
      return read(() => document.documentElement.lang || null);
    case "default":
      return projection.defaultLocale;
    default:
      return null;
  }
}

/** Read a global, answering `null` rather than throwing when the global is absent or refuses. */
function read(get: () => string | null): string | null {
  try {
    return get();
  } catch {
    return null;
  }
}
