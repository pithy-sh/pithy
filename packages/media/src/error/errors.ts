// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * `@pithy-sh/media` throw sugar. The `media/*` codes live in core's closed `KitErrorPayload` union
 * (CLAUDE.md §Errors: capabilities add their codes to the one union); these subclasses are the
 * package-local vehicles that set one of those members — the same pattern as `@pithy-sh/email` and
 * `@pithy-sh/turnstile`. Runtime code in this package throws one of these, never a plain `new Error`.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface MediaErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
}

/** A requested media record does not exist (or was soft-deleted). */
export class MediaNotFoundError extends PithyError {
  constructor(args: MediaErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "media/not_found",
        status: 404,
        message: args.message ?? "That media does not exist.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** The media type, extension, or backend is not supported for the requested operation. */
export class MediaUnsupportedError extends PithyError {
  constructor(args: MediaErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "media/unsupported",
        status: 400,
        message: args.message ?? "That media type or format is not supported for this operation.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** A storage operation failed — minting a direct-upload URL, or reading/deleting a stored object. */
export class MediaStorageError extends PithyError {
  constructor(args: MediaErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "media/storage_failed",
        status: 502,
        message: args.message ?? "The storage backend could not complete the request.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** An AI enrichment step (image-to-text, transcription, or extraction) failed. */
export class MediaEnrichmentError extends PithyError {
  constructor(args: MediaErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "media/enrichment_failed",
        status: 500,
        message: args.message ?? "Media enrichment could not complete.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}
