// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useSyncExternalStore } from "react";
import { singleton } from "./singleton";

/** One of the device's preferred languages, as far as the kit reads one. */
export interface Locale {
  languageTag: string;
  languageCode: string | null;
  regionCode: string | null;
  textDirection: "ltr" | "rtl" | null;
}

const listeners = singleton("localizationListeners", () => new Set<() => void>());

function entry(languageTag: string, textDirection: "ltr" | "rtl" = "ltr"): Locale {
  const [languageCode = null, regionCode = null] = languageTag.split("-");
  return { languageTag, languageCode, regionCode, textDirection };
}

/** `expo-localization`: the device's languages, which a test changes while the app runs. */
export const localization = singleton("localization", () => ({
  locales: [entry("en-US")],
  setDevice(tags: readonly string[]): void {
    this.locales = tags.map((tag) => entry(tag, /^(ar|he|fa|ur)\b/.test(tag) ? "rtl" : "ltr"));
    for (const listener of listeners) listener();
  },
  reset(): void {
    this.locales = [entry("en-US")];
  },
}));

export function getLocales(): Locale[] {
  return localization.locales;
}

export function useLocales(): Locale[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => localization.locales,
  );
}

export function getCalendars(): { calendar: string; timeZone: string }[] {
  return [{ calendar: "gregory", timeZone: "UTC" }];
}
