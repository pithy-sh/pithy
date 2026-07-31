// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * `@pithy-sh/support` throw sugar. The `support/*` codes live in core's closed `ErrorPayload` union
 * (CLAUDE.md §Errors: capabilities add their codes to the one union); these subclasses are the
 * package-local vehicles that set one of those members — the same pattern as `@pithy-sh/media` and
 * `@pithy-sh/payments`. Runtime code in this package throws one of these, never a plain `new Error`.
 *
 * **Keep the public `message` free of anything the sender wrote.** This capability's entire input is
 * attacker-controlled mail, so an error that echoed a subject line back would turn the error channel
 * into a reflection surface. Sender text goes in `detail`, which the HTTP codec strips.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface SupportErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
}

/** A requested thread, message, or attachment does not exist. */
export class SupportNotFoundError extends PithyError {
  constructor(args: SupportErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "support/not_found",
        status: 404,
        message: args.message ?? "That support thread does not exist.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** A category key or its description failed validation at author time. */
export class SupportInvalidCategoryError extends PithyError {
  constructor(args: SupportErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "support/invalid_category",
        status: 400,
        message: args.message ?? "That support category is not valid.",
        action: args.action ?? "Use a lowercase snake_case key with one instructional sentence describing it.",
        detail: args.detail,
      },
      options,
    );
  }
}

/** An inbound message could not be parsed, or carried nothing this capability can store. */
export class SupportUnparseableMessageError extends PithyError {
  constructor(args: SupportErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "support/unparseable_message",
        status: 400,
        message: args.message ?? "That message could not be read as email.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** An inbound message was refused by the volume or size guard before anything was persisted. */
export class SupportRejectedError extends PithyError {
  constructor(args: SupportErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "support/rejected",
        status: 429,
        message: args.message ?? "That message was refused by the inbound guard.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** The AI classification step failed, or the binding it needs is absent. */
export class SupportClassificationError extends PithyError {
  constructor(args: SupportErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "support/classification_failed",
        status: 500,
        message: args.message ?? "Support classification could not complete.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** A reply could not be enqueued — the email capability is absent, or it refused the job. */
export class SupportReplyFailedError extends PithyError {
  constructor(args: SupportErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "support/reply_failed",
        status: 502,
        message: args.message ?? "That reply could not be sent.",
        action: args.action ?? "Add the email capability and provision it, then retry.",
        detail: args.detail,
      },
      options,
    );
  }
}
