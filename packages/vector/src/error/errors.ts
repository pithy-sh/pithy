// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";

/**
 * `@pithy-sh/vector` throw sugar. The `vector/*` codes live in core's closed `KitErrorPayload` union
 * (CLAUDE.md §Errors); these subclasses are the package-local vehicles that set one of those members.
 * Runtime code in this package throws one of these, never a plain `new Error`.
 *
 * The messages carry the ceiling that was breached, because "topK is too large" without the number sends the
 * reader to the docs. Public text stays in `message`/`action`; the offending value goes in `detail`, which
 * the HTTP codec strips.
 */

interface VectorErrorArgs {
  message?: string;
  action?: string;
  detail?: string;
  /**
   * Values a translating client interpolates into its own wording for this code. Client-facing, so —
   * unlike `action` and `detail` — these cross the boundary with `message`.
   */
  params?: MessageParams;
}

export class VectorMetadataIndexDriftError extends PithyError {
  constructor(args: VectorErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "vector/metadata_index_drift",
        status: 500,
        message: args.message ?? "Search is not configured correctly.",
        action:
          args.action ??
          "Run `pithy vector provision` to create the missing metadata indexes, then re-embed anything written before them.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class VectorDimensionMismatchError extends PithyError {
  constructor(args: VectorErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "vector/dimension_mismatch",
        status: 400,
        message: args.message ?? "That vector is the wrong size for this index.",
        action:
          args.action ??
          "An index's dimensions are fixed at creation. Embed with the model the index declares, or create a new index.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class VectorTopKExceededError extends PithyError {
  constructor(args: VectorErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "vector/topk_exceeded",
        status: 400,
        message: args.message ?? "Too many matches requested.",
        action: args.action ?? "Ask for at most 50 matches with values or metadata, 100 without.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class VectorFilterTooLargeError extends PithyError {
  constructor(args: VectorErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "vector/filter_too_large",
        status: 400,
        message: args.message ?? "That filter is too large.",
        action: args.action ?? "A filter's compact JSON must stay under 2,048 bytes. Narrow it, or split the query.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class VectorMetadataTooLargeError extends PithyError {
  constructor(args: VectorErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "vector/metadata_too_large",
        status: 400,
        message: args.message ?? "That vector carries too much metadata.",
        action:
          args.action ??
          "A vector's metadata must stay under 10 KiB. Keep long text in the document table and reference it by id.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class VectorIndexNotFoundError extends PithyError {
  constructor(args: VectorErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "vector/index_not_found",
        status: 404,
        message: args.message ?? "That index does not exist.",
        action: args.action ?? "Check the index name against the `indexes` block in pithy.config.ts.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

export class VectorUnfilterableFieldError extends PithyError {
  constructor(args: VectorErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "vector/unfilterable_field",
        status: 400,
        message: args.message ?? "You cannot filter on that field.",
        action:
          args.action ??
          "Mark the field `.meta({ filterable: true })` in the index's metadata schema, run `pithy vector provision`, and re-embed — Vectorize does not index what was written before the metadata index existed.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
