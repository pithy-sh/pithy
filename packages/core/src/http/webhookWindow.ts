// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The freshness window a signed webhook is checked against: the default, and the widest one accepted.
 *
 * **Two numbers in a module of their own, because of who has to read them.** They are the bounds a
 * config schema states in its own `.describe()` — `packages/payments/src/config/config.ts` interpolates
 * the maximum into the sentence an adopter reads — and a config schema is one half of a route contract,
 * which a management client validates **in a browser**. `signedWebhook.ts` is a Hono middleware and
 * reaches the whole Worker graph from `PithyHonoEnv` down; importing a number from it dragged `hono`,
 * `kysely`, `kysely-d1` and `@cloudflare/workers-types` into `payments/src/http/schemas.ts`,
 * `payments/src/http/responses.ts` and every module that reaches payments' config (#521).
 *
 * `tooling/browser-scopes` is the gate that caught it, and it is the gate that keeps this file a leaf:
 * **nothing here may import anything.** A constant a browser-facing schema quotes belongs beside the
 * other constants a browser may see, not inside the verifier that enforces it.
 */

/** How far a delivery's own timestamp may be from now. Stripe's default, and generous against clock skew. */
export const SIGNED_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * The widest freshness window the verifier accepts, and it refuses above rather than clamping.
 *
 * A tolerance is a replay window in the plainest possible units: every second of it is a second longer a
 * captured delivery keeps working. The five minutes above is Stripe's own and covers clock drift plus ordinary
 * delivery latency; an hour is the far end of a sender that queues a delivery and re-sends it without re-dating
 * it. Past that a number has stopped covering latency and started covering a capture.
 *
 * Refused rather than clamped because an `86400` is a typo or a misunderstanding either way — clamped, the
 * endpoint keeps working and nobody reads the line again; refused, the first delivery says which knob is wrong
 * and it is a two-character fix.
 */
export const SIGNED_WEBHOOK_MAX_TOLERANCE_SECONDS = 3600;
