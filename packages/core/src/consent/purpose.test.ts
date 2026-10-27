// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defineCapability } from "../capability/capability";
import { meetsMethod, methodRank, parseConsentPurposes, purposeDomain } from "./purpose";

const purpose = (id: string) => ({ id, summary: "Send me news.", noticeVersion: 1 });

describe("consent methods", () => {
  test("grade weakest first: click, typed, drawn, provider", () => {
    expect([methodRank("click"), methodRank("typed"), methodRank("drawn"), methodRank("provider")]).toEqual([
      0, 1, 2, 3,
    ]);
  });

  test("a method meets a minimum at or below it, and never one above it", () => {
    expect(meetsMethod("typed", "typed")).toBe(true);
    expect(meetsMethod("drawn", "typed")).toBe(true);
    expect(meetsMethod("click", "typed")).toBe(false);
  });
});

describe("parseConsentPurposes", () => {
  test("fills the defaults a purpose may leave out", () => {
    const [parsed] = parseConsentPurposes("email", [purpose("email.marketing")], "email");
    expect(parsed).toEqual({
      id: "email.marketing",
      summary: "Send me news.",
      noticeVersion: 1,
      classes: [],
      explicit: false,
      minimumMethod: "click",
      writtenWithdrawal: false,
    });
  });

  test("refuses a purpose outside the declaring capability's domain", () => {
    expect(() => parseConsentPurposes("email", [purpose("auth.marketing")], "email")).toThrow(/outside its own domain/);
  });

  test("refuses an adopter purpose under a domain a composed capability owns", () => {
    expect(() => parseConsentPurposes("consent config", [purpose("email.extra")], null, new Set(["email"]))).toThrow(
      /a composed capability owns/,
    );
    expect(parseConsentPurposes("consent config", [purpose("clinic.storage")], null, new Set(["email"]))).toHaveLength(
      1,
    );
  });

  test("refuses a duplicate id and a malformed one", () => {
    expect(() => parseConsentPurposes("email", [purpose("email.a"), purpose("email.a")], "email")).toThrow(/twice/);
    expect(() => parseConsentPurposes("email", [purpose("Email Marketing")], "email")).toThrow(/not valid/);
    expect(() => parseConsentPurposes("email", [{ ...purpose("email.a"), noticeVersion: 0 }], "email")).toThrow(
      /not valid/,
    );
  });

  test("the domain is everything before the first dot", () => {
    expect(purposeDomain("email.marketing.weekly")).toBe("email");
  });
});

describe("defineCapability", () => {
  test("parses a capability's purposes, and refuses one outside its name", () => {
    const capability = defineCapability({
      name: "email",
      requiredBindings: [],
      consentPurposes: [
        {
          id: "email.tracking",
          summary: "Tell us when you open our mail.",
          noticeVersion: 2,
          classes: [],
          explicit: false,
          minimumMethod: "click",
          writtenWithdrawal: false,
        },
      ],
    });
    expect(capability.consentPurposes?.[0]?.noticeVersion).toBe(2);
    expect(() =>
      defineCapability({
        name: "email",
        requiredBindings: [],
        consentPurposes: [
          {
            id: "rating.tracking",
            summary: "x",
            noticeVersion: 1,
            classes: [],
            explicit: false,
            minimumMethod: "click",
            writtenWithdrawal: false,
          },
        ],
      }),
    ).toThrow(/outside its own domain/);
  });
});
