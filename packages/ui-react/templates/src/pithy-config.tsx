import authModule from "virtual:pithy/auth";
import paymentsModule from "virtual:pithy/payments";
import turnstileModule from "virtual:pithy/turnstile";

/**
 * The composed capabilities' client-safe config, narrowed once for the whole client.
 *
 * `virtual:pithy/<capability>` is a union discriminated on `enabled`, because a capability that is
 * not composed projects `{ enabled: false }` and nothing else — that is what makes importing an
 * absent capability safe instead of a build error. Narrowing at every use would put a guard in front
 * of every field read, so it happens here instead, once.
 *
 * The `enabled: false` branch carries the capability's own defaults rather than `undefined`, so a
 * screen reads a field without a guard. Those defaults are not a fallback anyone should rely on:
 * `pithy ui add --auth` refuses a Worker that does not compose `auth`, so on a scaffolded project the
 * enabled branch is always the live one. They exist for the case where the capability is removed from
 * `pithy.config.ts` *after* the scaffold — the screens keep compiling, and `enabled` is there so one
 * can bail cleanly rather than render a form that posts nowhere.
 */
export const authConfig = authModule.enabled
  ? authModule
  : {
      enabled: false as const,
      basePath: "/auth",
      providers: { google: false, apple: false, facebook: false, github: false },
      otpLength: 6,
      signUpEnabled: true,
    };

/** Turnstile's projection, narrowed the same way. `enabled` is false unless a login widget resolved. */
export const turnstileConfig = turnstileModule.enabled
  ? turnstileModule
  : {
      enabled: false as const,
      sitekey: "",
      mode: "visible" as const,
      token: { field: "cf-turnstile-response", header: null },
    };

/**
 * Payments' projection, narrowed the same way. `enabled` is false when the capability is not composed, and
 * also when it is composed with an empty catalog — a paywall with nothing on it is nothing to render, so
 * the two read alike and a screen branches once.
 *
 * Only the browser-safe half of the catalog is here. Apple's issuer id, Google's service-account
 * credentials and Stripe's secret and signing keys live in the secrets store and never enter a projection.
 */
export const paymentsConfig = paymentsModule.enabled
  ? paymentsModule
  : {
      enabled: false as const,
      environment: "dev",
      rails: { apple: false, google: false, stripe: false, lemonSqueezy: false },
      basePath: "/payments",
      products: [] as {
        id: string;
        type: "consumable" | "non_consumable" | "subscription";
        entitlements: string[];
        name: string;
        stripePriceId: string | null;
        lemonSqueezyVariantId: string | null;
      }[],
    };
