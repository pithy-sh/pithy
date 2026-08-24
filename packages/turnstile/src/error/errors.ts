// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";

/**
 * `@pithy-sh/turnstile` throw sugar. The `turnstile/*` codes live in core's closed `KitErrorPayload`
 * union (CLAUDE.md §Errors: capabilities add their codes to the one union); these subclasses are the
 * package-local vehicles that set one of those members — the same pattern as `@pithy-sh/email`.
 * Runtime code in this package throws one of these, never a plain `new Error`.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface TurnstileErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
  /**
   * Values a translating client interpolates into its own wording for this code. Client-facing, so —
   * unlike `action` and `detail` — these cross the boundary with `message`.
   */
  params?: MessageParams;
}

/** The request carried no Turnstile response token where one was required. */
export class TurnstileMissingTokenError extends PithyError {
  constructor(args: TurnstileErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "turnstile/missing_token",
        status: 400,
        message: args.message ?? "A humanity-check token is required.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * The Turnstile token did not pass siteverify, or the check could not complete. The middleware fails
 * closed — a siteverify network error or malformed response also raises this, so a bot gate never
 * silently opens.
 */
export class TurnstileFailedError extends PithyError {
  constructor(args: TurnstileErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "turnstile/failed",
        status: 403,
        message: args.message ?? "The humanity check did not pass.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The middleware is misconfigured — the secret-key binding is missing or empty. */
export class TurnstileConfigError extends PithyError {
  constructor(args: TurnstileErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "turnstile/config",
        status: 500,
        message: args.message ?? "Turnstile is not configured.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
