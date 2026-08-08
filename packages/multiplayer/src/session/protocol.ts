// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The wire contract between the multiplayer routes and the session Durable Object: the header the routes
 * set, and the sentinel an error crosses the RPC boundary behind. Two strings, and both sides need them.
 *
 * They live here rather than in `durableObject.ts` because that module imports `cloudflare:workers` and so
 * resolves in workerd and nowhere else. The routes are reached from `capability.ts`, which is reached from
 * the package entry point, which is what `pithy add multiplayer` writes into an adopter's `pithy.config.ts`
 * — a file every Node-side CLI command loads. Importing two constants out of the DO module put the entire
 * Durable Object chain on that path and broke `pithy upgrade` for any project composing multiplayer (#172).
 *
 * Kept free of every runtime-only import for that reason. Mirrors `@pithy-sh/matchmaking`'s
 * `presence/protocol.ts`, which splits its own presence header out for exactly the same reason.
 */

/** The header the authenticated Hono handler sets when forwarding a WebSocket upgrade to the DO. */
export const USER_HEADER = "x-pithy-user-id";

/**
 * Marks an Error whose message carries a JSON-encoded `ErrorPayload`. A `PithyError` thrown inside a DO does
 * not survive the RPC boundary — the runtime strips a custom Error subclass down to a bare Error, but a
 * plain Error's **message** is preserved. So `guard` encodes the payload into the message behind this
 * sentinel, and `callSession` in the routes decodes it back into a real `PithyError`.
 */
export const RPC_ERROR_PREFIX = "pithy-error:";
