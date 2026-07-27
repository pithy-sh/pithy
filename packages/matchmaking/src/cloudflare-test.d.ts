/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`, matching the Miniflare
// config in `vitest.workers.config.ts`. `cloudflare:test` types its `env` as `Cloudflare.Env`, so test
// bindings are declared by augmenting that interface.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MATCHMAKING: KVNamespace;
    QUEUE: DurableObjectNamespace<import("./queue/durableObject").MatchmakingQueue>;
    PRESENCE: DurableObjectNamespace<import("./presence/durableObject").MatchmakingPresence>;
    SESSIONS?: DurableObjectNamespace;
  }
}
