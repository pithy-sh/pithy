// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";
import type { UnmarkedString } from "@pithy-sh/core/src/privacy/types";

/**
 * `@pithy-sh/ledger` throw sugar. The `ledger/*` codes live in core's closed `KitErrorPayload` union
 * (CLAUDE.md §Errors); these subclasses are the package-local vehicles that set one of those members.
 * Runtime code in this package throws one of these, never a plain `new Error`.
 */

interface LedgerErrorArgs {
  message?: UnmarkedString;
  action?: UnmarkedString;
  detail?: UnmarkedString;
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

export class LedgerEntryNotFoundError extends PithyError {
  constructor(args: LedgerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "ledger/entry_not_found",
        status: 404,
        message: args.message ?? "That entry does not exist.",
        action: args.action ?? "Check the entry's ref against the account's entry log.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class LedgerEntryNotReversibleError extends PithyError {
  constructor(args: LedgerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "ledger/entry_not_reversible",
        status: 409,
        message: args.message ?? "That entry cannot be reversed.",
        action:
          args.action ??
          "Only a credit or a debit reverses, and never a reversal. Release a hold instead; correct a capture or a transfer with a credit or a debit.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class LedgerRefConflictError extends PithyError {
  constructor(args: LedgerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "ledger/ref_conflict",
        status: 409,
        message: args.message ?? "That ref already belongs to another entry.",
        action:
          args.action ??
          "Read the entry under that ref. It is not this write's: send a credit or a debit under a new ref, and correct an entry or a hold whose derived ref is taken with a credit or a debit instead.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
