// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The HTTP boundary shapes for the ledger routes. Everything a client can send is declared here and
 * parsed on the route line, so reading a route tells you what it accepts without opening the handler.
 *
 * {@link CurrencyParam} is deliberately a **shape** check, not an existence check. Whether a currency is
 * configured is a config-time question the handler still answers through `resolveCurrency`, which raises
 * `ledger/currency_not_found` — a 404, because an unconfigured `doubloons` is a missing resource, not a
 * malformed request. Building this schema from the configured codes would collapse that distinction.
 *
 * Note what is absent from {@link AdminWrite}: the currency (it is the path) and the caller (it is the
 * AuthContext seam). A write names the *player whose balance moves*, which is why the route is gated on
 * the admin scope — a client that could name any `userId` without it could credit itself.
 */

/** Mirrors the config-time currency-code pattern: lowercase, digits, and dashes. */
const CURRENCY_CODE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const CurrencyParam = z
  .object({
    currency: z
      .string()
      .min(1)
      .max(64)
      .regex(CURRENCY_CODE_PATTERN, "A currency code is lowercase, digits, and dashes.")
      .describe(
        "The currency this request applies to — the `:currency` path segment. A shape check only; whether the code is configured is the handler's 404.",
      ),
  })
  .describe("The `:currency` path segment every ledger route carries.");
export type CurrencyParam = z.infer<typeof CurrencyParam>;

export const AdminWrite = z
  .object({
    userId: z.string().min(1).max(255).describe("The player whose balance moves."),
    amount: z.number().int().positive().describe("A positive integer in the currency's minor unit."),
    ref: z.string().min(1).max(255).describe("A unique idempotency key — a replay with the same ref is a no-op."),
    memo: z.string().max(1000).optional().describe("An optional human-readable note."),
  })
  .describe("An admin credit/debit request.");
export type AdminWrite = z.infer<typeof AdminWrite>;
