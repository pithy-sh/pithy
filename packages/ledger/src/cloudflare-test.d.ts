/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare config
// in `vitest.workers.config.ts`: the app `DB` database the `pithy_ledger_*` tables live in.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}
