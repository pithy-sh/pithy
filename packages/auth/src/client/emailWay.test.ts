// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { emailWay } from "./emailWay";

describe("emailWay()", () => {
  test("both composed, the link is the one way, as every screen had it", () => {
    expect(emailWay({ magicLink: true, emailOtp: true })).toBe("link");
  });

  test("a projection without methods reads as both composed", () => {
    expect(emailWay(undefined)).toBe("link");
    expect(emailWay(undefined, false)).toBe("code");
  });

  test("a link that cannot come back falls to the code", () => {
    expect(emailWay({ magicLink: true, emailOtp: true }, false)).toBe("code");
  });

  test("no magic link, the code", () => {
    expect(emailWay({ magicLink: false, emailOtp: true })).toBe("code");
  });

  test("no code, the link, where it can come back", () => {
    expect(emailWay({ magicLink: true, emailOtp: false })).toBe("link");
    expect(emailWay({ magicLink: true, emailOtp: false }, false)).toBeNull();
  });

  test("neither composed, no email at all", () => {
    expect(emailWay({ magicLink: false, emailOtp: false })).toBeNull();
  });
});
