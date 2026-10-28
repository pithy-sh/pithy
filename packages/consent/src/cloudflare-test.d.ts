// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-plugin/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare config in
// `vitest.workers.config.ts`: the app `DB` the `pithy_consent_*` tables live in, the `CONSENT_EVIDENCE` bucket, and
// a test field key.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CONSENT_EVIDENCE: R2Bucket;
    PITHY_FIELD_KEYS: string;
  }
}
