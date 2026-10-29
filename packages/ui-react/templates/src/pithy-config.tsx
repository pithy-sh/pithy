import authModule from "virtual:pithy/auth";
import i18nModule from "virtual:pithy/i18n";
import paymentsModule from "virtual:pithy/payments";
import turnstileModule from "virtual:pithy/turnstile";
import { AUTH_DISABLED, I18N_DISABLED, PAYMENTS_DISABLED, TURNSTILE_DISABLED } from "@pithy-sh/ui-core/src/config";

/**
 * The composed capabilities' client-safe config, narrowed once for the whole client.
 *
 * `virtual:pithy/<capability>` is a union discriminated on `enabled`, because a capability that is
 * not composed projects `{ enabled: false }` and nothing else — that is what makes importing an
 * absent capability safe instead of a build error. Narrowing at every use would put a guard in front
 * of every field read, so it happens here instead, once.
 *
 * The `enabled: false` branch carries the capability's own defaults from `@pithy-sh/ui-core` rather
 * than `undefined`, so a screen reads a field without a guard. `pithy ui add --auth` refuses a Worker
 * that does not compose `auth`, so on a scaffolded project the enabled branch is the live one; the
 * defaults keep the screens compiling when a capability is removed from `pithy.config.ts` after the
 * scaffold.
 */
export const authConfig = authModule.enabled ? authModule : AUTH_DISABLED;

/** Turnstile's projection, narrowed the same way. `enabled` is false unless a login widget resolved. */
export const turnstileConfig = turnstileModule.enabled ? turnstileModule : TURNSTILE_DISABLED;

/**
 * Payments' projection, narrowed the same way. `enabled` is false when the capability is not composed, and
 * also when it is composed with an empty catalog — a paywall with nothing on it is nothing to render, so
 * the two read alike and a screen branches once.
 *
 * Only the browser-safe half of the catalog is here. Apple's issuer id, Google's service-account
 * credentials and Stripe's secret and signing keys live in the secrets store and never enter a projection.
 */
export const paymentsConfig = paymentsModule.enabled ? paymentsModule : PAYMENTS_DISABLED;

/**
 * The i18n capability's projection, narrowed the same way. `enabled` is false unless the capability is
 * composed, and then every screen renders the English it was scaffolded with — which is the whole of
 * what makes this capability optional.
 *
 * **Locale metadata only. Never catalogs.** The projection is inlined into the main chunk, so a catalog
 * carried here would be downloaded by every reader in every language before the first paint. Catalogs
 * arrive by dynamic import, one chunk per locale, from `@pithy-sh/i18n`.
 *
 * The disabled branch is the kit's own defaults, for the reason the three above carry theirs: a screen
 * reads a field without a guard. `en` is not a claim that this project speaks English — it is what the
 * templates are written in, and it is what `t()` falls back to when nothing negotiated.
 */
export const i18nConfig = i18nModule.enabled ? i18nModule : I18N_DISABLED;
