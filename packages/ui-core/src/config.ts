// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a client reads of each capability when the capability is not composed.
 *
 * A capability's client projection is a union discriminated on `enabled`: one that is not composed projects
 * `{ enabled: false }` and nothing else. A client narrows each projection once, in its `pithy-config`, to the
 * projection itself or the default here, so a screen reads a field without a guard. The defaults are not a value
 * anyone should rely on — `pithy ui add` refuses a Worker that does not compose what the screens need — they keep
 * the screens compiling when a capability is removed after the scaffold, and `enabled` is there so one can bail
 * cleanly rather than render a form that posts nowhere.
 *
 * Both template sets narrow against these, so the default for each capability is stated once.
 */

/** One product in the payments catalog, as a client reads it. */
export interface PaymentsProductConfig {
  /** The logical product id — what checkout is asked for. */
  id: string;
  /** What kind of product it is. */
  type: "consumable" | "non_consumable" | "subscription";
  /** The entitlement keys it grants. */
  entitlements: string[];
  /** The display name a paywall renders. */
  name: string;
  /**
   * This product's SKU on each rail, or null where it is not sold. `apple` and `google` are optional: a Worker
   * on an older kit does not project them, and absent reads the same as null.
   */
  skus: {
    apple?: string | null;
    google?: string | null;
    stripe: string | null;
    lemonSqueezy: string | null;
    paddle: string | null;
  };
}

/** What Paddle.js needs to initialize, when the Paddle rail is on. */
export interface PaddleConfig {
  /** The publishable client token Paddle.js initializes with. */
  clientToken: string;
  /** Which Paddle account the token belongs to. */
  environment: "sandbox" | "production";
  /** How checkout is presented. */
  checkout: string;
}

/** Auth when it is not composed: no providers, the kit's base path, and the kit's code length. */
export const AUTH_DISABLED = {
  enabled: false as const,
  basePath: "/auth",
  providers: { google: false, apple: false, facebook: false, github: false, microsoft: false },
  otpLength: 6,
  signUpEnabled: true,
};

/**
 * Turnstile when it is not composed. The sitekey and the action are blank: a widget that cannot render has no
 * action to solve for, and a plausible default here would be a second copy of a string the enabled projection is
 * the only statement of.
 */
export const TURNSTILE_DISABLED = {
  enabled: false as const,
  sitekey: "",
  action: "",
  mode: "visible" as const,
  token: { field: "cf-turnstile-response", header: null },
};

/** Payments when it is not composed, or composed with an empty catalog: nothing on sale through any rail. */
export const PAYMENTS_DISABLED = {
  enabled: false as const,
  environment: "dev",
  rails: { apple: false, google: false, stripe: false, lemonSqueezy: false, paddle: false },
  basePath: "/payments",
  paddle: null as PaddleConfig | null,
  products: [] as PaymentsProductConfig[],
};

/**
 * i18n when it is not composed. `en` is not a claim that the project speaks English — it is what the templates
 * are written in, and what `t()` falls back to when nothing negotiated.
 */
export const I18N_DISABLED = {
  enabled: false as const,
  supportedLocales: ["en"],
  defaultLocale: "en",
  queryParam: "lang",
  storageKey: "pithy.locale",
  browserResolvers: ["query", "account", "storage", "navigator", "server", "default"],
  exceptions: {} as Record<string, string>,
};
