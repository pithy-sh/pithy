import { describe, expect, test } from "vitest";
import { isTurnstileCapability, turnstile } from "./capability";

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
