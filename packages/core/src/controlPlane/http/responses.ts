// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { Ed25519PublicJwk } from "../data/connection";

/**
 * What the seam's own routes return, as Zod objects a management client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values for the same reason: a management client reading a customer's Worker is crossing a
 * trust boundary and must validate what comes back, and a TypeScript interface is erased before it
 * can help. `GET /control-plane/manifest` already had a schema — {@link ControlPlaneManifest}, in
 * `discovery/adminRoute.ts`, because it is the discovery contract rather than a projection — and the
 * other four routes had none at all, `publicKeyView` returning a bare `Record<string, unknown>`.
 *
 * **No codecs, and no transform anywhere in this file.** These describe JSON on the wire, so parsing
 * one hands back exactly what went in — which is what lets a test compare the parsed value with a live
 * response and fail on a field either side forgot. A `JsonDate` here would decode an ISO string into a
 * `Date` and make that comparison meaningless.
 *
 * **Nothing here can carry a private key, because none is ever held.** The connection stores public
 * halves only, so `keys` is exactly what a client needs to see a key ageing and exactly what an
 * attacker learns nothing from.
 */

/** One registered key as a client sees it: the public half and its window. */
export const PublicKeyView = z
  .object({
    keyId: z.string().describe("The key's id, matched against a token's `kid` header."),
    publicKey: Ed25519PublicJwk.describe("The public key this id names. The private half is never held here."),
    validFrom: z.iso.datetime().describe("When this key became valid, ISO-8601. A call signed before it is rejected."),
    validUntil: z.iso
      .datetime()
      .nullable()
      .describe("When it stops being accepted, ISO-8601, or null while open-ended. Set only by the expire route."),
    revokedAt: z.iso
      .datetime()
      .nullable()
      .describe("When it was revoked outright, ISO-8601, or null. Revocation ignores the window and is immediate."),
  })
  .describe("One registered public key and its validity window. Two live at once during a rotation overlap.");
export type PublicKeyView = z.output<typeof PublicKeyView>;

/**
 * `GET /control-plane/ping`.
 *
 * It echoes the `keyId` that verified the call, so a client rotating a key can confirm *which* key
 * answered rather than inferring it from a 200 — which is the whole point of the route.
 */
export const ControlPlanePingResponse = z
  .object({
    status: z.literal("ok").describe("Always `ok`. A failure is an error payload, never this shape."),
    connectionId: z.string().describe("The connection this call authenticated as."),
    environment: z.string().describe("The environment that connection is bound to."),
    keyId: z.string().describe("The key that verified this call. The proof a newly registered key works."),
    now: z.iso.datetime().describe("This Worker's clock, ISO-8601 — what a token's lifetime is judged against."),
  })
  .describe("Connectivity, and proof of which key answered.");
export type ControlPlanePingResponse = z.output<typeof ControlPlanePingResponse>;

/** `GET /control-plane/keys` — the registration state, so a client can surface a stale key. */
export const ControlPlaneKeysResponse = z
  .object({
    connectionId: z.string().describe("The connection these keys belong to."),
    environment: z.string().describe("The environment that connection is bound to."),
    keys: z.array(PublicKeyView).describe("Every registered key, expired and revoked ones included."),
  })
  .describe("Every key registered against this connection, with its window.");
export type ControlPlaneKeysResponse = z.output<typeof ControlPlaneKeysResponse>;

/** `POST /control-plane/keys` — the appended key, and the set as it now stands. */
export const RegisterKeyResponse = z
  .object({
    keyId: z.string().describe("The key just registered."),
    validFrom: z.iso.datetime().describe("When its window opened, ISO-8601 — now, by construction."),
    keys: z
      .array(PublicKeyView)
      .describe("The connection's keys after the append and the prune, so a client sees what it now holds."),
  })
  .describe("The registered key, and the set it joined.");
export type RegisterKeyResponse = z.output<typeof RegisterKeyResponse>;

/** `POST /control-plane/keys/:keyId/expire` — the retired key, and the set as it now stands. */
export const ExpireKeyResponse = z
  .object({
    keyId: z.string().describe("The key just given an end date."),
    validUntil: z.iso.datetime().describe("When its window closed, ISO-8601 — now, by construction."),
    keys: z.array(PublicKeyView).describe("The connection's keys after the expiry."),
  })
  .describe("The expired key, and the set it left behind.");
export type ExpireKeyResponse = z.output<typeof ExpireKeyResponse>;
