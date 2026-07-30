// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare
// config in `vitest.workers.config.ts`: the app `DB` database the media tables live in, and the `MEDIA`
// KV namespace the `recordStore: 'kv'` path uses. `cloudflare:test` types its `env` as `Cloudflare.Env`,
// so test bindings are declared by augmenting that interface.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MEDIA: KVNamespace;
  }
}
