// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-plugin/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare
// config in `vitest.workers.config.ts`: the app `DB` database the support tables live in, and the
// `SUPPORT_BUCKET` R2 bucket attachment bytes are written to. `cloudflare:test` types its `env` as
// `Cloudflare.Env`, so test bindings are declared by augmenting that interface.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SUPPORT_BUCKET: R2Bucket;
  }
}
