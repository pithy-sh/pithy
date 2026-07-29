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
