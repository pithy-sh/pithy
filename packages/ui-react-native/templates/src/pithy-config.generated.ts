// Written from apps/__PITHY_WORKER__'s composed config. Pithy's `ui sync --app` rewrites it when that config
// changes, and keeps the fields below that are yours.
//
// Yours to edit, and kept by a sync: `appScheme`, `universalLinkOrigin`, `google` and `rails`.
//
// `rails.ios`, `rails.android` and `rails.web` name the rail each platform sells through: "apple", "google",
// "stripe", "lemonSqueezy", "paddle", or "none" to show plans and sell nothing. Change one here, or pass
// `--ios-rail`, `--android-rail` or `--web-rail` to `ui sync --app`. A rail the Worker does not enable is
// refused. A web rail on a phone opens checkout in the system browser.
//
// `origins` holds where the Worker answers in each environment, and a build calls the one
// `EXPO_PUBLIC_PITHY_ENV` names: dev, staging or prod, dev when it is unset. An origin is null when Pithy
// could not find it: a Worker that answers only on workers.dev, or one that declares no domain. Set
// `origins.staging` or `origins.prod` by hand then, and a sync keeps it until the Worker declares one.
// A dev origin that is not this machine's loopback, such as your network address for a device, is kept too.
//
// Everything else is the Worker's. Change its pithy.config.ts and run `ui sync --app` again.
// The value stays a plain literal: strings, numbers, true, false, null, arrays and objects. A sync reads it
// back without running it, so it holds no expression, no variable and no import.
import type { GeneratedPithyConfig } from "./pithy-config";

const config: GeneratedPithyConfig = {
  origins: {
    dev: "http://localhost:8787",
    staging: null,
    prod: null,
  },
  appScheme: "pithyapp",
  universalLinkOrigin: null,
  rails: {
    ios: "apple",
    android: "google",
    web: "none",
  },
  google: {
    webClientId: null,
    iosClientId: null,
  },
  auth: {
    enabled: false,
  },
  i18n: {
    enabled: false,
  },
  payments: {
    enabled: false,
  },
  turnstile: {
    enabled: false,
  },
};

export default config;
