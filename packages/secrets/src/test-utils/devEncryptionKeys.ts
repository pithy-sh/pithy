// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EncryptionConfig } from "../crypto/envelope";

/**
 * A fresh AES-256 master-key config for a test run, as the string a `SECRETS_ENCRYPTION_KEYS` binding
 * carries — the same shape `.dev.vars` supplies in local dev. Put it on a package's Miniflare
 * `bindings` and the worker resolves its encryption config from it, so encrypt, decrypt, and at-rest
 * rotation are all exercisable locally with no live Cloudflare Secrets Store.
 *
 * **Its own module, with one type-only import and nothing else, and that is load-bearing.** A
 * `vitest.workers.config.ts` is loaded by vite through Node's own ESM resolver, which cannot follow
 * the extensionless specifiers this repository's TypeScript sources use — so a config importing
 * anything with a runtime dependency fails before a single test runs. The type import is erased.
 * Keep this file free of runtime imports, or every workers config that reads it stops loading.
 *
 * Generated per call, and never reused as anything but a test key.
 */
export function devEncryptionKeys(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  const config: EncryptionConfig = {
    currentVersion: "1",
    versions: { "1": btoa(binary) },
    lastRotatedAt: "2026-01-01T00:00:00.000Z",
  };
  return JSON.stringify(config);
}
