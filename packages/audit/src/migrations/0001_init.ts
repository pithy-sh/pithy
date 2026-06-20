import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Create the `pithy_audit_events` table in the configured audit database (the `DB` binding by
 * default). The `pithy_audit_` prefix keeps it from clashing with an adopter's own tables.
 *
 * Identifiers are declared in **camelCase**: the runner installs `CamelCasePlugin`, which snake-cases
 * every identifier in the emitted DDL (CLAUDE.md §Data layer). `pithyAuditEvents` becomes the SQL
 * table `pithy_audit_events`; the column names match the Zod schema.
 *
 * The indexes serve the query shapes the trail is read by — time range (`occurredAt`), per-action
 * (`action`), per-actor (`actorType`, `actorId`), and per-resource (`resourceType`, `resourceId`).
 * `down` is the tested inverse: drop the indexes, then the table (D1 has no transactional DDL).
 */
export const audit_0001_init: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyAuditEvents")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("eventId", "text", (c) => c.notNull())
      .addColumn("occurredAt", "integer", (c) => c.notNull())
      .addColumn("action", "text", (c) => c.notNull())
      .addColumn("outcome", "text", (c) => c.notNull())
      .addColumn("severity", "text", (c) => c.notNull().defaultTo("info"))
      .addColumn("actorType", "text", (c) => c.notNull())
      .addColumn("actorId", "text")
      .addColumn("sessionId", "text")
      .addColumn("resourceType", "text")
      .addColumn("resourceId", "text")
      .addColumn("ip", "text")
      .addColumn("userAgent", "text")
      .addColumn("requestId", "text")
      .addColumn("metadata", "text")
      .execute();

    // Unique on eventId — the recorder's idempotency key. A retried write reuses the same eventId, so
    // this index turns a post-commit retry into a UNIQUE violation the retry wrapper treats as "already
    // landed" rather than a duplicate row.
    await db.schema
      .createIndex("pithyAuditEventsEventIdIdx")
      .on("pithyAuditEvents")
      .column("eventId")
      .unique()
      .execute();
    await db.schema.createIndex("pithyAuditEventsOccurredAtIdx").on("pithyAuditEvents").column("occurredAt").execute();
    await db.schema.createIndex("pithyAuditEventsActionIdx").on("pithyAuditEvents").column("action").execute();
    await db.schema
      .createIndex("pithyAuditEventsActorIdx")
      .on("pithyAuditEvents")
      .columns(["actorType", "actorId"])
      .execute();
    await db.schema
      .createIndex("pithyAuditEventsResourceIdx")
      .on("pithyAuditEvents")
      .columns(["resourceType", "resourceId"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyAuditEventsResourceIdx").execute();
    await db.schema.dropIndex("pithyAuditEventsActorIdx").execute();
    await db.schema.dropIndex("pithyAuditEventsActionIdx").execute();
    await db.schema.dropIndex("pithyAuditEventsOccurredAtIdx").execute();
    await db.schema.dropIndex("pithyAuditEventsEventIdIdx").execute();
    await db.schema.dropTable("pithyAuditEvents").execute();
  },
};
