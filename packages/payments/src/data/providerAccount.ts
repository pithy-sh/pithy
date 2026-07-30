// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { PaymentsRail } from "./rail";

/**
 * A provider identity mapped back to a Pithy user — the row in `pithy_payments_provider_accounts`, keyed
 * `UNIQUE (rail, providerAccountId)`.
 *
 * A Stripe webhook arrives carrying `cus_123`, not a Pithy user id. This table is the only way back. The
 * link is established at purchase time, and all three rails provide the hook — Apple's `appAccountToken`,
 * Google's `obfuscatedAccountId`, Stripe's `client_reference_id`. All three must be set by the app that
 * starts the purchase, or webhooks arrive orphaned with nobody to project them against.
 */
export const PaymentsProviderAccount = z
  .object({
    id: z.string().describe("The row's UUID."),
    rail: PaymentsRail.describe("Which store this identity belongs to."),
    providerAccountId: z
      .string()
      .describe(
        "The rail's own account identifier — Stripe's customer id, Apple's appAccountToken, Google's obfuscatedAccountId.",
      ),
    userId: z.string().describe("The Pithy user this provider identity belongs to."),
    createdAt: SQLiteDate.describe("When the link was established, which is the first purchase that carried it."),
  })
  .describe("A provider identity mapped to a Pithy user — the row in `pithy_payments_provider_accounts`.");
export type PaymentsProviderAccount = z.output<typeof PaymentsProviderAccount>;
export type PaymentsProviderAccountRow = z.input<typeof PaymentsProviderAccount>;
