// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { RUNTIME_TOKEN_SECRET } from "@pithy-sh/cloudflare/src/tokens/runtime";
import { describe, expect, test } from "vitest";
import {
  selectTurnstileSecret,
  TURNSTILE_ACCOUNT_SECRET,
  TURNSTILE_RUNTIME_PERMISSIONS,
  TURNSTILE_SECRET_NAME,
  TurnstileAccount,
  TurnstileSecrets,
  turnstileAccountRegistry,
  turnstileCapabilitySecretsRegistry,
  turnstileSecretsRegistry,
} from "./registry";

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

describe("turnstileAccountRegistry (#731)", () => {
  test("declares the account the widgets live in as a d1, environment-scoped json secret, never a token", () => {
    const entry = turnstileAccountRegistry[TURNSTILE_ACCOUNT_SECRET];
    expect(entry).toMatchObject({ backend: "d1", scope: "environment", rotatable: false, valueType: "json" });
    expect(TurnstileAccount.parse({ accountId: "acct-1" })).toEqual({ accountId: "acct-1" });
    expect(TurnstileAccount.safeParse({ accountId: "" }).success).toBe(false);
    // An id and nothing else: a token here would be a second Cloudflare API token in the application.
    expect(TurnstileAccount.parse({ accountId: "acct-1", apiToken: "t" })).toEqual({ accountId: "acct-1" });
  });
});

describe("turnstileCapabilitySecretsRegistry (#731)", () => {
  test("is the widget secret, the account, and the application's one runtime token for analytics:read", () => {
    expect(TURNSTILE_RUNTIME_PERMISSIONS).toEqual(["analytics:read"]);
    expect(Object.keys(turnstileCapabilitySecretsRegistry).sort()).toEqual(
      [TURNSTILE_SECRET_NAME, TURNSTILE_ACCOUNT_SECRET, RUNTIME_TOKEN_SECRET].sort(),
    );
    expect(turnstileCapabilitySecretsRegistry[RUNTIME_TOKEN_SECRET]?.origin).toMatchObject({
      kind: "helped",
      needs: { cloudflare: ["analytics:read"] },
    });
  });

  test("the middleware's own registry is still the widget secret alone", () => {
    expect(Object.keys(turnstileSecretsRegistry)).toEqual([TURNSTILE_SECRET_NAME]);
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
