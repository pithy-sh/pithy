// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import { I18nManager } from "react-native";

/**
 * Keep `I18nManager`'s direction in step with the locale in force, and answer whether it needs a reload.
 *
 * React Native reads the direction once, at launch: `forceRTL` changes the next launch, and `isRTL` keeps answering
 * for this one. So the answer is a comparison, not a flag the effect sets. `allowRTL` moves with `forceRTL`, so an
 * English choice on an Arabic device lays out left to right rather than following the device.
 *
 * `enabled` false touches nothing and asks for no reload.
 */
export function useNativeDirection(enabled: boolean, direction: "ltr" | "rtl"): boolean {
  const rtl = direction === "rtl";
  useEffect(() => {
    if (!enabled) return;
    I18nManager.allowRTL(rtl);
    I18nManager.forceRTL(rtl);
  }, [enabled, rtl]);
  return enabled && I18nManager.isRTL !== rtl;
}
