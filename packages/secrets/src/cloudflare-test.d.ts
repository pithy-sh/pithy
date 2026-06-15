/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`,
// matching the Miniflare config in `vitest.workers.config.ts`: the dedicated D1
// `SECRETS` database. `cloudflare:test` types its `env` as `Cloudflare.Env`, so
// the test bindings are declared by augmenting that interface.
declare namespace Cloudflare {
  interface Env {
    SECRETS: D1Database;
    /** The master-key config as a string (the `.dev.vars` shape), set in `vitest.workers.config.ts`. */
    SECRETS_ENCRYPTION_KEYS: string;
  }
}
