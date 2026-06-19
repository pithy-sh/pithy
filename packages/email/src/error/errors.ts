import { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * `@pithy-sh/email` throw sugar. The `email/*` codes live in core's closed `ErrorPayload` union
 * (CLAUDE.md §Errors: capabilities add their codes to the one union); these subclasses are the
 * package-local vehicles that set one of those members — the same pattern as `@pithy-sh/secrets`.
 * Runtime code in this package throws one of these, never a plain `new Error`.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface EmailErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
}

/** The requested template id is not registered. */
export class EmailTemplateNotFoundError extends PithyError {
  constructor(args: EmailErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "email/template_not_found",
        status: 404,
        message: args.message ?? "Email template not found.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** A template's input variables failed validation against its payload schema. */
export class EmailInvalidPayloadError extends PithyError {
  constructor(args: EmailErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "email/invalid_payload",
        status: 400,
        message: args.message ?? "Email template payload failed validation.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** A callback token (click/open/unsubscribe) is malformed, expired, forged, or signed by an unknown key. */
export class EmailInvalidTokenError extends PithyError {
  constructor(args: EmailErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "email/invalid_token",
        status: 400,
        message: args.message ?? "This link is invalid or has expired.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** The recipient address is on the suppression list and cannot be sent to. */
export class EmailSuppressedError extends PithyError {
  constructor(args: EmailErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "email/suppressed",
        status: 409,
        message: args.message ?? "This address is suppressed and cannot be emailed.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** The Email Service rejected the send for a rate or daily-quota limit; the send is retryable. */
export class EmailRateLimitedError extends PithyError {
  constructor(args: EmailErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "email/rate_limited",
        status: 429,
        message: args.message ?? "The email rate limit was exceeded.",
        action: args.action ?? "Retry with backoff.",
        detail: args.detail,
      },
      options,
    );
  }
}

/** A send through the Email Service binding failed for a non-retryable reason. */
export class EmailSendFailedError extends PithyError {
  constructor(args: EmailErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "email/send_failed",
        status: 502,
        message: args.message ?? "The email could not be sent.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}
