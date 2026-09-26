// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The default request body field a Turnstile widget posts its response token in. Cloudflare's
 * client-side widget names the hidden input `cf-turnstile-response`, so this is the field the
 * middleware reads unless the app overrides it (or reads from a header instead).
 */
export const DEFAULT_TOKEN_FIELD = "cf-turnstile-response";

/**
 * **The action label of the passwordless sign-in gate, stated once for the whole kit (#377).**
 *
 * Turnstile bakes an action into the token at widget render and echoes it back from siteverify, and the
 * gate refuses a token whose action is not the one the route expects. So the string is a contract with
 * two ends — the widget that solves for it and the route that asserts it — and it used to be written out
 * at both: `createAuthRoutes` stacked `turnstile({ action: "login" })` and the scaffolded
 * `turnstile.tsx` declared its own `const ACTION = "login"`.
 *
 * **Nothing before production can notice the two disagreeing**, which is what makes a second copy
 * unaffordable here rather than merely untidy. Cloudflare's always-pass test secret — the one
 * `pithy turnstile provision` wires into dev and staging — answers with **no `action` field at all**, and
 * the gate accepts exactly that answer in exactly those two environments (#374, {@link
 * ../http/middleware.testKeyCarriesNoAction}). A drifted pair is therefore invisible in dev, invisible in
 * staging, and in prod refuses **every** sign-in with a 403 that says the challenge failed — pointing an
 * operator at the user rather than at the mismatch.
 *
 * So there is one statement, and both ends read it: the client projection carries it to the browser
 * (`capability.ts`'s `client`, reaching the widget as `turnstileConfig.action`), and `@pithy-sh/auth`
 * imports it for the gate it stacks. It is also the `protect` key the login mode is configured under, so
 * the config default below is built from it too — three readers, no second literal.
 *
 * The gates that keep it that way, and where the blindness above is restated for whoever is reading one:
 * `@pithy-sh/auth`'s `src/http/turnstileActionBinding.test.ts` (the route asserts the projected action)
 * and `@pithy-sh/ui-react`'s `src/turnstileAction.test.tsx` (the widget solves for the projected action).
 */
export const TURNSTILE_LOGIN_ACTION = "login";

/**
 * The two widget modes Pithy provisions, in the app's own terms. `visible` is a Cloudflare *managed*
 * widget (CF decides whether to show an interaction) — for a surface where the challenge should be
 * seen, like a login page. `invisible` runs silently — for a form that should not interrupt, like a
 * lead capture. The logical maximum is one of each per domain.
 */
export const TurnstileMode = z
  .enum(["visible", "invisible"])
  .describe("A Turnstile widget mode: `visible` (a CF managed widget) or `invisible` (runs silently).");
export type TurnstileMode = z.infer<typeof TurnstileMode>;

/**
 * The public sitekey for one widget, per environment. The sitekey is public — the front-end renders
 * the widget with it — so it lives in config, not in secrets.
 *
 * **This block is a build input, and `pithy turnstile provision` is what writes it.** The `pithy()` Vite
 * plugin inlines the capability's client projection when the front end is built, and the projection reads
 * the sitekey for the environment being built from here. Provisioning writes all three string literals in
 * place: Cloudflare's documented test sitekey for dev and staging (no real widget), and the real widget's
 * sitekey for prod. Nothing reaches a deployed bundle until that Worker is built and deployed again. A blank
 * value renders no widget, and the gate on sign-in fails closed.
 *
 * The keys are Pithy's environment names verbatim, because that is what the client projection indexes
 * them by — a bundle built for `prod` reads `sitekeys.prod`. They are not free-form labels, and a
 * *declared* environment beyond these three has no sitekey: its builds render no widget, which `pithy
 * turnstile provision` and `pithy doctor` both say.
 *
 * **`feature` is the fourth, and it is optional (#656).** A branch's environment is generated rather than
 * declared, so nothing an adopter writes can state a key for it and nothing provisioning writes reaches it
 * either — which is why a feature deployment used to render no widget and refuse every sign-in. Absent, it
 * resolves Cloudflare's always-pass test key for the widget's mode (`provision/testKeys`' `defaultSitekey`),
 * which is the pair dev wires and the only pair an ephemeral environment should want. Stated, it is honored:
 * a real key for a branch an adopter wants to run a real widget on, or `""` for no widget at all.
 */
export const TurnstileSitekeys = z
  .object({
    dev: z
      .string()
      .describe(
        "Dev sitekey — Cloudflare's always-pass test key, written by `pithy turnstile provision` (no real widget is created).",
      ),
    staging: z
      .string()
      .describe(
        "Staging sitekey — Cloudflare's always-pass test key, written by `pithy turnstile provision` (no real widget is created).",
      ),
    prod: z.string().describe("Prod sitekey — the real widget's public key, written by `pithy turnstile provision`."),
    feature: z
      .string()
      .optional()
      .describe(
        "Feature-build sitekey. Optional: left out, a branch build resolves Cloudflare's always-pass test key for this widget's mode. State one to render a real widget on a branch, or \"\" to render none.",
      ),
  })
  .describe("Per-environment public sitekeys the front-end build inlines to render the widget.");
export type TurnstileSitekeys = z.infer<typeof TurnstileSitekeys>;

/** One provisioned widget: its per-environment public sitekeys. The mode is the key under `widgets`. */
export const TurnstileWidget = z
  .object({
    sitekeys: TurnstileSitekeys.describe("Per-environment public sitekeys for this widget."),
  })
  .describe("A single Turnstile widget (one mode), with its per-environment public sitekeys.");
export type TurnstileWidget = z.infer<typeof TurnstileWidget>;

/**
 * Where the middleware reads the response token from. By default it reads the `cf-turnstile-response`
 * body field (form or JSON). Set `header` to read the token from a request header instead — useful for
 * a JSON API or a mobile client that sends the token out-of-band.
 */
export const TurnstileTokenSource = z
  .object({
    field: z
      .string()
      .default(DEFAULT_TOKEN_FIELD)
      .describe(
        "Request body field carrying the token (form or JSON). Cloudflare's widget uses `cf-turnstile-response`.",
      ),
    header: z
      .string()
      .optional()
      .describe("If set, read the token from this request header instead of the body field."),
  })
  .describe("Where the middleware reads the Turnstile response token from.");
export type TurnstileTokenSource = z.infer<typeof TurnstileTokenSource>;

/**
 * Configuration for the turnstile capability, authored in `pithy.config.ts`. It declares which widgets
 * the app uses (up to one `visible` and one `invisible` per domain), which protected actions get a
 * humanity gate and at which mode, and where the token is read from. The widget *secret* is never here —
 * it is stored and read through `@pithy-sh/secrets`; only the public sitekeys live in config.
 *
 * Social/OAuth login is deliberately never gated: the provider runs its own bot defense and the redirect
 * flow carries no token. `@pithy-sh/auth` reads `protect` to stack `turnstile()` on its magic-link/OTP
 * routes; this package never imports auth.
 */
export const TurnstileConfig = z
  .object({
    widgets: z
      .object({
        visible: TurnstileWidget.optional().describe(
          "The visible (managed) widget — shows a challenge where it should be seen, e.g. a login page.",
        ),
        invisible: TurnstileWidget.optional().describe(
          "The invisible widget — runs silently where a form should not be interrupted, e.g. lead capture.",
        ),
      })
      .default({})
      .describe("Up to two widgets per domain: one `visible`, one `invisible`. Declare only the modes you need."),
    protect: z
      .record(z.string(), TurnstileMode)
      // Built from the constant, not written out again: the key an action is configured under and the
      // action label a token is solved for are the same string, and #377 is what a second copy costs.
      .default({ [TURNSTILE_LOGIN_ACTION]: "visible" })
      .describe(
        "Protected action → widget mode. `login` (magic-link, OTP) defaults to the visible widget; add your own form actions. Social/OAuth is never gated.",
      ),
    token: TurnstileTokenSource.default({ field: DEFAULT_TOKEN_FIELD }).describe(
      "Where the response token is read from (body field by default, or a header).",
    ),
  })
  .describe("Configuration for the turnstile humanity-check capability.");
export type TurnstileConfig = z.output<typeof TurnstileConfig>;
export type TurnstileConfigInput = z.input<typeof TurnstileConfig>;
