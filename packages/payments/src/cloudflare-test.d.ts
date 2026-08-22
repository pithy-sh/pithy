// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-plugin/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare config
// in `vitest.workers.config.ts`: the app `DB` database the `pithy_payments_*` tables live in, and the
// dedicated `SECRETS` database plus master key the provider credential bundle is read through.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SECRETS: D1Database;
    /** The master-key config as a string (the `.dev.vars` shape), set in `vitest.workers.config.ts`. */
    SECRETS_ENCRYPTION_KEYS: string;
  }
}
