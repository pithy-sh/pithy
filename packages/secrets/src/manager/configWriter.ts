/**
 * The write-back seam for the master-key config. The at-rest rotation Workflow updates
 * `SECRETS_ENCRYPTION_KEYS` (a CF Secrets Store entry) via the CF API — the binding itself is
 * read-only. This interface decouples the rotation logic from the CF client so the core is
 * testable with a stub; the real implementation (backed by `@pithy-sh/cloudflare`'s
 * `CloudflareSecretsStoreManager`) is wired into the manager worker.
 */
export interface ConfigWriter {
  /**
   * Persist the new `SECRETS_ENCRYPTION_KEYS` value. `previous` is passed for atomic recovery —
   * losing the config would make every stored secret undecryptable, so a transient write failure
   * must be able to restore the prior value.
   */
  write(value: string, previous: string): Promise<void>;
}
