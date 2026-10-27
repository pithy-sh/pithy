// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-plugin/types" />

// Bindings the Workers-runtime test project provides to `*.workers.test.ts`,
// matching the Miniflare config in `vitest.workers.config.ts`: D1 `DB` and
// `ANALYTICS` (a second database, to exercise the multi-database registry), KV
// `SESSIONS`, and KV `CONTROL_PLANE` (the control-plane seam's replay set, which
// gets its own namespace rather than sharing sessions), and the `PRESENCE_ROOMS`
// Durable Object every presence room lives in.
// `cloudflare:test` types its `env` as `Cloudflare.Env`, so the test bindings are
// declared by augmenting that interface.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ANALYTICS: D1Database;
    SESSIONS: KVNamespace;
    CONTROL_PLANE: KVNamespace;
    PRESENCE_ROOMS: DurableObjectNamespace<import("./presence/durableObject").PresenceRoom>;
  }
}
