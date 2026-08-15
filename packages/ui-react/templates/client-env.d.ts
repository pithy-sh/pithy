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
        rails: { apple: boolean; google: boolean; stripe: boolean; lemonSqueezy: boolean; paddle: boolean };
        /**
         * What Paddle.js needs to initialize, or null when the rail is off. The client token is
         * publishable by design — it is what a browser opens a checkout with — and the API key and the
         * webhook signing secret are neither here nor expressible here.
         */
        paddle: { clientToken: string; environment: "sandbox" | "production"; checkout: string } | null;
        /** Where the payments routes mount, e.g. `/payments`. */
        basePath: string;
        /**
         * The catalog, browser-safe. A web rail's price id is publishable by design — a checkout names
         * one. Apple's and Google's SKUs, and anything a purchase fulfils beyond its entitlements, stay
         * server-side.
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
          /**
           * This product's SKU on each web rail, or null where it is not sold. Keyed by rail rather
           * than one field per rail, so a screen asks `skus[rail]` and a new rail cannot leave a
           * `purchasable()` check silently out of date.
           */
          skus: {
            /** The Stripe price id. */
            stripe: string | null;
            /** The Lemon Squeezy variant id. */
            lemonSqueezy: string | null;
            /** The Paddle price id. */
            paddle: string | null;
          };
        }[];
      };
  export default config;
}

declare module "virtual:pithy/support" {
  /** Whether support is composed AND serving the in-app submission routes — the only ones a browser calls. */
  export const enabled: boolean;

  const config:
    | { enabled: false }
    | {
        enabled: true;
        /** Where the support routes mount, e.g. `/support`. `POST {basePath}/feedback` writes in. */
        basePath: string;
        /**
         * What one submission may carry. Hold a compose form to these so the handler does not have to
         * refuse after somebody pressed Send. The taxonomy is not here: a category's text is the
         * instruction a classifier reads, not copy for a chooser.
         */
        submission: {
          /** The longest subject accepted. It becomes the thread's name in the inbox. */
          maxSubjectChars: number;
          /** The longest report body accepted. */
          maxBodyChars: number;
          /** What an upload control may offer, or null when attachments are off and it renders none. */
          attachments: {
            /** How many files one submission may carry. */
            maxCount: number;
            /** The largest single file, measured on the decoded bytes. */
            maxBytes: number;
            /** The exact MIME types accepted — an allowlist, and the `accept` a file input wants. */
            allowedContentTypes: string[];
          } | null;
        };
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
        /**
         * The action label the widget must be solved for. Render it, never retype it: the sign-in route
         * asserts this exact string against the token, and dev and staging cannot notice a copy that has
         * drifted — Cloudflare's test keys answer with no action at all, so the first environment that
         * can tell is the one where a mismatch refuses every sign-in. #377.
         */
        action: string;
        /** Where the response token goes: a body field, or a header when one is configured. */
        token: { field: string; header: string | null };
      };
  export default config;
}
