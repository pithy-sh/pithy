// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/** Every native module that has a stand-in, and the stand-in's file under `testing/`. */
export const STAND_INS: Readonly<Record<string, string>> = {
  "expo-secure-store": "expo-secure-store.ts",
  "expo-constants": "expo-constants.ts",
  "expo-crypto": "expo-crypto.ts",
  "expo-router": "expo-router.ts",
  "expo-web-browser": "expo-web-browser.ts",
  "expo-linking": "expo-linking.ts",
  "expo-localization": "expo-localization.ts",
  "expo-apple-authentication": "expo-apple-authentication.ts",
  "expo-iap": "expo-iap.ts",
  "react-native-webview": "react-native-webview.ts",
  "@react-native-async-storage/async-storage": "async-storage.ts",
  "@react-native-google-signin/google-signin": "google-signin.ts",
};
