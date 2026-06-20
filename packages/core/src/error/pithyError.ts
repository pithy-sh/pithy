import type { z } from "zod";
import type { ValidationIssue } from "./payload";
import { ErrorPayload } from "./payload";

/**
 * `PithyError` is the one throw/catch vehicle. A thrown thing must be `instanceof Error`
 * (for `catch`, stack traces, `cause`); a Zod object is a data shape, not an `Error`. So the
 * class does not extend a schema — it **carries** one. The payload is validated against
 * `ErrorPayload` at construction, so every `PithyError` in flight is a member of the closed
 * taxonomy. The subclasses below are sugar that default a member's `code`/`status`; they set a
 * payload the union already defines, so there is no second source of truth.
 */
export class PithyError extends Error {
  readonly payload: ErrorPayload;

  constructor(payload: ErrorPayload, options?: { cause?: unknown }) {
    const parsed = ErrorPayload.parse(payload);
    super(parsed.message, options);
    this.payload = parsed;
    this.name = "PithyError";
  }
}

/** Variable parts every subclass accepts; the `code`/`status` are fixed by the subclass. */
interface ErrorArgs {
  /** Override the public, safe-to-expose message. Defaults to a per-code summary. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
}

export class ValidationError extends PithyError {
  declare readonly payload: Extract<ErrorPayload, { code: "validation/invalid_input" }>;

  constructor(args: ErrorArgs & { issues?: ValidationIssue[] } = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "validation/invalid_input",
        status: 400,
        message: args.message ?? "Invalid input.",
        action: args.action,
        detail: args.detail,
        issues: args.issues ?? [],
      },
      options,
    );
  }
}

export class UnauthorizedError extends PithyError {
  declare readonly payload: Extract<ErrorPayload, { code: "auth/invalid_token" }>;

  constructor(args: ErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "auth/invalid_token",
        status: 401,
        message: args.message ?? "Invalid or expired credentials.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

export class ForbiddenError extends PithyError {
  declare readonly payload: Extract<ErrorPayload, { code: "auth/forbidden" }>;

  constructor(args: ErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "auth/forbidden",
        status: 403,
        message: args.message ?? "Forbidden.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

export class NotFoundError extends PithyError {
  declare readonly payload: Extract<ErrorPayload, { code: "core/not_found" }>;

  constructor(args: ErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "core/not_found",
        status: 404,
        message: args.message ?? "Not found.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

export class ConflictError extends PithyError {
  declare readonly payload: Extract<ErrorPayload, { code: "core/conflict" }>;

  constructor(args: ErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "core/conflict",
        status: 409,
        message: args.message ?? "Conflict.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

export class RateLimitError extends PithyError {
  declare readonly payload: Extract<ErrorPayload, { code: "rate_limit/exceeded" }>;

  constructor(args: ErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "rate_limit/exceeded",
        status: 429,
        message: args.message ?? "Too many requests.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

export class InternalError extends PithyError {
  declare readonly payload: Extract<ErrorPayload, { code: "core/internal" }>;

  constructor(args: ErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "core/internal",
        status: 500,
        message: args.message ?? "Something unexpected happened.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/**
 * Map a `ZodError` to a `validation/invalid_input` `PithyError`. Zod is the boundary validator
 * everywhere (HTTP input, KV, env, D1 rows), so this is the most common error path — one place
 * turns any failed parse into the typed family, carrying the field-level issues to the client.
 */
export function fromZodError(error: z.ZodError, args: ErrorArgs = {}): ValidationError {
  const issues: ValidationIssue[] = error.issues.map((issue) => ({
    path: issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
    message: issue.message,
    code: issue.code,
  }));
  return new ValidationError({ message: args.message, action: args.action, detail: args.detail, issues });
}

/**
 * The message of an unknown throw, for use as a `PithyError` `detail` — `error.message` for an
 * `Error`, else its string form. One source of truth so every catch site that wants the cause text
 * does it the same way (CLAUDE.md §Errors).
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
