// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { DEFAULT_TOKEN_FIELD, TurnstileConfig } from "./config";

describe("TurnstileConfig", () => {
  test("applies the brand defaults: login gated by the visible widget, body-field token", () => {
    const config = TurnstileConfig.parse({
      widgets: { visible: { sitekeys: { dev: "d", staging: "s", prod: "p" } } },
    });
    expect(config.protect).toEqual({ login: "visible" });
    expect(config.token.field).toBe(DEFAULT_TOKEN_FIELD);
    expect(config.token.header).toBeUndefined();
  });

  test("parses an empty config — widgets default to none, login still gated", () => {
    const config = TurnstileConfig.parse({});
    expect(config.widgets).toEqual({});
    expect(config.protect).toEqual({ login: "visible" });
    expect(config.token.field).toBe(DEFAULT_TOKEN_FIELD);
  });

  test("models up to two widgets per domain — one visible, one invisible", () => {
    const config = TurnstileConfig.parse({
      widgets: {
        visible: { sitekeys: { dev: "1x", staging: "1x", prod: "real-vis" } },
        invisible: { sitekeys: { dev: "1y", staging: "1y", prod: "real-inv" } },
      },
    });
    expect(config.widgets.visible?.sitekeys.prod).toBe("real-vis");
    expect(config.widgets.invisible?.sitekeys.prod).toBe("real-inv");
  });

  test("accepts adopter form actions alongside login, at either mode", () => {
    const config = TurnstileConfig.parse({
      widgets: { invisible: { sitekeys: { dev: "d", staging: "s", prod: "p" } } },
      protect: { login: "visible", leadForm: "invisible" },
    });
    expect(config.protect).toEqual({ login: "visible", leadForm: "invisible" });
  });

  test("reads the token from a header when configured", () => {
    const config = TurnstileConfig.parse({
      widgets: { invisible: { sitekeys: { dev: "d", staging: "s", prod: "p" } } },
      token: { header: "x-turnstile-token" },
    });
    expect(config.token.header).toBe("x-turnstile-token");
    expect(config.token.field).toBe(DEFAULT_TOKEN_FIELD);
  });

  test("rejects an unknown widget mode", () => {
    expect(() =>
      TurnstileConfig.parse({
        widgets: { invisible: { sitekeys: { dev: "d", staging: "s", prod: "p" } } },
        protect: { login: "loud" },
      }),
    ).toThrow();
  });
});
