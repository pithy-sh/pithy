// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The presence protocol — the header shared by the presence Durable Object and the HTTP routes. The frames
 * themselves live in `./frames`. Kept free of any `cloudflare:workers` import so the routes (and their
 * node-side tests) can depend on it without pulling the DO runtime into a plain Node environment.
 */

/** The server-set header carrying the authenticated user id into the presence DO. The DO trusts only this. */
export const PRESENCE_USER_HEADER = "x-pithy-user-id";
