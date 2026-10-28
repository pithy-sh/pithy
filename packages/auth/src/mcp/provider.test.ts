// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { consentPrompt } from "./provider";

describe("consentPrompt", () => {
  test("adds consent to whatever the client asked, so the screen shows every time", () => {
    expect(consentPrompt(undefined)).toBe("consent");
    expect(consentPrompt("")).toBe("consent");
    expect(consentPrompt("consent")).toBe("consent");
    expect(consentPrompt("select_account")).toBe("select_account consent");
  });

  test("drops login, since the screen is also the sign-in and a live session is the one asked about", () => {
    expect(consentPrompt("login")).toBe("consent");
    expect(consentPrompt("login consent")).toBe("consent");
  });

  // The provider issues a code for `none` whenever a consent is on record, and this server never grants without the
  // screen, so `none` has no prompt to run with.
  test("has no prompt for a client asking to be shown nothing", () => {
    expect(consentPrompt("none")).toBeNull();
    expect(consentPrompt("none consent")).toBeNull();
    expect(consentPrompt(" none ")).toBeNull();
  });
});
