import type { ConfigContext, ExpoConfig } from "expo/config";
import { exportedOrigin } from "./metro-proxy.cjs";
import generated from "./src/pithy-config.generated.ts";

/** Expo evaluates this file in Node, in the `expo start` process `pithy dev` runs with the Worker's origin. */
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

/** The host whose https links open the app, once `universalLinkOrigin` names one. */
const universalHost = generated.universalLinkOrigin?.replace(/^https:\/\//, "") ?? null;

/** Google's iOS sign-in returns on the reversed client id, as a URL scheme. */
const googleIosScheme = generated.google.iosClientId
  ? generated.google.iosClientId.split(".").reverse().join(".")
  : null;

/**
 * Whether any environment the app builds for enforces attestation. App Attest then needs its entitlement, and its
 * App ID the App Attest capability. A `test` environment sends the test assertion and needs neither.
 */
const enforcesAttestation = Object.values(generated.auth).some(
  (projection) => projection?.enabled === true && projection.attestation?.mode === "enforce",
);

/** App Attest's environment: Apple's production service for a prod build, its development service otherwise. */
const appAttestEnvironment = process.env.EXPO_PUBLIC_PITHY_ENV === "prod" ? "production" : "development";

/**
 * The Expo app's config, read from the same file the screens read. The scheme a sign-in returns to and the origin
 * a checkout returns through are stated once, in `src/pithy-config.generated.ts`, so the app cannot answer to a
 * link the config does not name.
 *
 * `extra.pithyDevOrigin` is the origin `pithy dev` exports for the app's Worker, read the way `metro-proxy.cjs`
 * reads it, or `null` when it is unset. A dev build on a phone calls it instead of a loopback `origins.dev`, which is
 * committed and holds the main checkout's port, while each feature worktree has its own.
 *
 * The name and the bundle identifiers are yours: set `ios.bundleIdentifier` and `android.package` before a store
 * build, and give Apple sign-in the same identifier the Worker's `appBundleIdentifier` names.
 */
export default ({ projectRoot }: ConfigContext): ExpoConfig => ({
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
    ...(enforcesAttestation
      ? { entitlements: { "com.apple.developer.devicecheck.appattest-environment": appAttestEnvironment } }
      : {}),
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
  extra: { pithyDevOrigin: exportedOrigin(projectRoot, process.env) },
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
