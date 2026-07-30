// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

// The Miniflare `main` for `*.workers.test.ts`: it exists only to register the Durable Object classes so
// the test bindings (`QUEUE`, `PRESENCE`) resolve. Its fetch is inert.

export { MatchmakingPresence } from "./presence/durableObject";
export { MatchmakingQueue } from "./queue/durableObject";

export default {
  fetch(): Response {
    return new Response("matchmaking test worker", { status: 200 });
  },
};
