/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare
// config in `vitest.workers.config.ts`: the default audit D1 binding `DB`. `cloudflare:test` types
// its `env` as `Cloudflare.Env`, so the test bindings are declared by augmenting that interface.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}
