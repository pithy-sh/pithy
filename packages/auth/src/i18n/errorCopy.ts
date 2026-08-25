// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { locales } from "@better-auth/i18n";
import type { BetterAuthPlugin } from "better-auth";
import { BASE_ERROR_CODES } from "better-auth";
import { AUTH_ERRORS_ES } from "./errorCopy.es";

/**
 * The words Better Auth's own refusals are said in.
 *
 * ## Why this is server-side, when every other translation in the kit is not
 *
 * `docs/I18N.md` holds that the server never localizes an error: a `PithyError`'s `message` stays
 * English permanently, because it is at once the operator's diagnostic and the fallback for a client
 * that cannot translate, and a translating client renders `t.maybe(code, params) ?? message`.
 *
 * These are not `PithyError`s. Better Auth owns these routes and answers them in its own flat
 * `{ message, code }` before anything of ours sees the failure — better-call renders an endpoint's
 * `APIError` into a Response inside `instance.handler` (#449). So the choice is not *where* to
 * translate them but *whether*, and leaving them was leaving the last English sentences on an otherwise
 * translated screen — met by the most ordinary mistake there is, mistyping a one-time code.
 *
 * Translating them at the server also reaches a caller the client seam cannot: a mobile app holding a
 * bearer token, or a second-party integration, gets the reader's language without shipping
 * `@pithy-sh/i18n`. And nothing is lost to the operator, because the plugin keeps the English on
 * `originalMessage` rather than replacing it.
 *
 * ## Where the words come from
 *
 * `@better-auth/i18n` (MIT) ships 22 languages of its own, maintained upstream. This layers over them
 * rather than restating them: copying a locale here would fork it on the day it landed, and the kit's
 * own rule for catalogs is that they ship in the package and are never copied. {@link AUTH_ERRORS_ES}
 * carries only what its `es` is missing.
 *
 * **The layering is per key, never per locale**, for the same reason `composeMessages` merges that way:
 * a locale object replacing another is a fork wearing the shape of an override.
 */

/** Every locale this kit writes Better Auth's refusals in. English is the source and is not listed. */
const KIT_OVERRIDES: Record<string, Record<string, string>> = { es: AUTH_ERRORS_ES };

/**
 * Codes that stay English on purpose, and why.
 *
 * **A declared list rather than a silent remainder.** The gate in `./errorCopy.test.ts` requires every
 * code the composed plugin set can raise to be either translated or named here, so a code Better Auth
 * adds in a later release fails the build instead of quietly reaching somebody in English. That is the
 * same shape the migration-order table uses, and for the same reason: the property is only true as a
 * set.
 *
 * Every entry is a fault an **adopter** caused in their own configuration or their own request, not
 * anything a reader can act on. Translating those makes them harder to search for and no easier to fix.
 */
export const ENGLISH_ON_PURPOSE: Record<string, string> = {
  ASYNC_VALIDATION_NOT_SUPPORTED: "A field validator returned a promise where the adapter takes none.",
  BODY_MUST_BE_AN_OBJECT: "The caller sent something that is not a JSON object.",
  CALLBACK_URL_REQUIRED: "The adopter's own call omitted the URL it wants a reader returned to.",
  CHANGE_EMAIL_DISABLED: "The adopter switched the feature off in their own config.",
  FAILED_TO_CREATE_VERIFICATION: "A write this Worker owns failed; the operator reads our logs, not a reader.",
  FIELD_NOT_ALLOWED: "The caller sent a field the adopter's own schema does not declare.",
  ID_TOKEN_NOT_SUPPORTED: "The configured provider does not do id-token sign-in.",
  INVALID_CALLBACK_URL: "The adopter's configured callback is not a URL this Worker trusts.",
  INVALID_ERROR_CALLBACK_URL: "As above, for the error return.",
  INVALID_NEW_USER_CALLBACK_URL: "As above, for the first-sign-in return.",
  INVALID_ORIGIN: "The CSRF origin gate. An operator reads this while checking `trustedOrigins`.",
  INVALID_REDIRECT_URL: "A redirect target outside the configured set.",
  METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED: "A caller used the wrong verb on the session route.",
  MISSING_OR_NULL_ORIGIN: "The other half of the origin gate, and the same audience.",
};

/** Every error code the given plugin set can raise, plus Better Auth's own base vocabulary. */
export function composedErrorCodes(plugins: readonly BetterAuthPlugin[]): string[] {
  const codes = new Set(Object.keys(BASE_ERROR_CODES as Record<string, unknown>));
  for (const plugin of plugins) {
    const own = (plugin as { $ERROR_CODES?: Record<string, unknown> }).$ERROR_CODES;
    for (const code of Object.keys(own ?? {})) codes.add(code);
  }
  return [...codes].sort();
}

/**
 * The dictionary the plugin is configured with: what it ships, with this kit's own words over the top.
 *
 * `en` is included and is the plugin's own, so a reader whose negotiated locale is English gets exactly
 * the sentences Better Auth already wrote — this changes nothing for a project that serves one language.
 */
export function authErrorTranslations(): Record<string, Record<string, string>> {
  const bundled = locales as unknown as Record<string, Record<string, string>>;
  const merged: Record<string, Record<string, string>> = {};
  for (const [locale, dictionary] of Object.entries(bundled)) {
    merged[locale] = { ...dictionary, ...(KIT_OVERRIDES[locale] ?? {}) };
  }
  // A locale this kit writes that the plugin does not ship at all still has to reach the reader.
  for (const [locale, dictionary] of Object.entries(KIT_OVERRIDES)) {
    if (!merged[locale]) merged[locale] = { ...dictionary };
  }
  return merged;
}
