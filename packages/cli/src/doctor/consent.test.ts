// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { ConsentPurpose } from "@pithy-sh/core/src/consent/purpose";
import { describe, expect, test } from "vitest";
import { consentHealth } from "./consent";

function purpose(id: string): ConsentPurpose {
  return {
    id,
    summary: "x",
    noticeVersion: 1,
    classes: [],
    explicit: false,
    minimumMethod: "click",
    writtenWithdrawal: false,
  };
}

const EMAIL: Capability = {
  name: "email",
  requiredBindings: [],
  consentPurposes: [purpose("email.marketing"), purpose("email.tracking")],
};
const CONSENT: Capability = {
  name: "consent",
  requiredBindings: [],
  consentReader: () => ({ hasConsent: async () => false }),
};

describe("consentHealth", () => {
  test("names every purpose processed with no consent record behind it", () => {
    expect(consentHealth([{ name: "auth", requiredBindings: [] }, EMAIL])).toEqual({
      recorder: null,
      purposes: [
        { capability: "email", purpose: "email.marketing" },
        { capability: "email", purpose: "email.tracking" },
      ],
      unrecorded: true,
    });
  });

  test("names the recorder once consent is composed, and finds nothing unrecorded", () => {
    const health = consentHealth([EMAIL, CONSENT]);
    expect(health.recorder).toBe("consent");
    expect(health.unrecorded).toBe(false);
  });

  test("has nothing to say about a Worker that processes nothing under consent", () => {
    expect(consentHealth([CONSENT])).toEqual({ recorder: "consent", purposes: [], unrecorded: false });
  });
});
