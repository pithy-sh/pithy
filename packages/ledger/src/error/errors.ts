// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";

/**
 * `@pithy-sh/ledger` throw sugar. The `ledger/*` codes live in core's closed `KitErrorPayload` union
 * (CLAUDE.md §Errors); these subclasses are the package-local vehicles that set one of those members.
 * Runtime code in this package throws one of these, never a plain `new Error`.
 */

interface LedgerErrorArgs {
  message?: string;
  action?: string;
  detail?: string;
  /**
   * Values a translating client interpolates into its own wording for this code. Client-facing, so —
   * unlike `action` and `detail` — these cross the boundary with `message`.
   */
  params?: MessageParams;
}

export class LedgerCurrencyNotFoundError extends PithyError {
  constructor(args: LedgerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "ledger/currency_not_found",
        status: 404,
        message: args.message ?? "That currency does not exist.",
        action: args.action ?? "Check the currency code against the `currencies` list in pithy.config.ts.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class LedgerAccountNotFoundError extends PithyError {
  constructor(args: LedgerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "ledger/account_not_found",
        status: 404,
        message: args.message ?? "You have no account in that currency yet.",
        action: args.action ?? "Fund the account first — a credit opens it.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class LedgerHoldNotFoundError extends PithyError {
  constructor(args: LedgerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "ledger/hold_not_found",
        status: 404,
        message: args.message ?? "That hold does not exist.",
        action: args.action ?? "Check the hold reference.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class LedgerInsufficientFundsError extends PithyError {
  constructor(args: LedgerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "ledger/insufficient_funds",
        status: 409,
        message: args.message ?? "Not enough funds.",
        action: args.action ?? "Reduce the amount, or top up the balance.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class LedgerHoldNotOpenError extends PithyError {
  constructor(args: LedgerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "ledger/hold_not_open",
        status: 409,
        message: args.message ?? "That hold has already been resolved.",
        action: args.action ?? "A hold can be released or captured once; check its status.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class LedgerInvalidAmountError extends PithyError {
  constructor(args: LedgerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "ledger/invalid_amount",
        status: 400,
        message: args.message ?? "Amount must be a positive whole number.",
        action:
          args.action ?? "Amounts are integers in the currency's minor unit — never zero, negative, or fractional.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
