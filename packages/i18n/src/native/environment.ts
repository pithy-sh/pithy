// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useRead } from "@pithy-sh/ui-core/src/read";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLocales } from "expo-localization";
import { useMemo } from "react";
import type { LocaleEnvironment, LocaleKeys } from "../react/localeEnvironment";
import type { BrowserLocaleSignals } from "../resolve/browser";
import { useNativeDirection } from "./useNativeDirection";

/**
 * React Native's locale environment. Pass it as `useNegotiatedLocale(projection, { environment: nativeLocaleEnvironment })`.
 *
 * - **Starting signals:** the device's preferred languages from `expo-localization`, in the order the reader set
 *   them, and a choice remembered in AsyncStorage. `useLocales` re-renders when the operating system's language
 *   changes, so the app follows it while it runs. There is no query string and no server-rendered `lang`, so those
 *   two links of the chain answer nothing.
 * - **Remember:** AsyncStorage, under the projection's `storageKey`. A locale is not a secret, so it is not kept in
 *   the secure store.
 * - **Apply:** `I18nManager`, whose direction takes effect after a reload. `reloadRequired` says when.
 */
export const nativeLocaleEnvironment: LocaleEnvironment = {
  useSignals: useNativeSignals,
  remember: (locale, keys) => AsyncStorage.setItem(keys.storageKey, locale),
  useApply: (enabled, _locale, direction) => useNativeDirection(enabled, direction),
};

/** The device's languages and this device's remembered choice; `undefined` until the memory has been read. */
function useNativeSignals(keys: LocaleKeys | null): BrowserLocaleSignals | undefined {
  const device = useLocales();
  const storageKey = keys?.storageKey;
  const memory = useRead(
    `pithy-locale-memory:${storageKey ?? ""}`,
    async (): Promise<string | null> => (storageKey === undefined ? null : readMemory(storageKey)),
    { skip: storageKey === undefined },
  );
  const navigator = useMemo(() => {
    const tags = device.map((entry) => entry.languageTag).filter((tag) => tag.trim().length > 0);
    return tags.length > 0 ? tags : null;
  }, [device]);
  const remembered = memory.value ?? null;
  const ready = storageKey !== undefined && !memory.loading;
  return useMemo(
    () => (ready ? { query: null, storage: remembered, navigator, server: null } : undefined),
    [ready, remembered, navigator],
  );
}

/** The remembered choice, or `null` when there is none or the store refuses. */
async function readMemory(storageKey: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(storageKey);
  } catch {
    return null;
  }
}
