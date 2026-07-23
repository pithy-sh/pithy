import { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * `@pithy-sh/wallet` throw sugar. The `wallet/*` codes live in core's closed `ErrorPayload` union
 * (CLAUDE.md §Errors); these subclasses are the package-local vehicles that set one of those members.
 * Runtime code in this package throws one of these, never a plain `new Error`.
 */

interface WalletErrorArgs {
  message?: string;
  action?: string;
  detail?: string;
}

export class WalletCurrencyNotFoundError extends PithyError {
  constructor(args: WalletErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "wallet/currency_not_found",
        status: 404,
        message: args.message ?? "That currency does not exist.",
        action: args.action ?? "Check the currency code against the `currencies` list in pithy.config.ts.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class WalletAccountNotFoundError extends PithyError {
  constructor(args: WalletErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "wallet/account_not_found",
        status: 404,
        message: args.message ?? "You have no account in that currency yet.",
        action: args.action ?? "Fund the account first — a credit opens it.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class WalletHoldNotFoundError extends PithyError {
  constructor(args: WalletErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "wallet/hold_not_found",
        status: 404,
        message: args.message ?? "That hold does not exist.",
        action: args.action ?? "Check the hold reference.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class WalletInsufficientFundsError extends PithyError {
  constructor(args: WalletErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "wallet/insufficient_funds",
        status: 409,
        message: args.message ?? "Not enough funds.",
        action: args.action ?? "Reduce the amount, or top up the balance.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class WalletHoldNotOpenError extends PithyError {
  constructor(args: WalletErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "wallet/hold_not_open",
        status: 409,
        message: args.message ?? "That hold has already been resolved.",
        action: args.action ?? "A hold can be released or captured once; check its status.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class WalletInvalidAmountError extends PithyError {
  constructor(args: WalletErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "wallet/invalid_amount",
        status: 400,
        message: args.message ?? "Amount must be a positive whole number.",
        action:
          args.action ?? "Amounts are integers in the currency's minor unit — never zero, negative, or fractional.",
        detail: args.detail,
      },
      options,
    );
  }
}
