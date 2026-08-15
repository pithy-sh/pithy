// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * `@pithy-sh/secrets` throw sugar. The `secrets/*` codes live in core's closed `KitErrorPayload`
 * union (CLAUDE.md §Errors: capabilities add their codes to the one union); these subclasses
 * are the package-local vehicles that set one of those members — the same pattern as core's
 * `NotFoundError` and `@pithy-sh/cloudflare`'s `CloudflareRequestError`. Runtime code in this
 * package throws one of these, never a plain `new Error`.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface SecretErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
}

/** A requested secret is not present in the store. */
export class SecretNotFoundError extends PithyError {
  constructor(args: SecretErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "secrets/not_found",
        status: 404,
        message: args.message ?? "Secret not found.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** A secret with this name already exists; `create` refuses to overwrite it. */
export class SecretAlreadyExistsError extends PithyError {
  constructor(args: SecretErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "secrets/already_exists",
        status: 409,
        message: args.message ?? "A secret with this name already exists.",
        action: args.action ?? "Use `update` to change an existing secret.",
        detail: args.detail,
      },
      options,
    );
  }
}

/** A secret value failed validation against its registry schema. */
export class SecretInvalidValueError extends PithyError {
  constructor(args: SecretErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "secrets/invalid_value",
        status: 400,
        message: args.message ?? "Secret value failed validation.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/**
 * **The issuer rolled the credential and the store did not take its successor.**
 *
 * The one failure `pithy secrets rotate` is built around, and the reason it has a code of its own rather
 * than an `UpstreamError` with a longer sentence: every other secrets failure leaves the previous value
 * live and can be answered by running the command again, and this one cannot. Rolling again produces a
 * third credential and loses the second, so the only remedy is a human in the issuer's console.
 *
 * The secret's name belongs in `message`, and so does the issuer — an operator holding this needs both
 * before they can move, and `detail` is stripped at the HTTP boundary. Never the value: there is no value
 * to carry by the time this is raised, which is the whole of what it says.
 */
export class SecretRotationUnrecordedError extends PithyError {
  constructor(args: SecretErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "secrets/rotation_unrecorded",
        status: 500,
        message: args.message ?? "A credential was rolled at its issuer and its successor was not stored.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}

/** Encrypting or decrypting a secret failed — a missing key version, or unreadable ciphertext. */
export class SecretCryptoError extends PithyError {
  constructor(args: SecretErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "secrets/crypto_failed",
        status: 500,
        message: args.message ?? "Could not encrypt or decrypt the secret.",
        action: args.action,
        detail: args.detail,
      },
      options,
    );
  }
}
