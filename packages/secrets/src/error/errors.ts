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
