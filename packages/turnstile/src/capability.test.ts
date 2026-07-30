// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { describe, expect, test } from "vitest";
import { isTurnstileCapability, turnstile } from "./capability";
import type { TurnstileConfigInput } from "./config/config";

const sitekeys = { dev: "d", staging: "s", production: "p" };

describe("turnstile capability", () => {
  test("is stateless — no bindings of its own (its secret is read through @pithy-sh/secrets)", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } } });
    expect(cap.name).toBe("turnstile");
    expect(cap.requiredBindings).toEqual([]);
    expect(cap.databases).toBeUndefined();
    expect(cap.routes).toBeUndefined();
    expect(cap.middleware).toBeUndefined();
  });

  test("attaches the resolved config with brand defaults", () => {
    const cap = turnstile({ widgets: { invisible: { sitekeys } } });
    expect(cap.turnstileConfig.protect).toEqual({ login: "visible" });
    expect(cap.turnstileConfig.widgets.invisible?.sitekeys.production).toBe("p");
  });

  test("exposes its config schema for composition validation", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } } });
    expect(cap.config).toBeDefined();
  });

  test("isTurnstileCapability narrows to the carrier", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } } });
    expect(isTurnstileCapability(cap)).toBe(true);
    expect(isTurnstileCapability({ name: "auth", requiredBindings: [] })).toBe(false);
  });
});

// The client projection is a security boundary: the sitekey is public, the widget secret never is.
describe("turnstile client projection", () => {
  test("projects exactly the four keys that render the login widget", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } } });
    const projection = resolveClientProjection(cap, { environment: "production" });
    expect(Object.keys(projection).sort()).toEqual(["enabled", "mode", "sitekey", "token"]);
    expect(projection).toEqual({
      enabled: true,
      mode: "visible",
      sitekey: "p",
      token: { field: "cf-turnstile-response", header: null },
    });
  });

  test("resolves the sitekey per environment", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } } });
    expect(resolveClientProjection(cap, { environment: "dev" }).sitekey).toBe("d");
    expect(resolveClientProjection(cap, { environment: "staging" }).sitekey).toBe("s");
    expect(resolveClientProjection(cap, { environment: "production" }).sitekey).toBe("p");
  });

  test("carries the token placement so the front end posts where the middleware reads", () => {
    const cap = turnstile({
      widgets: { invisible: { sitekeys } },
      protect: { login: "invisible" },
      token: { field: "captcha", header: "x-captcha" },
    });
    expect(resolveClientProjection(cap, { environment: "dev" })).toEqual({
      enabled: true,
      mode: "invisible",
      sitekey: "d",
      token: { field: "captcha", header: "x-captcha" },
    });
  });

  test("is disabled when no login gate is configured", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } }, protect: {} });
    expect(resolveClientProjection(cap, { environment: "production" })).toEqual({ enabled: false });
  });

  test("is disabled when the widget the login gate names is not configured", () => {
    const cap = turnstile({ widgets: { invisible: { sitekeys } } });
    expect(resolveClientProjection(cap, { environment: "production" })).toEqual({ enabled: false });
  });

  test("is disabled when this environment has no sitekey", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys: { dev: "d", staging: "s", production: "" } } } });
    expect(resolveClientProjection(cap, { environment: "production" })).toEqual({ enabled: false });
    expect(resolveClientProjection(cap, { environment: "preview" })).toEqual({ enabled: false });
  });

  test("no secret, and no other environment's sitekey, reaches the bundle", () => {
    // A sensitive-looking extra field, as an adopter (or a future schema edit) might introduce it.
    const extra = { secret: "0x_widget_secret_never_ship" } as unknown as Partial<TurnstileConfigInput>;
    const cap = turnstile({
      widgets: {
        visible: { sitekeys: { dev: "dev-key", staging: "staging-key", production: "production-key" } },
        invisible: { sitekeys: { dev: "inv-dev", staging: "inv-staging", production: "inv-production" } },
      },
      ...extra,
    });
    const serialized = JSON.stringify(resolveClientProjection(cap, { environment: "dev" }));
    for (const secret of [
      "0x_widget_secret_never_ship",
      "staging-key",
      "production-key",
      "inv-dev",
      "inv-staging",
      "inv-production",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("dev-key");
  });
});
