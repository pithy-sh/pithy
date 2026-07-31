// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare
// config in `vitest.workers.config.ts`: the app `DB` database the `pithy_testers_*` tables live in,
// alongside the `pithy_auth_*` tables the activity reader joins against.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}
