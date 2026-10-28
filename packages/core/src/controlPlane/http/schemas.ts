// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { Ed25519PublicJwk } from "../data/connection";
import { HoldState, HoldSubjectType } from "../data/hold";

/**
 * The request contract for the seam's own routes. Every input surface is validated here and read in a
 * handler through `c.req.valid(target)` — a handler never parses input (CLAUDE.md §HTTP).
 *
 * These are the highest-risk routes in the product, so two of the choices below are deliberate and
 * would be wrong to "tighten" later:
 *
 * **`keyId` is a bounded string, not a `z.uuid()`.** A key id is opaque and minted by the management
 * client, so its format is not ours to constrain. More importantly, an unknown-but-well-formed key id
 * must reach the handler and answer `controlplane/key_not_found` rather than bouncing off a 400 — a
 * validator that rejected unfamiliar shapes would turn the route into an enumeration oracle telling a
 * caller which ids exist.
 *
 * **Nothing here validates a scope or a connection id.** Those arrive in the signed token, not the
 * request, and are verified against the adopter's own row before a handler runs. A body that could
 * name its own scope would be a body that could grant itself one.
 */

/** `POST /control-plane/keys` — register a new public key, signed by the key it succeeds. */
export const RegisterKeyRequest = z
  .object({
    keyId: z
      .string()
      .min(1)
      .max(64)
      .describe("The new key's id, which a later token names in its `kid` header. Must not already be registered."),
    publicKey: Ed25519PublicJwk.describe(
      "The Ed25519 public key to trust. Only the public half ever crosses the wire — the management client keeps the private key and the adopter never holds anything worth stealing.",
    ),
  })
  .describe(
    "A request to append one public key to this connection. Appends only: it never touches an existing key's validity, which is what makes a failed rotation harmless.",
  );
export type RegisterKeyRequest = z.infer<typeof RegisterKeyRequest>;

/** `POST /control-plane/keys/:keyId/expire` — the path segment naming the key to retire. */
export const ExpireKeyParams = z
  .object({
    keyId: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "The key to give an end date. Bounded but unconstrained in shape — an unknown id answers 404, not 400.",
      ),
  })
  .describe("The path parameters of the key-expiry route.");
export type ExpireKeyParams = z.infer<typeof ExpireKeyParams>;

/** `POST /control-plane/keys/:keyId/expire` — the body, carrying the proof that a successor works. */
export const ExpireKeyRequest = z
  .object({
    provenKeyId: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "The replacement key that has already been proven against a live `ping`. Required, and checked to be currently active: expiring a key without naming a working successor is the one failure mode with no recovery path, so the route refuses rather than trusting the caller to have checked.",
      ),
  })
  .describe(
    "A request to expire one superseded key. The successor must be named and must already be live — append, verify, then expire, never replace.",
  );
export type ExpireKeyRequest = z.infer<typeof ExpireKeyRequest>;

/** `GET /control-plane/erasure/:subjectType/:subjectId` — which subject. */
export const ErasureSubjectParams = z
  .object({
    subjectType: z.enum(["user", "organization"]).describe("The kind of subject: `user` or `organization`."),
    subjectId: z.string().min(1).max(255).describe("The subject's id."),
  })
  .describe("The subject whose erasure to attest.");
export type ErasureSubjectParams = z.infer<typeof ErasureSubjectParams>;

/** `GET /control-plane/erasure?since&until` — the period. */
export const ErasurePeriodQuery = z
  .object({
    since: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("The window's inclusive start, ISO-8601. Defaults to 90 days before `until`."),
    until: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("The window's inclusive end, ISO-8601. Defaults to now."),
  })
  .describe("The period to attest: at most 366 days.");
export type ErasurePeriodQuery = z.infer<typeof ErasurePeriodQuery>;

/**
 * Place a legal hold. The subject and a reason, and nothing else: no field shortens a retention, because a hold
 * can only preserve.
 */
export const PlaceHoldRequest = z
  .object({
    subjectType: HoldSubjectType,
    subjectId: z
      .string()
      .min(1)
      .max(255)
      .nullable()
      .describe(
        "The user's or organization's id, or the tenant whose audit trail to hold. Null only for `audit`, which then holds the untenanted trail.",
      ),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "Why the hold is placed, in one or two sentences. Required, and recorded with the hold and its audit event.",
      ),
  })
  .strict()
  .refine((body) => body.subjectId !== null || body.subjectType === "audit", {
    message: "Only an audit hold may name no subject: a user or organization hold names its id.",
    path: ["subjectId"],
  })
  .describe("A legal hold to place: the subject, and why.");
export type PlaceHoldRequest = z.infer<typeof PlaceHoldRequest>;

/** The path parameter of the release route. */
export const HoldParams = z
  .object({ holdId: z.string().min(1).max(64).describe("The hold's id, as placing it returned.") })
  .describe("The hold to release.");
export type HoldParams = z.infer<typeof HoldParams>;

/** Release a legal hold, with a reason. */
export const ReleaseHoldRequest = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("Why the hold is released. Required, and recorded with the release and its audit event."),
  })
  .strict()
  .describe("A legal hold's release: why it ends.");
export type ReleaseHoldRequest = z.infer<typeof ReleaseHoldRequest>;

/** Which holds to list. */
export const HoldListQuery = z
  .object({
    state: HoldState.optional().describe("Only holds in this state. Absent lists both, standing first."),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("How many holds to list, at most 500. Defaults to 100."),
  })
  .describe("Which legal holds to list.");
export type HoldListQuery = z.infer<typeof HoldListQuery>;

/** Which connections to list. */
export const ConnectionListQuery = z
  .object({
    principal: z
      .email()
      .max(254)
      .optional()
      .describe(
        "Only connections this email authorized, compared without regard to case. Connections with no recorded principal are listed apart either way and never match.",
      ),
  })
  .describe("Which connections to list.");
export type ConnectionListQuery = z.infer<typeof ConnectionListQuery>;

/** The path parameter of the revoke route. */
export const ConnectionParams = z
  .object({ connectionId: z.uuid().describe("The connection's id, as the listing reports it.") })
  .describe("The connection to revoke.");
export type ConnectionParams = z.infer<typeof ConnectionParams>;

/** Revoke a connection, with a reason. */
export const RevokeConnectionRequest = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("Why the connection is revoked. Required, and recorded on the revocation's audit event."),
  })
  .strict()
  .describe("A connection's revocation: why it ends.");
export type RevokeConnectionRequest = z.infer<typeof RevokeConnectionRequest>;
