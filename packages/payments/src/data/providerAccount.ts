// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { PaymentsRail } from "./rail";
import { PaymentsSubject } from "./subject";

/**
 * A provider identity mapped back to the subject that holds it — the row in
 * `pithy_payments_provider_accounts`, keyed `UNIQUE (rail, providerAccountId)`.
 *
 * A Stripe webhook arrives carrying `cus_123`, and names no holder of ours. This table is the only way back. The
 * link is established at purchase time, and all three rails provide the hook — Apple's `appAccountToken`,
 * Google's `obfuscatedAccountId`, Stripe's `client_reference_id`. All three must be set by the app that
 * starts the purchase, or webhooks arrive orphaned with nobody to project them against.
 *
 * What it maps back to is the **subject pair**, which is what makes the argument stronger rather than
 * weaker: under organization billing the person who started the checkout is not the holder, so a row
 * carrying only their user id would attribute every later renewal to them personally. The two columns are
 * written together and read together — `data/subject.ts`.
 *
 * **The unique stays `(rail, providerAccountId)` and is never widened by the subject.** A provider
 * identity binds to one holder, once, for the life of the link: widening the key would let a second
 * subject claim the same `cus_123` and collect the first one's renewals. A rebind is a support operation
 * with a deliberate delete, not something a purchase flow can do by writing a row.
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
    subjectType: PaymentsSubject.shape.subjectType.describe(
      "Whether `subjectId` names a user or an organization. Half the answer — the id alone is ambiguous, so the two columns travel together.",
    ),
    subjectId: PaymentsSubject.shape.subjectId.describe(
      "The subject this provider identity resolves to — a Pithy user id, or the adopter's organization id.",
    ),
    createdAt: SQLiteDate.describe("When the link was established, which is the first purchase that carried it."),
  })
  .describe("A provider identity mapped to the subject that holds it — the row in `pithy_payments_provider_accounts`.");
export type PaymentsProviderAccount = z.output<typeof PaymentsProviderAccount>;
export type PaymentsProviderAccountRow = z.input<typeof PaymentsProviderAccount>;
