// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { consent } from "./capability";

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

describe("consent()", () => {
  test("composes every capability's purposes with the adopter's own into one catalog", () => {
    const capability = consent({ purposes: [{ id: "clinic.records", summary: "Keep my record.", noticeVersion: 1 }] });
    expect([...capability.consentCatalog().keys()]).toEqual(["clinic.records"]);
    capability.compose?.({ capabilities: [email, capability] });
    expect([...capability.consentCatalog().keys()]).toEqual(["email.marketing", "clinic.records"]);
  });

  test("refuses an adopter purpose under a composed capability's domain, at startup", () => {
    const capability = consent({ purposes: [{ id: "email.extra", summary: "x", noticeVersion: 1 }] });
    expect(() => capability.compose?.({ capabilities: [email, capability] })).toThrow(/a composed capability owns/);
  });

  test("refuses a malformed adopter purpose at construction", () => {
    expect(() => consent({ purposes: [{ id: "Not A Purpose", summary: "x", noticeVersion: 1 }] })).toThrow(
      /configuration is not valid/,
    );
  });

  test("provides the consent seam, retains through a purge, and needs auth for its same-origin gate", () => {
    const capability = consent();
    expect(capability.consentReader).toBeTypeOf("function");
    expect(capability.dependsOn).toEqual(["auth"]);
    expect(capability.purge?.[0]?.retain?.basis).toMatch(/proof/);
    expect(capability.requiredBindings.find((binding) => binding.name === "CONSENT_EVIDENCE")?.optional).toBe(true);
  });
});
