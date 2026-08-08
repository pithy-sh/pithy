// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare
// config in `vitest.workers.config.ts`: the dedicated `SECRETS` D1 the widget secret's row lives in,
// and the master key that decrypts it. `cloudflare:test` types its `env` as `Cloudflare.Env`, so test
// bindings are declared by augmenting that interface.
declare namespace Cloudflare {
  interface Env {
    SECRETS: D1Database;
    /** The master-key config as a string (the `.dev.vars` shape), set in `vitest.workers.config.ts`. */
    SECRETS_ENCRYPTION_KEYS: string;
  }
}
