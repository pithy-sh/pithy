// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";
import type { UnmarkedString } from "@pithy-sh/core/src/privacy/types";

/** What each refusal takes. `detail` says why, for the operator's log; it never reaches the client. */
interface AttestationErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: UnmarkedString;
  /** The operator's remedy (CLI action line). */
  action?: UnmarkedString;
  /** Why it was refused, for logs. Never serialized to clients. */
  detail?: UnmarkedString;
  /** Values a translating client interpolates into its own wording for this code. */
  params?: MessageParams;
}

/** `auth/attestation_missing` (400): attestation is this route's only gate, and the request carried none. */
export class AttestationMissingError extends PithyError {
  constructor(args: AttestationErrorArgs) {
    super({
      code: "auth/attestation_missing",
      status: 400,
      message: args.message ?? "This app must attest before it can sign in.",
      action: args.action,
      detail: args.detail,
      params: args.params,
    });
  }
}

/** `auth/attestation_failed` (403): the attestation did not verify. Never falls through to Turnstile. */
export class AttestationFailedError extends PithyError {
  constructor(args: AttestationErrorArgs) {
    super({
      code: "auth/attestation_failed",
      status: 403,
      message: args.message ?? "The app's attestation did not verify. Ask for a new challenge and try again.",
      action: args.action,
      detail: args.detail,
      params: args.params,
    });
  }
}

/** `auth/attestation_config` (500): the server's attestation setup cannot judge this request. */
export class AttestationConfigError extends PithyError {
  constructor(args: AttestationErrorArgs) {
    super({
      code: "auth/attestation_config",
      status: 500,
      message: args.message ?? "App attestation is not configured.",
      action: args.action,
      detail: args.detail,
      params: args.params,
    });
  }
}
