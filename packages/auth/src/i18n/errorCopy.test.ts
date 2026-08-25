// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { kitPlugins } from "../instance/plugins";
import { authErrorTranslations, composedErrorCodes, ENGLISH_ON_PURPOSE } from "./errorCopy";
import { AUTH_ERRORS_ES } from "./errorCopy.es";

/** The deps the plugin set needs to be constructed. No callback here is ever invoked. */
const DEPS = {
  verificationExpiresIn: 300,
  otpLength: 6,
  disableSignUp: false,
  sendEmail: async () => undefined,
};

/** Every locale this kit writes Better Auth's refusals in. English is the source and is not one. */
const KIT_LOCALES = ["es"] as const;

describe("every code the kit can raise is accounted for", () => {
  /**
   * **The property is only true as a set**, which is why it is a test rather than a habit.
   *
   * `@better-auth/i18n` covers 34 of the 52 codes this composition can raise, and the 18 it misses
   * included every one of `emailOTP`'s — `INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`, which is
   * the whole vocabulary of a passwordless sign-in going wrong. Nothing said so; the gap was found by
   * asking this question. A code Better Auth adds in a later release fails here rather than quietly
   * reaching somebody in English.
   *
   * Accounted for means one of two things, and the second is deliberate: translated, or named in
   * {@link ENGLISH_ON_PURPOSE} with the reason it stays English.
   */
  test.each(KIT_LOCALES)("in %s", (locale) => {
    const dictionary = authErrorTranslations()[locale] ?? {};
    const unaccounted = composedErrorCodes(kitPlugins(DEPS)).filter(
      (code) => !(code in dictionary) && !(code in ENGLISH_ON_PURPOSE),
    );
    expect(
      unaccounted,
      "translate it in errorCopy.es.ts, or name it in ENGLISH_ON_PURPOSE with why it stays English",
    ).toEqual([]);
  });

  test("nothing is in both halves — a code is translated or it is not", () => {
    const both = Object.keys(AUTH_ERRORS_ES).filter((code) => code in ENGLISH_ON_PURPOSE);
    expect(both).toEqual([]);
  });

  test("every deliberate exemption is a code this composition can actually raise", () => {
    // Otherwise the list grows entries for codes that no longer exist, and reads as coverage.
    const raisable = new Set(composedErrorCodes(kitPlugins(DEPS)));
    expect(Object.keys(ENGLISH_ON_PURPOSE).filter((code) => !raisable.has(code))).toEqual([]);
  });

  test("every exemption carries a reason", () => {
    for (const [code, reason] of Object.entries(ENGLISH_ON_PURPOSE)) {
      expect(reason.length, `${code} is exempt with no reason`).toBeGreaterThan(20);
    }
  });
});

describe("authErrorTranslations", () => {
  test("layers the kit's words over the plugin's, per key rather than per locale", () => {
    const es = authErrorTranslations().es ?? {};
    // Ours where we wrote one...
    expect(es.INVALID_OTP).toBe(AUTH_ERRORS_ES.INVALID_OTP);
    // ...and theirs everywhere else, rather than a locale replaced wholesale. `USER_NOT_FOUND` is one
    // the plugin ships and this kit never restates; a per-locale merge would have dropped it.
    expect(es.USER_NOT_FOUND).toBe("Usuario no encontrado");
  });

  test("keeps the plugin's own English, so a project serving one language is unchanged", () => {
    const en = authErrorTranslations().en ?? {};
    expect(Object.keys(en).length).toBeGreaterThan(0);
    expect(en.USER_NOT_FOUND).toBe("User not found");
  });

  test("carries every language the plugin ships, not only the one the kit writes", () => {
    // The kit writes `es`. An adopter serving French gets French from upstream at no cost to us, which
    // is the whole reason these are layered rather than copied.
    const all = authErrorTranslations();
    expect(Object.keys(all).length).toBeGreaterThan(10);
    expect(all.fr?.USER_NOT_FOUND).toBeTypeOf("string");
  });
});
