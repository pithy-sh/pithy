// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The control-plane connections table: which management client may call this Worker's admin routes,
 * from where, with which keys, for which operations.
 *
 * This is the inbound seam — the hosted dashboard calling *into* the adopter's Worker. It is not
 * Cloudflare's control plane, which is the outbound provisioning REST API and shares nothing with
 * this table.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them to `pithy_controlplane_connections` in the
 * DDL. `down` drops the index before its table, and is tested.
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
 */
export const controlplane_0001_connections: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyControlplaneConnections")
      // The connection id is the token `aud`, and therefore externally exposed. Text, never a sequence.
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("environment", "text", (c) => c.notNull())
      .addColumn("issuer", "text", (c) => c.notNull())
      .addColumn("workerUrl", "text", (c) => c.notNull())
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
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyControlplaneConnectionsEnvironmentIdx").execute();
    await db.schema.dropTable("pithyControlplaneConnections").execute();
  },
};
