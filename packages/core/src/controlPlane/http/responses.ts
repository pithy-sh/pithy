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

/**
 * One migration as `GET {basePath}/migrations` reports it: its composed name, and whose it is.
 *
 * The namespace is a capability's name, which the manifest already reports in `capabilities[]`. So a
 * client tells an adopter's own migrations from a composed capability's by comparing the two — no
 * convention, and no list kept anywhere.
 */
export const MigrationView = z
  .object({
    name: z.string().describe("The composed migration name, exactly as the ledger records it: `0250_audit_0001_init`."),
    namespace: z
      .string()
      .nullable()
      .describe(
        "The capability this migration belongs to — its name, as `capabilities[]` in the manifest reports it. Null only for an undeclared migration whose name no Pithy registry could have composed.",
      ),
  })
  .describe("One migration, and the capability namespace it belongs to.");
export type MigrationView = z.output<typeof MigrationView>;

/** Whether the last group is still reversible by name, or what is in its way. */
export const MigrationGroupPositionView = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z
          .literal("top")
          .describe(
            "The group's migrations are the contiguous tip of this database's chain. Not a promise that `pithy migrate --rollback --group <value>` runs: the CLI also refuses an undeclared migration in the ledger, and keeps back or refuses a database another environment binds.",
          ),
      })
      .describe("A group nothing on this database's ledger sits over."),
    z
      .object({
        state: z
          .literal("buried")
          .describe("Something sits over the group or inside it, so reversing it by name is refused."),
        above: z.array(z.string()).describe("The groups in the way, newest first."),
        ungrouped: z
          .array(MigrationView)
          .describe(
            "The migrations in the way that no group claims, newest first. Nothing can be reversed by group while one of them is at the tip.",
          ),
      })
      .describe("A group with something in its way, and what that is."),
  ])
  .describe("Where the last group sits in this database's chain: the top, or buried under named things.");
export type MigrationGroupPositionView = z.output<typeof MigrationGroupPositionView>;

/** The run that last moved a database, and whether it can still be taken back. */
export const MigrationGroupView = z
  .object({
    group: z
      .string()
      .describe("The group's value: the `--group` the run was given, or the ISO-8601 timestamp it generated."),
    appliedAt: z.iso.datetime().describe("When this group last applied something here, ISO-8601."),
    migrations: z
      .array(MigrationView)
      .describe("What this group applied in this database and is still applied, in application order."),
    position: MigrationGroupPositionView.describe("Whether the group is the top of the chain, or what is in its way."),
  })
  .describe("The newest group with anything still applied in this database.");
export type MigrationGroupView = z.output<typeof MigrationGroupView>;

/**
 * One database this Worker binds, read or not.
 *
 * **An unreadable database carries no list at all**, never empty ones. `pending: []` reads as up to date,
 * and a database nobody read is not that. The state is on the value, so a client reaches a list only by
 * narrowing.
 */
export const MigrationDatabaseView = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("readable").describe("This database's ledger was read."),
        database: z.string().describe("The database name, as capabilities declare it in `databases`."),
        binding: z.string().describe("The D1 binding it is read through, as `wrangler.jsonc` declares it."),
        applied: z.array(MigrationView).describe("Every applied migration, in the order the ledger applied them."),
        pending: z
          .array(MigrationView)
          .describe("Declared by this build and not applied here, in the order they would run."),
        undeclared: z
          .array(MigrationView)
          .describe(
            "Applied here and not declared by this Worker, sorted. Relative to this Worker: a database shared with another Worker lists that Worker's migrations here. Otherwise Kysely reads one as a corrupted chain and applies nothing.",
          ),
        lastGroup: MigrationGroupView.nullable().describe(
          "The newest group with anything applied here, or null when nothing applied here was ever grouped.",
        ),
      })
      .describe("A database whose ledger was read."),
    z
      .object({
        state: z.literal("unreadable").describe("This database's ledger could not be read on this call."),
        database: z.string().describe("The database name, as capabilities declare it in `databases`."),
        binding: z.string().describe("The D1 binding it would be read through."),
      })
      .describe(
        "A database that could not be read. No lists, so nothing about it reads as zero. The other databases still answer.",
      ),
  ])
  .describe("One database this Worker binds: its migration state, or the fact that it could not be read.");
export type MigrationDatabaseView = z.output<typeof MigrationDatabaseView>;

/**
 * `GET /control-plane/migrations` — where every database this Worker binds stands.
 *
 * Asked of the Worker because the Worker *is* the deployed build. `pithy doctor` reads the project on disk,
 * which is what the operator has and not necessarily what is deployed.
 */
export const ControlPlaneMigrationsResponse = z
  .object({
    environment: z.string().describe("The environment this Worker answers for."),
    databases: z
      .array(MigrationDatabaseView)
      .describe("One entry per database this Worker binds, sorted by database name. One unreadable costs only itself."),
  })
  .describe("What is applied, pending and undeclared in each bound database, and which run put it there.");
export type ControlPlaneMigrationsResponse = z.output<typeof ControlPlaneMigrationsResponse>;
