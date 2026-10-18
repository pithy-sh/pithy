// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-plugin/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare
// config in `vitest.workers.config.ts`: the app `DB` database the media tables live in, the `SECRETS`
// database and master key the composed suite reads its R2 bundle through, and the `MEDIA_BUCKET` it
// presigns. `cloudflare:test` types its `env` as `Cloudflare.Env`, so test bindings are declared by
// augmenting that interface.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SECRETS: D1Database;
    SECRETS_ENCRYPTION_KEYS: string;
    MEDIA_BUCKET: R2Bucket;
  }
}
