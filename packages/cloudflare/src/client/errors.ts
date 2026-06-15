import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { z } from "zod";

/**
 * Cloudflare REST client throw sugar. The `cloudflare/*` codes live in core's closed
 * `ErrorPayload` union (CLAUDE.md §Errors: capabilities add their codes to the one union); these
 * subclasses are the package-local vehicles that set one of those members — the same pattern as
 * core's `NotFoundError`/`InternalError`, just owned here. Runtime code in this package throws
 * one of these, never a plain `new Error`.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface CloudflareErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
}

/** A required piece of configuration (token, account id, resource id) is missing. */
export class CloudflareNotConfiguredError extends PithyError {
  constructor(args: CloudflareErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "cloudflare/not_configured",
        status: 500,
        message: args.message ?? "The Cloudflare REST client is not fully configured.",
        action: args.action ?? "Provide apiToken, accountId, and any required resource id.",
        detail: args.detail,
      },
      options,
    );
  }
}

/** A call to the Cloudflare REST API failed (network error, 4xx/5xx from the API). */
export class CloudflareRequestError extends PithyError {
  constructor(args: CloudflareErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "cloudflare/request_failed",
        status: 502,
        message: args.message ?? "A Cloudflare REST API call failed.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** A Cloudflare REST API response did not match its expected shape (failed Zod validation). */
export class CloudflareInvalidResponseError extends PithyError {
  constructor(args: CloudflareErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "cloudflare/invalid_response",
        status: 502,
        message: args.message ?? "A Cloudflare REST API response had an unexpected shape.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/**
 * Run a Cloudflare SDK call and turn any failure into a `CloudflareRequestError`, preserving the
 * original error as `cause` and its message as internal `detail`. `operation` names the call for
 * the audit trail (`"KV get for key 'x'"`). A `PithyError` already in flight (e.g. a
 * not-configured guard) passes through untouched — only foreign throws get wrapped.
 */
export async function cloudflareRequest<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PithyError) throw error;
    throw new CloudflareRequestError(
      { message: `Cloudflare request failed: ${operation}.`, detail: messageOf(error) },
      { cause: error },
    );
  }
}

/** The raw message of an unknown throw, for use as a PithyError `detail`. One source of truth. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The most specific failure reason available, for a partial-failure report's `error` field: a
 * `PithyError`'s internal `detail` (the real cause `cloudflareRequest` captured), else its public
 * message, else the raw throw. Centralized so the detail-vs-message precedence lives in one place.
 */
export function reasonOf(error: unknown): string {
  if (error instanceof PithyError) return error.payload.detail ?? error.payload.message;
  return messageOf(error);
}

/** Whether a thrown SDK error is an HTTP 404 — the SDK throws on a missing resource, not null. */
export function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;
}

/**
 * Decode a Cloudflare response against `schema`, throwing `cloudflare/invalid_response` on a shape
 * mismatch. The decode counterpart to `cloudflareRequest`'s error wrapping — one seam so every
 * manager validates the wire the same way instead of hand-rolling `safeParse` + throw.
 */
export function decodeResponse<T extends z.ZodType>(schema: T, raw: unknown, context: string): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new CloudflareInvalidResponseError({
      message: `A Cloudflare response had an unexpected shape: ${context}.`,
      detail: parsed.error.message,
    });
  }
  return parsed.data;
}
