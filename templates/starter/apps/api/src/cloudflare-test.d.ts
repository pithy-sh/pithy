/// <reference types="@cloudflare/vitest-pool-workers/types" />

// What `*.workers.test.ts` gets from `cloudflare:test`, matching the bindings the root
// vitest.workers.config.ts declares. Add a binding in both places or the test sees `undefined` typed
// as something real — the one shape of test failure that looks like a bug in your code.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SESSIONS: KVNamespace;
  }
}
