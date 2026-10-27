// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type Capability, defineCapability } from "../capability/capability";
import { composedAddress, composedConsent, composedConsentPurposes, providesConsent } from "./reader";

const env = { DB: {} };

const email = defineCapability({
  name: "email",
  requiredBindings: [],
  consentPurposes: [
    {
      id: "email.marketing",
      summary: "News by email.",
      noticeVersion: 1,
      classes: [],
      explicit: false,
      minimumMethod: "click",
      writtenWithdrawal: false,
    },
  ],
});

const consent = (answer: boolean): Capability =>
  defineCapability({
    name: "consent",
    requiredBindings: [],
    consentReader: (given) => ({
      hasConsent: async () => given === env && answer,
    }),
  });

describe("composedConsent", () => {
  test("is null with no provider composed, which is not a no", () => {
    expect(composedConsent([email], env)).toBeNull();
    expect(providesConsent([email])).toBe(false);
  });

  test("answers through the provider, built over this env", async () => {
    const reader = composedConsent([email, consent(true)], env);
    expect(await reader?.hasConsent({ kind: "account", id: "u1" }, "email.marketing")).toBe(true);
    expect(providesConsent([email, consent(false)])).toBe(true);
  });
});

describe("composedConsentPurposes", () => {
  test("collects every capability's purposes in composition order", () => {
    expect(composedConsentPurposes([email, consent(true)]).map((purpose) => purpose.id)).toEqual(["email.marketing"]);
  });
});

describe("composedAddress", () => {
  const auth = (address: () => Promise<string | null>) =>
    defineCapability({ name: "auth", requiredBindings: [], addressOf: () => address() });

  test("reads an account's address through the capability that owns accounts", async () => {
    expect(await composedAddress([auth(async () => "ada@example.com")], env, { kind: "account", id: "u1" })).toBe(
      "ada@example.com",
    );
  });

  test("is null for a visitor, with no owner composed, and when the owner throws", async () => {
    const owner = auth(async () => "ada@example.com");
    expect(await composedAddress([owner], env, { kind: "visitor", id: "d1" })).toBeNull();
    expect(await composedAddress([], env, { kind: "account", id: "u1" })).toBeNull();
    const broken = auth(async () => {
      throw new Error("unbound");
    });
    expect(await composedAddress([broken], env, { kind: "account", id: "u1" })).toBeNull();
  });
});
