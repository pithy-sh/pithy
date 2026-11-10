/// <reference types="@cloudflare/vitest-plugin/types" />

// What `*.workers.test.ts` gets from `cloudflare:test`, matching the bindings the root
// vitest.workers.config.ts declares. `pithy add <capability>` writes a capability's test bindings into
// both, and `pithy remove` takes them out of both. A binding your own code needs goes in both by hand,
// or the test sees `undefined` typed as something real.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SESSIONS: KVNamespace;
  }
}
