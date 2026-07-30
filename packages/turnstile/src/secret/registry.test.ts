// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { selectTurnstileSecret, TURNSTILE_SECRET_NAME, TurnstileSecrets, turnstileSecretsRegistry } from "./registry";

describe("turnstileSecretsRegistry", () => {
  test("declares one d1, environment-scoped, rotatable, json secret", () => {
    const entry = turnstileSecretsRegistry[TURNSTILE_SECRET_NAME];
    expect(entry).toMatchObject({ backend: "d1", scope: "environment", rotatable: true, valueType: "json" });
  });

  test("the schema rejects an entry with an empty key and unknown modes", () => {
    expect(TurnstileSecrets.safeParse({ visible: { key: "" } }).success).toBe(false);
    expect(TurnstileSecrets.safeParse({ managed: { key: "x" } }).success).toBe(false);
    expect(TurnstileSecrets.safeParse({ visible: { key: "x", lastRotatedAt: "2026-06-19" } }).success).toBe(true);
  });
});

describe("selectTurnstileSecret", () => {
  test("returns the only widget's key when one is configured (no mode needed)", () => {
    expect(selectTurnstileSecret({ visible: { key: "v" } })).toBe("v");
    expect(selectTurnstileSecret({ invisible: { key: "i" } })).toBe("i");
  });

  test("selects by mode when both widgets are configured", () => {
    const secrets = { visible: { key: "v" }, invisible: { key: "i" } };
    expect(selectTurnstileSecret(secrets, "visible")).toBe("v");
    expect(selectTurnstileSecret(secrets, "invisible")).toBe("i");
  });

  test("throws turnstile/config when two widgets are present and no mode is given", () => {
    expect(() => selectTurnstileSecret({ visible: { key: "v" }, invisible: { key: "i" } })).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "turnstile/config" }) }),
    );
  });

  test("throws turnstile/config when the requested mode is absent or nothing is configured", () => {
    expect(() => selectTurnstileSecret({ visible: { key: "v" } }, "invisible")).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "turnstile/config" }) }),
    );
    expect(() => selectTurnstileSecret({})).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "turnstile/config" }) }),
    );
  });
});
