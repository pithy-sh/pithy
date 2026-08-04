// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { z } from "zod";

/**
 * The HTTP boundary shapes for the ledger routes. Everything a client can send is declared here and
 * parsed on the route line, so reading a route tells you what it accepts without opening the handler.
 *
 * {@link CurrencyParam} is deliberately a **shape** check, not an existence check. Whether a currency is
 * configured is a config-time question the handler still answers through `resolveCurrency`, which raises
 * `ledger/currency_not_found` — a 404, because an unconfigured `doubloons` is a missing resource, not a
 * malformed request. Building this schema from the configured codes would collapse that distinction.
 * Every currency shape below reuses the same field for exactly that reason.
 *
 * Note what is absent from {@link AdminWrite}: the currency (it is the path) and the caller (it is the
 * AuthContext seam). A write names the *player whose balance moves*, which is why the route is gated on
 * the admin scope — a client that could name any `userId` without it could credit itself.
 *
 * The `Admin*` shapes ending in `Query`/`Param` belong to the **control-plane** management routes, which
 * take no bodies at all: the ledger's management surface is read-only, so there is nothing for a client
 * to send but filters and a place to resume.
 */

/** Mirrors the config-time currency-code pattern: lowercase, digits, and dashes. */
const CURRENCY_CODE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** A currency code, shape-checked. Whether it is configured stays the handler's 404. */
const CurrencyCode = z
  .string()
  .min(1)
  .max(64)
  .regex(CURRENCY_CODE_PATTERN, "A currency code is lowercase, digits, and dashes.");

/** A user id as a path segment — opaque to the ledger, which never issues one. */
const UserId = z.string().min(1).max(255);

/** Where a keyset page resumes. Opaque; a malformed one is a first page rather than an error. */
const Cursor = z
  .string()
  .max(512)
  .optional()
  .describe("Where to resume, from the previous page's `nextCursor`. Opaque; a malformed one is a first page.");

/** How many rows one page returns. Bounded, because a verified client can still have a bug. */
const Limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .optional()
  .describe(`How many rows to return, from 1 to ${MAX_PAGE_SIZE}. Defaults to a page a dashboard can render.`);

export const CurrencyParam = z
  .object({
    currency: CurrencyCode.describe(
      "The currency this request applies to — the `:currency` path segment. A shape check only; whether the code is configured is the handler's 404.",
    ),
  })
  .describe("The `:currency` path segment every ledger route carries.");
export type CurrencyParam = z.infer<typeof CurrencyParam>;

export const AdminAccountsQuery = z
  .object({
    currency: CurrencyCode.optional().describe(
      "Restrict the listing to one currency. A shape check only; an unconfigured code is the handler's 404, so an operator who mistypes is told rather than shown an empty pane.",
    ),
    cursor: Cursor,
    limit: Limit,
  })
  .describe("The account-listing query: which currency, and where to resume.");
export type AdminAccountsQuery = z.infer<typeof AdminAccountsQuery>;

export const AdminUserParam = z
  .object({
    userId: UserId.describe(
      "The player whose balances to read — the `:userId` path segment. Opaque to the ledger: it is whatever id the adopter's auth capability issued.",
    ),
  })
  .describe("The `:userId` path segment on the per-player management routes.");
export type AdminUserParam = z.infer<typeof AdminUserParam>;

export const AdminAccountParam = z
  .object({
    userId: UserId.describe("The player whose account this is — the `:userId` path segment."),
    currency: CurrencyCode.describe(
      "The currency the account is in — the `:currency` path segment. A shape check only; an unconfigured code is the handler's 404.",
    ),
  })
  .describe("The `(userId, currency)` pair that addresses one account — the key the accounts table is on.");
export type AdminAccountParam = z.infer<typeof AdminAccountParam>;

export const AdminTransactionsQuery = z
  .object({ cursor: Cursor, limit: Limit })
  .describe("The entry-log query: where to resume, and how much of it to return.");
export type AdminTransactionsQuery = z.infer<typeof AdminTransactionsQuery>;

export const AdminWrite = z
  .object({
    userId: z.string().min(1).max(255).describe("The player whose balance moves."),
    amount: z.number().int().positive().describe("A positive integer in the currency's minor unit."),
    ref: z.string().min(1).max(255).describe("A unique idempotency key — a replay with the same ref is a no-op."),
    memo: z.string().max(1000).optional().describe("An optional human-readable note."),
  })
  .describe("An admin credit/debit request.");
export type AdminWrite = z.infer<typeof AdminWrite>;
