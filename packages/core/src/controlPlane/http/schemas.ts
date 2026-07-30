import { z } from "zod";
import { Ed25519PublicJwk } from "../data/connection";

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
