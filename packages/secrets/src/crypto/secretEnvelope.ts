// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  decryptValue,
  type EncryptedEnvelope,
  type EncryptionConfig,
  encryptValue,
} from "@pithy-sh/core/src/crypto/envelope";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { MASTER_KEY_BINDING } from "../env/masterKeyBinding";
import { SecretCryptoError } from "../error/errors";

/**
 * **A secret's envelope: core's AES-256-GCM primitive, bound to the secret's stored name** (#390).
 *
 * The primitive moved to `@pithy-sh/core/src/crypto/envelope` so field encryption could use it, and it takes its
 * bound context as a parameter. This module is what secrets binds, and it binds exactly what it always did:
 * `pithy.secrets.v1:<stored name>`. A row sealed before the move opens after it, and
 * `secretEnvelope.test.ts` holds a ciphertext the old module wrote to prove it.
 *
 * ## The secret's name is authenticated, not decorative
 *
 * Without the name bound, a ciphertext lifted from one row and written into another opens cleanly, and every
 * decision about which secret a caller gets lives in the query above. With it, a moved ciphertext does not open,
 * inside the primitive, however that query is later rewritten.
 *
 * The stored name is the right thing to bind because it *is* the row's identity: `name` is unique in
 * `pithy_secrets_system_secrets`, and for a keyspace member it is the whole `<entry>/<key>` (`keyspace.ts`), so one
 * tenant's credential does not open under another tenant's key.
 *
 * **What is bound must be stable for the life of the ciphertext, and this is.** Nothing renames a secret: the store
 * offers `put` and `delete`, and a rename is a create under the new name plus a delete of the old, which re-encrypts
 * through the plaintext. An `UPDATE ... SET name` in raw SQL would leave a row that never opens again, which is the
 * property, not a regression.
 *
 * **No compatibility path.** Ciphertexts written before the binding existed carry no AAD and do not open — they fail
 * as `secrets/crypto_failed`, like any other unreadable row.
 *
 * ## Every failure is `secrets/crypto_failed`
 *
 * Core raises its own `core/internal` on a refused open, because core has no capability codes. Secrets has always
 * answered `secrets/crypto_failed`, and `secretsWorkflowRetry` lists that code as terminal by name, so the refusal is
 * re-raised here with core's `detail` and `cause` intact. Nothing else changes about it.
 */

/** The domain-separation prefix secrets binds. Versioned, so changing what is bound is a deliberate break. */
const SECRET_CONTEXT = "pithy.secrets.v1:";

/**
 * The context one secret binds: the prefix and the stored name. An empty name is refused, because it would bind the
 * prefix alone, and every secret sharing one context is the same as binding nothing.
 */
export function secretContext(name: string): string {
  if (name.length === 0) {
    throw new SecretCryptoError({ detail: "the envelope needs a secret name to bind; an empty name binds nothing" });
  }
  return `${SECRET_CONTEXT}${name}`;
}

/** Re-raise core's refusal as secrets' own code, keeping what it said. */
function asSecretCryptoError(cause: unknown): SecretCryptoError {
  if (cause instanceof SecretCryptoError) return cause;
  const detail = cause instanceof PithyError ? cause.payload.detail : undefined;
  return new SecretCryptoError(detail === undefined ? {} : { detail }, { cause });
}

/** Seal `plaintext` for the secret stored as `name`, under the config's current key version. */
export async function sealSecret(
  config: EncryptionConfig,
  name: string,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  const context = secretContext(name);
  try {
    return await encryptValue(config, context, plaintext, { keys: MASTER_KEY_BINDING });
  } catch (cause) {
    throw asSecretCryptoError(cause);
  }
}

/**
 * Open an envelope sealed for the secret stored as `name`. A missing key version, a tampered ciphertext, the wrong
 * key, or a ciphertext sealed for a different name all throw `secrets/crypto_failed`, never the plaintext or key
 * material. The `detail` names the context the open was attempted under; every name is a registry literal or a
 * `keyedSecretName` composed from a validated `SecretKey`, so it is safe in a log.
 */
export async function openSecret(config: EncryptionConfig, name: string, envelope: EncryptedEnvelope): Promise<string> {
  const context = secretContext(name);
  try {
    return await decryptValue(config, context, envelope, { keys: MASTER_KEY_BINDING });
  } catch (cause) {
    throw asSecretCryptoError(cause);
  }
}
