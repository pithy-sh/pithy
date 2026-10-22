// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";
import type { UnmarkedString } from "@pithy-sh/core/src/privacy/types";

/**
 * `@pithy-sh/turnstile` throw sugar. The `turnstile/*` codes live in core's closed `KitErrorPayload`
 * union (CLAUDE.md §Errors: capabilities add their codes to the one union); these subclasses are the
 * package-local vehicles that set one of those members — the same pattern as `@pithy-sh/email`.
 * Runtime code in this package throws one of these, never a plain `new Error`.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface TurnstileErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: UnmarkedString;
  /** A remediation hint (CLI action line). */
  action?: UnmarkedString;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: UnmarkedString;
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

/**
 * A challenge window Cloudflare cannot answer: older than Turnstile's analytics keep, or wider than one read
 * may ask for. The message names the cap in days, so the caller can choose a window that works.
 */
export class TurnstileAnalyticsWindowError extends PithyError {
  constructor(args: TurnstileErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "turnstile/analytics_window",
        status: 400,
        message: args.message ?? "That window is outside what Cloudflare keeps.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * Cloudflare does not serve Turnstile analytics to this account. A different fact from "nothing was
 * challenged", and the reason this is a refusal rather than an empty answer.
 */
export class TurnstileAnalyticsUnavailableError extends PithyError {
  constructor(args: TurnstileErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "turnstile/analytics_unavailable",
        status: 409,
        message: args.message ?? "Cloudflare does not serve Turnstile analytics to this account.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
