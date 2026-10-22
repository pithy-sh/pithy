// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-plugin/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`,
// matching the Miniflare config in `vitest.workers.config.ts`: the dedicated D1
// `SECRETS` database. `cloudflare:test` types its `env` as `Cloudflare.Env`, so
// the test bindings are declared by augmenting that interface.
declare namespace Cloudflare {
  interface Env {
    SECRETS: D1Database;
    /** An adopter's app database, holding the encrypted columns the field-key rotation re-seals (#390). */
    APP_DB: D1Database;
    /** The master-key config as a string (the `.dev.vars` shape), set in `vitest.workers.config.ts`. */
    SECRETS_ENCRYPTION_KEYS: string;
  }
}
