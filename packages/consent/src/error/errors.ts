// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";
import type { UnmarkedString } from "@pithy-sh/core/src/privacy/types";

/**
 * `@pithy-sh/consent` throw sugar. The `consent/*` codes live in core's closed `KitErrorPayload` union (CLAUDE.md
 * §Errors); these subclasses are the package-local vehicles that set one of them. Runtime code in this package
 * throws one of these, never a plain `new Error`.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
export interface ConsentErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: UnmarkedString;
  /** A remediation hint (CLI action line). */
  action?: UnmarkedString;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: UnmarkedString;
  /** Values a translating client interpolates into its own wording for this code. */
  params?: MessageParams;
}

/** A purpose no composed capability or config declares. */
export class ConsentUnknownPurposeError extends PithyError {
  constructor(args: ConsentErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "consent/unknown_purpose",
        status: 404,
        message: args.message ?? "That consent purpose does not exist.",
        action: args.action ?? "Declare it in consent({ purposes }), or under the capability that processes it.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** A grant against a notice version that is not current. */
export class ConsentStaleNoticeError extends PithyError {
  constructor(args: ConsentErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "consent/stale_notice",
        status: 409,
        message: args.message ?? "The notice has changed. Read it again before agreeing.",
        action: args.action ?? "Send the purpose's current notice version; GET {basePath}/purposes names it.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** A grant below the purpose's minimum method. */
export class ConsentMethodBelowMinimumError extends PithyError {
  constructor(args: ConsentErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "consent/method_below_minimum",
        status: 400,
        message: args.message ?? "This consent needs a stronger signature.",
        action:
          args.action ??
          "Collect the purpose's minimum method: a typed name, a drawn signature or a provider's envelope.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** A withdrawal below the grant its purpose requires it to match. */
export class ConsentWithdrawalBelowGrantError extends PithyError {
  constructor(args: ConsentErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "consent/withdrawal_below_grant",
        status: 400,
        message: args.message ?? "To withdraw this consent, sign it the way you gave it.",
        action: args.action ?? "The purpose requires a written withdrawal: collect it at the grant's method or above.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** A grant or withdrawal missing what its method needs. */
export class ConsentEvidenceMissingError extends PithyError {
  constructor(args: ConsentErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "consent/evidence_missing",
        status: 400,
        message: args.message ?? "The signature or the document this consent needs is missing.",
        action: args.action ?? "Send the evidence the method names, and the rendered document for a signed grant.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** A grant whose expiry is not in the future. */
export class ConsentExpiryPassedError extends PithyError {
  constructor(args: ConsentErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "consent/expiry_passed",
        status: 400,
        message: args.message ?? "That expiry has already passed.",
        action: args.action ?? "Send an expiry in the future, or none.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** No document is kept under that hash. */
export class ConsentDocumentNotFoundError extends PithyError {
  constructor(args: ConsentErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "consent/document_not_found",
        status: 404,
        message: args.message ?? "That signed document does not exist.",
        action: args.action ?? "Read the hash off a record; only documents a grant was given against are kept.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** No CONSENT_EVIDENCE bucket is bound. */
export class ConsentEvidenceStoreMissingError extends PithyError {
  constructor(args: ConsentErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "consent/evidence_store_missing",
        status: 500,
        message: args.message ?? "The signature could not be stored.",
        action:
          args.action ??
          "Bind the R2 bucket named CONSENT_EVIDENCE to this Worker. Provisioning the environment creates it.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
