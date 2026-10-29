// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { I18nManager } from "react-native";
import { afterEach } from "vitest";
import { asyncStorage } from "./async-storage";
import { apple } from "./expo-apple-authentication";
import { cryptoStub } from "./expo-crypto";
import { iap } from "./expo-iap";
import { linking } from "./expo-linking";
import { localization } from "./expo-localization";
import { expoRouter } from "./expo-router";
import { secureStore } from "./expo-secure-store";
import { webBrowser } from "./expo-web-browser";
import { google } from "./google-signin";
import { webViews } from "./react-native-webview";

/**
 * React Native's `I18nManager.isRTL` is the direction this launch started with. React Native Web has no such
 * property, so it is set here the way a left-to-right device launches.
 */
function launchLeftToRight(): void {
  Object.assign(I18nManager, { isRTL: false });
}
launchLeftToRight();

/** Every stubbed native module starts each test the way a fresh install would. */
afterEach(() => {
  launchLeftToRight();
  for (const stub of [
    cryptoStub,
    apple,
    iap,
    linking,
    localization,
    expoRouter,
    secureStore,
    webBrowser,
    asyncStorage,
    google,
    webViews,
  ]) {
    stub.reset();
  }
});
