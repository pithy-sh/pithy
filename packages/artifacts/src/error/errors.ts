// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";
import type { UnmarkedString } from "@pithy-sh/core/src/privacy/types";

/**
 * `@pithy-sh/artifacts` throw sugar. The `artifacts/*` codes live in core's closed `KitErrorPayload` union; these
 * are the package-local vehicles that set one of them. Runtime code here throws one of these, never a plain error.
 */

/** Variable parts each subclass accepts; `code` and `status` are fixed by the subclass. */
interface ArtifactsErrorArgs {
  /** Override the public message. */
  message?: UnmarkedString;
  /** A remediation hint for the operator. Never serialized to a client. */
  action?: UnmarkedString;
  /** Internal context for logs and audit. Never serialized to a client. */
  detail?: UnmarkedString;
  /** Values a translating client interpolates into its own wording for this code. */
  params?: MessageParams;
}

/**
 * **The one refusal for a repository a caller may not see, and for one that does not exist.** The message is
 * fixed, deliberately: the 404 for a stranger's repository must be byte-identical to the 404 for no repository,
 * because the name is in the clone URL. Only `detail` differs, and the HTTP codec strips it.
 */
export class ArtifactsNotFoundError extends PithyError {
  constructor(args: Pick<ArtifactsErrorArgs, "detail" | "params"> = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "artifacts/not_found",
        status: 404,
        message: "That repository does not exist.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The caller can see the repository and may not do this to it. */
export class ArtifactsForbiddenError extends PithyError {
  constructor(args: ArtifactsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "artifacts/forbidden",
        status: 403,
        message: args.message ?? "Only the repository's owner may do that.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** A repository name breaks Cloudflare's charset or the cap. */
export class ArtifactsInvalidNameError extends PithyError {
  constructor(args: ArtifactsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "artifacts/invalid_name",
        status: 400,
        message: args.message ?? "That repository name is not valid.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The owner already holds that display name, or the namespace already holds that physical name. */
export class ArtifactsNameTakenError extends PithyError {
  constructor(args: ArtifactsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "artifacts/name_taken",
        status: 409,
        message: args.message ?? "A repository with that name already exists.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The configuration cannot be honored. Raised at boot. */
export class ArtifactsInvalidConfigError extends PithyError {
  constructor(args: ArtifactsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "artifacts/invalid_config",
        status: 400,
        message: args.message ?? "The artifacts configuration is invalid.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
