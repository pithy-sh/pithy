// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

// The Miniflare `main` for `*.workers.test.ts`: it exists only to register the presence room's Durable Object
// class, so the `PRESENCE_ROOMS` test binding resolves. Its fetch is inert.

export { PresenceRoom } from "./presence/durableObject";

export default {
  fetch(): Response {
    return new Response("core test worker", { status: 200 });
  },
};
