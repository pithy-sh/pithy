import type { ExpoConfig } from "expo/config";
import generated from "./src/pithy-config.generated";

/** The host whose https links open the app, once `universalLinkOrigin` names one. */
const universalHost = generated.universalLinkOrigin?.replace(/^https:\/\//, "") ?? null;

/** Google's iOS sign-in returns on the reversed client id, as a URL scheme. */
const googleIosScheme = generated.google.iosClientId
  ? generated.google.iosClientId.split(".").reverse().join(".")
  : null;

/**
 * The Expo app's config, read from the same file the screens read. The scheme a sign-in returns to and the origin
 * a checkout returns through are stated once, in `src/pithy-config.generated.ts`, so the app cannot answer to a
 * link the config does not name.
 *
 * The name and the bundle identifiers are yours: set `ios.bundleIdentifier` and `android.package` before a store
 * build, and give Apple sign-in the same identifier the Worker's `appBundleIdentifier` names.
 */
export default (): ExpoConfig => ({
  name: "__PITHY_APP__",
  slug: "__PITHY_APP__",
  scheme: generated.appScheme,
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  ios: {
    supportsTablet: true,
    usesAppleSignIn: true,
    associatedDomains: universalHost ? [`applinks:${universalHost}`] : [],
  },
  android: {
    intentFilters: universalHost
      ? [
          {
            action: "VIEW",
            autoVerify: true,
            data: [{ scheme: "https", host: universalHost }],
            category: ["BROWSABLE", "DEFAULT"],
          },
        ]
      : [],
  },
  web: { output: "single" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-localization",
    "expo-web-browser",
    "expo-apple-authentication",
    "expo-iap",
    ...(googleIosScheme
      ? [["@react-native-google-signin/google-signin", { iosUrlScheme: googleIosScheme }] as [string, unknown]]
      : []),
  ],
});
