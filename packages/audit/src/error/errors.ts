// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * Audit recorder throw sugar. The `audit/*` codes live in core's closed `KitErrorPayload` union
 * (CLAUDE.md §Errors: capabilities add their codes to the one union); these subclasses are the
 * package-local vehicles that set one of those members — the same pattern as core's `NotFoundError`
 * and `@pithy-sh/cloudflare`'s error classes. Runtime code here builds one of these, never a plain
 * `new Error`.
 *
 * Both are recorded **non-fatally**: the recorder constructs one to represent a failure it logs, but
 * never throws it into the audited action. `detail` carries throw-site context for logs; it is never
 * serialized to a client (the HTTP codec strips it).
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface AuditErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
}

/** An audit event failed validation against the `AuditEvent` schema (bad action, outcome, or actor). */
export class AuditInvalidEventError extends PithyError {
  constructor(args: AuditErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "audit/invalid_event",
        status: 400,
        message: args.message ?? "An audit event failed validation.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** Persisting an audit event to D1 failed after retries. Logged, never thrown to a client. */
export class AuditWriteFailedError extends PithyError {
  constructor(args: AuditErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "audit/write_failed",
        status: 500,
        message: args.message ?? "Failed to persist an audit event.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}
