// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { UI_CORE_VERSION } from "@pithy-sh/ui-core/src/version";
import {
  APP_TOKEN,
  HOME_SCREEN,
  TEMPLATE_DIR,
  TEMPLATE_GROUPS,
  WORKER_TOKEN,
} from "@pithy-sh/ui-react-native/src/templates";
import { kitRange } from "../project/scaffold";
import type { UiStub, UiStubContext, UiStubFile } from "./stubs";

/**
 * The React Native stub: an Expo app for iOS, Android and the web, in an `apps/<name>/` of its own.
 *
 * Unlike the React stub it is not served by the Worker it calls. It has no `wrangler.jsonc`, and its
 * `pithy.worker.jsonc` runs `expo start`, so `pithy dev` starts it beside the Workers and `pithy deploy`
 * leaves it alone. The screens live in `@pithy-sh/ui-react-native`, typechecked against React Native's own
 * types; this module says which of them an invocation writes and how the app runs.
 */

/** The same path in and out — true of every template except the home screen. */
function inPlace(paths: readonly string[]): UiStubFile[] {
  return paths.map((path) => ({ source: path, target: path }));
}

function manifest(context: UiStubContext): UiStubFile[] {
  const files = inPlace(TEMPLATE_GROUPS.base);
  files.push({ source: context.auth ? HOME_SCREEN.auth : HOME_SCREEN.bare, target: HOME_SCREEN.target });
  if (context.auth) files.push(...inPlace(TEMPLATE_GROUPS.auth));
  if (context.payments) files.push(...inPlace(TEMPLATE_GROUPS.payments));
  if (context.organization) files.push(...inPlace(TEMPLATE_GROUPS.organization));
  if (context.consent) files.push(...inPlace(TEMPLATE_GROUPS.consent));
  if (context.mcp) files.push(...inPlace(TEMPLATE_GROUPS.mcp));
  return files;
}

/** Expo SDK 57 on React Native 0.86, each native module at the version that SDK bundles. */
export const reactNativeStub: UiStub = {
  id: "react-native",
  description: "Expo app for iOS, Android and the web, in its own apps/<name>, calling a worker",
  placement: "app",
  templateDir: TEMPLATE_DIR,
  manifest,
  substitutions: (context) => ({ [WORKER_TOKEN]: context.worker, [APP_TOKEN]: context.app ?? context.worker }),
  dependencies: {
    "@expo/metro-runtime": "~57.0.17",
    // The client seams and the translator. Core's version for both, which `.changeset/config.json` releases
    // as one fixed group.
    "@pithy-sh/core": kitRange(PACKAGE_VERSION),
    "@pithy-sh/i18n": kitRange(PACKAGE_VERSION),
    "@pithy-sh/ui-core": kitRange(UI_CORE_VERSION),
    "@react-native-async-storage/async-storage": "2.2.0",
    "@react-native-google-signin/google-signin": "16.2.0",
    expo: "~57.0.31",
    "expo-apple-authentication": "~57.0.2",
    "expo-auth-session": "~57.0.16",
    "expo-constants": "~57.0.22",
    "expo-crypto": "~57.0.4",
    "expo-iap": "6.3.0",
    "expo-linking": "~57.0.13",
    "expo-localization": "~57.0.2",
    "expo-router": "~57.0.29",
    "expo-secure-store": "~57.0.4",
    "expo-web-browser": "~57.0.3",
    react: "^19.2.8",
    "react-dom": "^19.2.8",
    "react-native": "0.86.3",
    "react-native-safe-area-context": "~5.7.0",
    "react-native-screens": "~4.26.0",
    "react-native-web": "~0.21.0",
    "react-native-webview": "13.16.1",
  },
  devDependencies: {
    "@types/react": "^19.2.18",
  },
  // Expo's Metro server on the port `pithy dev` pins for the app. `pithy dev` reads its output through a pipe, and
  // with no terminal attached Expo CLI prints `Waiting on <url>` once Metro listens. The URL may be styled, so only
  // the plain words are matched.
  devCommand: (port) => ["expo", "start", "--port", port],
  readySignal: "^Waiting on ",
  // The web build. `pithy deploy` does not run it: the app is not a Worker. Store builds go through EAS.
  buildCommand: ["expo", "export", "--platform", "web"],
  scripts: {
    start: "expo start",
    android: "expo start --android",
    ios: "expo start --ios",
    web: "expo start --web",
  },
};
