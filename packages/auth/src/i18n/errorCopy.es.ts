// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT
//
// LOCALE es — an unreviewed first pass. Not American English by design.

/**
 * What this kit says in Spanish that `@better-auth/i18n` does not (#452).
 *
 * **Only the gaps, and only the ones a reader meets.** The plugin ships 22 languages of its own, and
 * they are maintained upstream — copying them here would fork every one of them on the day it landed.
 * This layers over its `es`, which covers 34 of the 52 codes the kit's composed plugin set can raise.
 *
 * The three that matter most were among the missing: `INVALID_OTP`, `OTP_EXPIRED` and
 * `TOO_MANY_ATTEMPTS` are the whole of `emailOTP`'s vocabulary, which is to say the whole of what a
 * person meets when a passwordless sign-in goes wrong. A reader who mistyped a code was reading English
 * on an otherwise Spanish screen.
 *
 * The rest of the gap is misconfiguration an adopter causes rather than anything a reader can act on,
 * and it stays English deliberately — see `ENGLISH_ON_PURPOSE` in `./errorCopy`.
 */
export const AUTH_ERRORS_ES = {
  /** A one-time code that is not the one. The commonest refusal there is. */
  INVALID_OTP: "El código no es válido.",
  /** The code was right once. Codes are short-lived on purpose. */
  OTP_EXPIRED: "El código ha caducado. Pide uno nuevo.",
  /** Rate limiting on the verification attempt, not on the request for a code. */
  TOO_MANY_ATTEMPTS: "Demasiados intentos. Espera un momento y vuelve a intentarlo.",
  /**
   * The sign-in was reached by a cross-site navigation and refused.
   *
   * A person can meet this without doing anything wrong — an embedded browser, a link opened from
   * another site — so it says what to do rather than naming the mechanism.
   */
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: "Por seguridad, abre el enlace directamente en tu navegador.",
} as const satisfies Record<string, string>;
