// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare config
// in `vitest.workers.config.ts`: the app `DB` database the `pithy_storage_*` tables live in, and the
// `STORAGE_BUCKET` R2 bucket objects are written to.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    STORAGE_BUCKET: R2Bucket;
  }
}
