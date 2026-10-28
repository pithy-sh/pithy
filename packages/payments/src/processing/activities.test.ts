// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { payments } from "../capability";
import { railRecipients } from "./activities";

const OFF = { apple: false, google: false, stripe: false, lemonSqueezy: false, paddle: false };

describe("railRecipients", () => {
  test("names every rail the config turns on, and none it leaves off", () => {
    expect(railRecipients({ ...OFF, stripe: true, apple: true }).map((recipient) => recipient.name)).toEqual([
      "Apple App Store",
      "Stripe",
    ]);
    expect(railRecipients(OFF)).toEqual([]);
  });
});

describe("payments()", () => {
  test("declares its purchases as one activity under a contract, naming no rail when none is on", () => {
    const capability = payments({ billingSubject: "user" });
    expect(capability.processing).toEqual([
      expect.objectContaining({ id: "payments.purchases", legalBasis: "contract", recipients: [] }),
    ]);
  });
});
