// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * How a route verifies the caller's identity/authenticity. Every route declares one —
 * there is no implicit auth. `@pithy-sh/auth` implements `bearer`/`session`; others map to
 * their own checks. (Turnstile is a humanity check applied as middleware, not an identity
 * strategy, so it is deliberately not listed here.)
 */
export const VerificationStrategy = z
  .union([
    z.literal("bearer").describe("Short-lived access token via Authorization: Bearer; validated by @pithy-sh/auth."),
    z.literal("session").describe("Cookie-based web session, CSRF-protected; validated by @pithy-sh/auth."),
    z
      .literal("signed-webhook")
      .describe(
        "Inbound webhook, authenticated by the sender's own proof over the exact received bytes — one name over several mechanisms (an HMAC, a signed JWS chain, an OIDC token), because the sender chooses it. `requireSignedWebhook` (./signedWebhook) implements the timestamped-HMAC form; a rail whose sender proves it differently implements its own.",
      ),
    z.literal("control-plane").describe("M2M admin via a customer-issued scoped credential; default-denied."),
    z.literal("public").describe("No authentication — the route is open. Must be a deliberate choice."),
  ])
  .describe("How a route verifies the caller's identity/authenticity. There is no implicit auth.");
export type VerificationStrategy = z.infer<typeof VerificationStrategy>;
