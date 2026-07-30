/// <reference types="vite/client" />

// The client-safe projection of this worker's composed capabilities, served by @pithy-sh/vite.
//
// Each module is a DEFAULT export whose type is a union discriminated on `enabled`. That shape is
// deliberate. A capability that is not composed projects `{ enabled: false }` and nothing else, so a
// NAMED import of any other key would be a missing export and the build would fail — on exactly the
// case this mechanism exists to make survivable. Importing the default and narrowing cannot fail:
//
//   import turnstile from "virtual:pithy/turnstile";
//   if (!turnstile.enabled) return null;   // narrowed: sitekey, mode and token exist below this line
//
// Nothing is generated to disk. These declarations describe modules the Vite plugin serves.

declare module "virtual:pithy/auth" {
  /** Whether the auth capability is composed on this worker. Also the union's discriminant. */
  export const enabled: boolean;

  const config:
    | { enabled: false }
    | {
        enabled: true;
        /** The path the auth handler mounts under, e.g. `/auth`. */
        basePath: string;
        /** Which social providers are switched on in pithy.config.ts. Credentials never reach the client. */
        providers: { google: boolean; apple: boolean; facebook: boolean; github: boolean };
        /** How many digits an email OTP carries. */
        otpLength: number;
        /** Whether signing in may provision a new user. Drives the sign-up copy. */
        signUpEnabled: boolean;
      };
  export default config;
}

declare module "virtual:pithy/payments" {
  /** Whether payments is composed AND has a catalog this environment can render. */
  export const enabled: boolean;

  const config:
    | { enabled: false }
    | {
        enabled: true;
        /** The environment this bundle was built for. */
        environment: string;
        /** Which rails this project sells through. Apple and Google are display-only on the web. */
        rails: { apple: boolean; google: boolean; stripe: boolean };
        /** Where the payments routes mount, e.g. `/payments`. */
        basePath: string;
        /**
         * The catalog, browser-safe. Stripe price ids are publishable by design — a Checkout Session
         * names one. Apple's and Google's SKUs, and anything a purchase fulfils beyond its
         * entitlements, stay server-side.
         */
        products: {
          /** The logical product id — what `/payments/checkout` is asked for. */
          id: string;
          /** What kind of product it is. */
          type: "consumable" | "non_consumable" | "subscription";
          /** The entitlement keys it grants. Gating code names these, never the product. */
          entitlements: string[];
          /** The display name a paywall renders. */
          name: string;
          /** The Stripe price, or null for a product this project does not sell through Stripe. */
          stripePriceId: string | null;
        }[];
      };
  export default config;
}

declare module "virtual:pithy/turnstile" {
  /** Whether turnstile is composed AND has a renderable login widget for this environment. */
  export const enabled: boolean;

  const config:
    | { enabled: false }
    | {
        enabled: true;
        /** The public sitekey for the build's environment. The widget secret stays in the secrets store. */
        sitekey: string;
        /** The widget mode `protect.login` names. */
        mode: "visible" | "invisible";
        /** Where the response token goes: a body field, or a header when one is configured. */
        token: { field: string; header: string | null };
      };
  export default config;
}
