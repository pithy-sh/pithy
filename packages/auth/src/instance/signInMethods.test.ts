// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ALL_SIGN_IN_METHODS, emailSignInComposed, SignInMethods } from "./signInMethods";

describe("SignInMethods", () => {
  test("both methods are on when nothing is said", () => {
    expect(SignInMethods.parse({})).toEqual({ magicLink: true, emailOtp: true });
    expect(SignInMethods.parse({ emailOtp: false })).toEqual({ magicLink: true, emailOtp: false });
    expect(ALL_SIGN_IN_METHODS).toEqual({ magicLink: true, emailOtp: true });
  });
});

describe("emailSignInComposed", () => {
  test("is true while either email method is composed, and false only with neither", () => {
    expect(emailSignInComposed({ magicLink: true, emailOtp: true })).toBe(true);
    expect(emailSignInComposed({ magicLink: true, emailOtp: false })).toBe(true);
    expect(emailSignInComposed({ magicLink: false, emailOtp: true })).toBe(true);
    expect(emailSignInComposed({ magicLink: false, emailOtp: false })).toBe(false);
  });
});
