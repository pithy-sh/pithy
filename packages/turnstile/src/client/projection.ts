// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a browser may know about this project's Turnstile — the shape of `virtual:pithy/turnstile`.
 *
 * **This declaration is the contract, and the projection is checked against it.** It is written here
 * rather than inferred from the closure that builds it, and that is the whole point: an inferred type
 * follows whatever the producer last happened to say, so a projection that dropped a field, or widened
 * `mode` because the config grew a third widget, would take the type with it and nothing would go red.
 * Declared, the arrow is the thing that has to change. Adding a widget mode to `TurnstileConfig` is a
 * compile error at `client:` until somebody decides, on purpose, whether a browser should see it.
 *
 * **This is the only statement of the shape.** `@pithy-sh/ui-react`'s `templates/client-env.d.ts` — the
 * ambient declaration `pithy ui add react` copies into an adopter's Worker — is generated from this type
 * by `@pithy-sh/vite`'s `clientEnvDeclaration.ts` (#398). The unions and the per-field doc comments below
 * are emitted verbatim, so what is written here is what a screen author reads.
 */
export type TurnstileClientProjection =
  | {
      /**
       * Turnstile is not composed, or has no renderable login widget for this environment. A screen
       * branches rather than mounting a widget that cannot solve.
       */
      enabled: false;
    }
  | {
      /** Turnstile is composed AND has a renderable login widget for this environment. */
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
      token: {
        /** The body field the middleware reads the token from. */
        field: string;
        /** The header it reads instead, or null when none is configured. */
        header: string | null;
      };
    };
