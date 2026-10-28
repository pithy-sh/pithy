// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ProcessingActivityInput, ProcessingRecipientInput } from "@pithy-sh/core/src/processing/activity";
import { PAYMENTS_RAILS, type PaymentsRail } from "../data/rail";

/** Each rail, as an auditor would name the company behind it. */
const RAIL_NAMES: Readonly<Record<PaymentsRail, string>> = {
  apple: "Apple App Store",
  google: "Google Play",
  stripe: "Stripe",
  lemonSqueezy: "Lemon Squeezy",
  paddle: "Paddle",
};

/** Every rail the config turns on, as a recipient of the purchases made on it. */
export function railRecipients(rails: Readonly<Record<PaymentsRail, boolean>>): ProcessingRecipientInput[] {
  return PAYMENTS_RAILS.filter((rail) => rails[rail]).map((rail) => ({
    name: RAIL_NAMES[rail],
    receives: "Each purchase made on it, and the account id it is made for.",
  }));
}

/** What payments does with personal data: it sells, and keeps each purchase and what it granted. */
export function paymentsProcessing(rails: Readonly<Record<PaymentsRail, boolean>>): ProcessingActivityInput[] {
  return [
    {
      id: "payments.purchases",
      purpose: "Sell to a person, keep each purchase and what it entitles them to, and keep it for tax law.",
      legalBasis: "contract",
      recipients: railRecipients(rails),
    },
  ];
}
