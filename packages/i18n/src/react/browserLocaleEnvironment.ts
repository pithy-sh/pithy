// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useMemo } from "react";
import { readBrowserSignals, rememberBrowserLocale } from "../browser/signals";
import type { BrowserLocaleSignals } from "../resolve/browser";
import type { LocaleEnvironment, LocaleKeys } from "./localeEnvironment";
import { useDocumentLocale } from "./useDocumentLocale";

/** The query string, `localStorage`, `navigator` and `<html lang>`, read once per pair of names. */
function useBrowserSignals(keys: LocaleKeys | null): BrowserLocaleSignals | undefined {
  const queryParam = keys?.queryParam;
  const storageKey = keys?.storageKey;
  return useMemo(
    () =>
      queryParam === undefined || storageKey === undefined ? undefined : readBrowserSignals({ queryParam, storageKey }),
    [queryParam, storageKey],
  );
}

/** `lang` and `dir` on the document. A browser lays out a new direction at once, so no reload is ever needed. */
function useDocumentApply(enabled: boolean, locale: string, direction: "ltr" | "rtl"): boolean {
  useDocumentLocale(enabled, locale, direction);
  return false;
}

/** The browser's locale environment: what `useNegotiatedLocale` uses when it is handed none. */
export const browserLocaleEnvironment: LocaleEnvironment = {
  useSignals: useBrowserSignals,
  remember: rememberBrowserLocale,
  useApply: useDocumentApply,
};
