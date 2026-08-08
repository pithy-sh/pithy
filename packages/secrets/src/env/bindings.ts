// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { EncryptionConfig } from "../crypto/envelope";
import { SecretCryptoError, SecretNotFoundError } from "../error/errors";
import type { ManagedEnvironment } from "../scope";

/**
 * The **binding name** every worker reads the master key through, fixed across environments — the
 * counterpart to `masterKeySecretName`, which scopes the Secrets Store *entry* the binding points at.
 * Local dev has no store: `.dev.vars` supplies this same name as a string, so it is also the key
 * `pithy add secrets` writes there.
 *
 * Stated once, and here, beside the reader: the writer is in another package, and a near-miss between
 * the two ends is a worker that boots into "Missing required bindings" over a value that was written.
 */
export const MASTER_KEY_BINDING = "SECRETS_ENCRYPTION_KEYS";

/**
 * A Cloudflare Secrets Store binding: `.get()` resolves the secret's plaintext inside the
 * worker. In local dev `.dev.vars` resolves the same name to a literal string instead, so
 * every binding is `SecretBinding | string` and {@link resolveBinding} normalizes the two.
 */
export interface SecretBinding {
  get(): Promise<string>;
}

/** The env a worker needs to read secrets: the dedicated `SECRETS` D1 and the master-key binding. */
export interface SecretsStoreEnv {
  /** The per-environment secrets D1 (its own binding, distinct from the app `DB`). */
  SECRETS: D1Database;
  /** The master-key config — a CF Secrets Store binding in deployed envs, a string in local dev. */
  SECRETS_ENCRYPTION_KEYS: SecretBinding | string;
  /**
   * The deployment environment, stamped into each deployed worker's vars at provision. Absent in local dev.
   *
   * **The read seam does not consult it (#153).** Which environment's values a worker reads is already
   * decided by which `SECRETS` D1 and which master key it is bound to, so routing on this as well was a
   * second answer to a settled question — and the answer it gave in dev was "resolve every secret from a
   * plaintext binding, whatever its backend". It stays here because it is genuinely part of a deployed
   * worker's env: the secrets manager reads it to name the environment it writes to.
   */
  ENVIRONMENT?: ManagedEnvironment;
}

/**
 * Resolve a binding to its plaintext: a literal string passes through (local dev `.dev.vars`),
 * a CF Secrets Store binding is read via `.get()`. Throws `secrets/not_found` when neither is
 * present, so a missing binding fails loudly instead of surfacing as a silently-absent secret.
 */
export async function resolveBinding(value: SecretBinding | string | undefined, name: string): Promise<string> {
  if (typeof value === "string") return value;
  if (value && typeof value.get === "function") return value.get();
  throw new SecretNotFoundError({
    message: `Secret binding '${name}' is not configured.`,
    detail: `binding '${name}' is neither a CF Secrets Store binding nor a .dev.vars string`,
  });
}

/**
 * Resolve and validate the master-key config from `SECRETS_ENCRYPTION_KEYS`. A missing binding,
 * non-JSON, or a malformed config is a key-availability fault (`secrets/crypto_failed`) — the
 * worker cannot decrypt anything without it. The raw key material never reaches the error.
 */
export async function resolveEncryptionConfig(env: SecretsStoreEnv): Promise<EncryptionConfig> {
  let raw: string;
  try {
    raw = await resolveBinding(env.SECRETS_ENCRYPTION_KEYS, MASTER_KEY_BINDING);
  } catch (cause) {
    throw new SecretCryptoError({ detail: `${MASTER_KEY_BINDING} binding is not configured` }, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new SecretCryptoError({ detail: `${MASTER_KEY_BINDING} is not valid JSON` }, { cause });
  }
  const result = EncryptionConfig.safeParse(parsed);
  if (!result.success) {
    throw new SecretCryptoError({ detail: `${MASTER_KEY_BINDING} is not a valid EncryptionConfig` });
  }
  return result.data;
}
