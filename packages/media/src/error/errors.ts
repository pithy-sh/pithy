// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";
import type { UnmarkedString } from "@pithy-sh/core/src/privacy/types";

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
  detail?: UnmarkedString;
  /**
   * Values a translating client interpolates into its own wording for this code. Client-facing, so —
   * unlike `action` and `detail` — these cross the boundary with `message`.
   */
  params?: MessageParams;
}

/**
 * A requested media record does not exist — **or exists and is not the caller's to see.** One answer for
 * both, so an id cannot be probed: a distinguishable refusal on a private record would confirm it exists.
 */
export class MediaNotFoundError extends PithyError {
  constructor(args: MediaErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "media/not_found",
        status: 404,
        message: args.message ?? "That media does not exist.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * The caller may read the record but not change it. Only ever thrown after a read was allowed — a caller
 * who cannot see a record is told it is not found — so it discloses nothing they did not already know.
 */
export class MediaForbiddenError extends PithyError {
  constructor(args: MediaErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "media/forbidden",
        status: 403,
        message: args.message ?? "You can see this media, but it is not yours to change.",
        action: args.action,
        detail: args.detail,
        params: args.params,
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
        params: args.params,
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
        params: args.params,
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
        params: args.params,
      },
      options,
    );
  }
}

/**
 * A delivery-analytics window Cloudflare cannot answer: older than the dataset keeps, or wider than one
 * read may ask for. The message names the cap in days, so the caller can choose a window that works.
 */
export class MediaAnalyticsWindowError extends PithyError {
  constructor(args: MediaErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "media/analytics_window",
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
 * Cloudflare does not serve the delivery analytics this read needs to this account. Under a Customer
 * Metadata Boundary outside the US it serves none of them — a different fact from "nothing was watched",
 * and the reason this is a refusal rather than an empty answer.
 */
export class MediaAnalyticsUnavailableError extends PithyError {
  constructor(args: MediaErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "media/analytics_unavailable",
        status: 409,
        message: args.message ?? "Cloudflare does not serve these analytics to this account.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
