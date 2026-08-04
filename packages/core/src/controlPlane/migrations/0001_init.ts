// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The control-plane seam's tables: which management client may call this Worker, and which of its tokens
 * have already been spent.
 *
 * This is the inbound seam — the hosted dashboard calling *into* the adopter's Worker. It is not
 * Cloudflare's control plane, which is the outbound provisioning REST API and shares nothing with these
 * tables.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them to `pithy_controlplane_*` in the DDL. `down`
 * drops each index before its table, and is tested.
 *
 * ## `pithy_controlplane_connections`
 *
 * Two shapes are deliberate.
 *
 * `id` is text, not an autoincrementing integer. It is the token's `aud`, so it leaves the Worker on
 * every call; a sequential id would tell a caller how many connections exist and let them guess the
 * next one.
 *
 * `scopes` and `keys` are JSON columns rather than child tables. Keys especially: a rotation is then
 * one `UPDATE` that cannot half-apply, and verification is one primary-key read with no join on a
 * Worker hot path. SQLite cannot `CHECK` inside a JSON string, so the Zod schemas on
 * `ControlPlaneConnection` are the only gate on their contents — `NOT NULL` here is the most the
 * database itself can say.
 *
 * `basePath` records where the seam is mounted on the Worker this connection addresses. It is stored
 * beside `workerUrl` because the two together fully determine the manifest address — and it is the one
 * part a client cannot discover, since it *is* the manifest's own address. Everything else already
 * solves this: `AdminRoute.path` carries the fully mounted path, so no client hardcodes a capability's
 * mount point. Without it a client must assume `/control-plane`, and an adopter who moved the mount
 * registers cleanly, passes the `ping` — called at that same assumed path — and then 404s on every call,
 * with the operator diagnosing the wrong problem.
 *
 * ## `pithy_controlplane_replays`
 *
 * **`jti` is the primary key, and that is the entire replay mechanism.** The claim is
 * `INSERT … ON CONFLICT DO NOTHING RETURNING`, so SQLite's uniqueness decides which of N concurrent
 * presentations wins — no read-then-write, no window between checking and recording. The KV guard this
 * replaced could not offer that: KV has no compare-and-set, so two colocations could both see a miss.
 *
 * The key is `jti` alone, deliberately, and **not** `(jti, connectionId)`. A composite would let a token
 * captured from one connection be spent again against another, which is the property the guard exists to
 * deny; `connectionId` is carried as a plain column, for the incident rather than the decision.
 *
 * `expiresAt` exists so the table can be pruned. A replay table that only grows is a slow leak in every
 * adopter's database — the one thing KV gave for nothing, since its entries expired themselves. Its index
 * is what makes the prune a range scan rather than a full table scan on an administrator-paced write path.
 */
export const controlplane_0001_init: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyControlplaneConnections")
      // The connection id is the token `aud`, and therefore externally exposed. Text, never a sequence.
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("environment", "text", (c) => c.notNull())
      .addColumn("issuer", "text", (c) => c.notNull())
      .addColumn("workerUrl", "text", (c) => c.notNull())
      // Defaulted as well as `NOT NULL`: unlike an origin, there is no such thing as a connection with no
      // base path — the seam is mounted somewhere, or the connection cannot be called at all.
      .addColumn("basePath", "text", (c) => c.notNull().defaultTo("/control-plane"))
      .addColumn("scopes", "text", (c) => c.notNull())
      .addColumn("keys", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .execute();

    // Verification loads by id, which is already the primary key. This index is for the other reader:
    // the CLI and the key-listing route ask "what is connected to this environment", and there is no
    // useful answer without a scan otherwise.
    await db.schema
      .createIndex("pithyControlplaneConnectionsEnvironmentIdx")
      .on("pithyControlplaneConnections")
      .columns(["environment"])
      .execute();

    await db.schema
      .createTable("pithyControlplaneReplays")
      // The token id, and the race decider. Caller-supplied, so it is bounded by the Zod schema before
      // it ever reaches here.
      .addColumn("jti", "text", (c) => c.primaryKey())
      .addColumn("connectionId", "text", (c) => c.notNull())
      .addColumn("expiresAt", "integer", (c) => c.notNull())
      .execute();

    // The prune's only predicate. Without it, reclaiming expired rows scans every spent token the
    // adopter has ever recorded.
    await db.schema
      .createIndex("pithyControlplaneReplaysExpiresAtIdx")
      .on("pithyControlplaneReplays")
      .columns(["expiresAt"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyControlplaneReplaysExpiresAtIdx").execute();
    await db.schema.dropTable("pithyControlplaneReplays").execute();
    await db.schema.dropIndex("pithyControlplaneConnectionsEnvironmentIdx").execute();
    await db.schema.dropTable("pithyControlplaneConnections").execute();
  },
};
