// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The write-back seam for the master-key config. The at-rest rotation Workflow updates
 * `SECRETS_ENCRYPTION_KEYS` (a CF Secrets Store entry) via the CF API — the binding itself is
 * read-only. This interface decouples the rotation logic from the CF client so the core is
 * testable with a stub; the real implementation (backed by `@pithy-sh/cloudflare`'s
 * `CloudflareSecretsStoreManager`) is wired into the manager worker.
 */
export interface ConfigWriter {
  /**
   * Persist the new `SECRETS_ENCRYPTION_KEYS` value. The write is an in-place update, so a failure
   * leaves the prior config intact and readable — losing this config would make every stored secret
   * undecryptable, and no window exists in which it is absent. A failed write throws; the caller
   * (the rotation Workflow step) retries.
   */
  write(value: string): Promise<void>;
}
