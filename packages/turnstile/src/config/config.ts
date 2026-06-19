import { z } from "zod";

/**
 * The default request body field a Turnstile widget posts its response token in. Cloudflare's
 * client-side widget names the hidden input `cf-turnstile-response`, so this is the field the
 * middleware reads unless the app overrides it (or reads from a header instead).
 */
export const DEFAULT_TOKEN_FIELD = "cf-turnstile-response";

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
 * the widget with it — so it lives in config, not in secrets. dev and staging carry Cloudflare's
 * documented test keys (wired automatically, no real widget); production carries the real widget's
 * sitekey, written by `pithy turnstile provision`.
 */
export const TurnstileSitekeys = z
  .object({
    dev: z.string().describe("Dev sitekey — a Cloudflare test key, wired automatically (no real widget is created)."),
    staging: z
      .string()
      .describe("Staging sitekey — a Cloudflare test key, wired automatically (no real widget is created)."),
    production: z
      .string()
      .describe("Production sitekey — the real widget's public key, set by `pithy turnstile provision`."),
  })
  .describe("Per-environment public sitekeys the front-end renders the widget with.");
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
      .default({ login: "visible" })
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
