// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";

/**
 * `@pithy-sh/storage` throw sugar. The `storage/*` codes live in core's closed `KitErrorPayload` union
 * (CLAUDE.md §Errors); these subclasses are the package-local vehicles that set one of those members.
 * Runtime code in this package throws one of these, never a plain `new Error`.
 *
 * Public text goes in `message` and `action`; throw-site context goes in `detail`, which the HTTP
 * codec strips. That matters more here than in most capabilities: object keys, upload ids, and byte
 * counts are exactly the kind of internal shape a client should never be handed.
 */

interface StorageErrorArgs {
  message?: string;
  action?: string;
  detail?: string;
  /**
   * Values a translating client interpolates into its own wording for this code. Client-facing, so —
   * unlike `action` and `detail` — these cross the boundary with `message`.
   */
  params?: MessageParams;
}

export class StorageNotFoundError extends PithyError {
  constructor(args: StorageErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "storage/not_found",
        status: 404,
        message: args.message ?? "That file does not exist.",
        action: args.action ?? "Check the object id. A file you do not own reads as missing, not as forbidden.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class StorageForbiddenError extends PithyError {
  constructor(args: StorageErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "storage/forbidden",
        status: 403,
        message: args.message ?? "That file is not yours.",
        action: args.action ?? "Sign in as the owner, or ask them for a share link.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class StorageQuotaExceededError extends PithyError {
  constructor(args: StorageErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "storage/quota_exceeded",
        status: 413,
        message: args.message ?? "That upload would put you over your storage quota.",
        action: args.action ?? "Delete something first, or raise the quota in pithy.config.ts.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class StorageUploadIncompleteError extends PithyError {
  constructor(args: StorageErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "storage/upload_incomplete",
        status: 409,
        message: args.message ?? "That file has not finished uploading.",
        action: args.action ?? "Upload every part, then complete the upload.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class StorageMultipartFailedError extends PithyError {
  constructor(args: StorageErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "storage/multipart_failed",
        status: 500,
        // The recovery route is the caller's own answer, so it is in `message`: an `action` is the
        // operator's sentence and the HTTP codec strips it (#344). A client that cannot see how to
        // finish an upload it half-made has been told nothing useful.
        message: args.message ?? "The upload could not be assembled. GET /storage/<id>/parts to see what is missing.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class StorageShareExpiredError extends PithyError {
  constructor(args: StorageErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "storage/share_expired",
        status: 410,
        message: args.message ?? "That share link has expired.",
        action: args.action ?? "Ask the owner for a new one.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class StorageShareRevokedError extends PithyError {
  constructor(args: StorageErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "storage/share_revoked",
        status: 410,
        message: args.message ?? "That share link was revoked.",
        action: args.action ?? "Ask the owner for a new one.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
