// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { EncryptionConfig } from "../crypto/envelope";
import { SecretCryptoError, SecretNotFoundError } from "../error/errors";
import type { ManagedEnvironment } from "../scope";

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
   * The deployment environment, stamped into each deployed worker's vars at provision. Its presence as a
   * `ManagedEnvironment` is what tells the reader it is deployed: deployed reads route strictly by registry
   * backend, while local dev (this var absent) resolves every secret from its injected `.dev.vars` string.
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
    raw = await resolveBinding(env.SECRETS_ENCRYPTION_KEYS, "SECRETS_ENCRYPTION_KEYS");
  } catch (cause) {
    throw new SecretCryptoError({ detail: "SECRETS_ENCRYPTION_KEYS binding is not configured" }, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new SecretCryptoError({ detail: "SECRETS_ENCRYPTION_KEYS is not valid JSON" }, { cause });
  }
  const result = EncryptionConfig.safeParse(parsed);
  if (!result.success) {
    throw new SecretCryptoError({ detail: "SECRETS_ENCRYPTION_KEYS is not a valid EncryptionConfig" });
  }
  return result.data;
}
