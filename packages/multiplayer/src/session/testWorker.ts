// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MultiplayerSession } from "./durableObject";

/**
 * The worker entry the Workers-runtime test project points `main` at, so Miniflare can register the
 * `SESSIONS` Durable Object namespace against the real class. It re-exports `MultiplayerSession` exactly
 * as an adopter's own worker does (`export { MultiplayerSession } from "@pithy-sh/multiplayer/src/session/durableObject"`),
 * plus an inert `fetch` the pool requires. Excluded from coverage — it is test scaffolding, not shipped code.
 */
export { MultiplayerSession };

export default {
  fetch(): Response {
    return new Response("multiplayer test worker", { status: 200 });
  },
};
