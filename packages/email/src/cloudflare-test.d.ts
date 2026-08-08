// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare
// config in `vitest.workers.config.ts`: the app `DB` database the email tables live in, and the
// dedicated `SECRETS` database plus master key the link-signing key's row is read through.
// `cloudflare:test` types its `env` as `Cloudflare.Env`, so test bindings are declared by augmenting
// that interface.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    EMAIL_SUPPRESSIONS: D1Database;
    SECRETS: D1Database;
    /** The master-key config as a string (the `.dev.vars` shape), set in `vitest.workers.config.ts`. */
    SECRETS_ENCRYPTION_KEYS: string;
  }
}
