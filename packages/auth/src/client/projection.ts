// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a browser may know about this project's auth — the shape of `virtual:pithy/auth`.
 *
 * **This declaration is the contract, and the projection is checked against it.** It is written here
 * rather than inferred from the closure that builds it, and that is the whole point: an inferred type
 * follows whatever the producer last happened to say, so a projection that dropped `otpLength`, or that
 * started projecting `baseURL` because one screen wanted it, would take the type with it and nothing
 * would go red. Declared, both are a compile error at the `client:` that wrote them, and widening what
 * every adopter's bundle carries becomes a decision made here, on purpose.
 *
 * The `enabled: false` branch is not this capability's to produce. `resolveClientProjection` answers it
 * for a capability nobody composed, and a front end is written against the capabilities it *may* have.
 * It is declared here because it is what a browser reads, and the browser cannot tell the two apart.
 *
 * **This is the only statement of the shape.** `@pithy-sh/ui-react`'s `templates/client-env.d.ts` — the
 * ambient declaration `pithy ui add react` copies into an adopter's Worker — is generated from this type
 * by `@pithy-sh/vite`'s `clientEnvDeclaration.ts` (#398). The unions and the per-field doc comments below
 * are emitted verbatim, so what is written here is what a screen author reads.
 */
export type AuthClientProjection =
  | {
      /** Auth is not composed on this worker. A screen branches rather than rendering a sign-in form. */
      enabled: false;
    }
  | {
      /** Auth is composed on this worker. */
      enabled: true;
      /** The path the auth handler mounts under, e.g. `/auth`. */
      basePath: string;
      /**
       * Which social providers are switched on in pithy.config.ts. Credentials never reach the client —
       * they are not in the config this projection can see, they are in the secrets store.
       *
       * Nested, so a screen iterates the set rather than naming four booleans. A fifth provider is one
       * key here — and until it is written here, projecting it is a compile error, not a surprise in
       * somebody's bundle.
       */
      providers: {
        /** Whether Sign in with Google is offered. */
        google: boolean;
        /** Whether Sign in with Apple is offered. */
        apple: boolean;
        /** Whether Sign in with Facebook is offered. */
        facebook: boolean;
        /** Whether Sign in with GitHub is offered. */
        github: boolean;
      };
      /** How many digits an email OTP carries. */
      otpLength: number;
      /** Whether signing in may provision a new user. Drives the sign-up copy. */
      signUpEnabled: boolean;
    };
