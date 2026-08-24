// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { I18nConfig } from "../config/config";
import type { BrowserLocaleSignals } from "../resolve/browser";

/**
 * The browser-side edge of locale resolution: the three signals a page can read for itself.
 *
 * **Separate from `resolve/browser.ts` on purpose.** That module is a pure function — signals in,
 * locale out — so it typechecks and tests in the Worker program with no DOM library in scope. This one
 * touches globals, so it lives in the browser program (`tsconfig.browser.json`) and nothing a Worker
 * bundles can reach it. Effects at the edge; the decision in the middle.
 */

/**
 * What the page can see: the query string, this device's memory, and what the server put on `<html lang>`.
 *
 * `account` is deliberately absent — the app knows whether someone is signed in and this function does
 * not. Merge it in at the call site.
 *
 * **Every read is wrapped**, because two of the three throw in real browsers. `localStorage` raises in
 * a private window, behind a site-data block, and in some embedded views; and during a server render
 * there is no `window` or `document` at all. A reader whose browser refuses storage still gets a
 * language — just not a remembered one.
 */
export function readBrowserSignals(config: I18nConfig): BrowserLocaleSignals {
  return {
    query: read(() => new URL(window.location.href).searchParams.get(config.queryParam)),
    storage: read(() => window.localStorage.getItem(config.storageKey)),
    // The reader's own preference order. Guarded like the rest: `navigator` is absent during a server
    // render, and `languages` is absent in a few older browsers where `language` is the whole of it.
    navigator: readList(() => [...(window.navigator.languages ?? [window.navigator.language])]),
    server: read(() => document.documentElement.lang || null),
  };
}

/** Remember `locale` on this device. Silent when storage is unavailable — a preference is not worth a throw. */
export function rememberBrowserLocale(locale: string, config: I18nConfig): void {
  try {
    window.localStorage.setItem(config.storageKey, locale);
  } catch {
    // A private window, a cleared site-data setting, a browser told to block storage. The reader still
    // gets the language they asked for this visit; only the memory of it is lost.
  }
}

/**
 * Put `lang` and `dir` on the document.
 *
 * The one thing no catalog can do and every screen needs: assistive technology, hyphenation, and the
 * browser's own text handling all read `lang`, and `dir` is what makes a right-to-left locale lay out
 * at all. `templates/index.html` ships `lang="en"` as static text with no substitution token, so the
 * script side is the only hook there is.
 */
export function applyDocumentLocale(locale: string, direction: "ltr" | "rtl"): void {
  try {
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
  } catch {
    // No document — a server render, or a test environment without one. Nothing to set and nothing
    // to report: the markup a server render produces carries the same two attributes already.
  }
}

/** Read a list off a global, answering `null` rather than throwing when the global is absent. */
function readList(get: () => string[]): string[] | null {
  try {
    const list = get().filter((tag) => typeof tag === "string" && tag.trim().length > 0);
    return list.length > 0 ? list : null;
  } catch {
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
