import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { z } from "zod";
import type { AuditDatabase } from "./data/tables";
import { auditTables } from "./data/tables";
import { audit_0001_init } from "./migrations/0001_init";
import { recordAuditEvent } from "./recorder";

/**
 * Sort order of the audit migration within the audit database, relative to other capabilities
 * (core low, app high). Unique per database; the migration registry composes the key
 * `0250_audit_0001_init`.
 */
export const AUDIT_MIGRATION_ORDER = 250;

/**
 * The registry name the audit table joins. The store of record is D1, shared with the primary app
 * database (`app`, the `DB` binding) by default — so the audit migration tracks alongside the app's
 * in one `kysely_migration` table rather than fighting it on a second provider over the same binding.
 * The physical binding is config-selectable; this registry key is the coordination point capabilities
 * use to share one database (CLAUDE.md §Data layer; isolating audit into its own D1 is a later issue).
 */
const AUDIT_DATABASE_NAME = "app" as const;

/**
 * Configuration for the audit capability, passed in `pithy.config.ts`. `database` names the D1
 * **binding** the audit table lives in and writes go to, defaulting to `DB` (the shared app
 * database). KV is deliberately not an option: an audit log is a query workload (by actor, action,
 * time range, resource, outcome) and KV is get-by-key only.
 */
export const AuditConfig = z
  .object({
    database: z
      .string()
      .default("DB")
      .describe("The D1 binding the audit table and its migrations target. Defaults to `DB`, the shared app database."),
  })
  .describe("Configuration for the audit capability.");
export type AuditConfig = z.output<typeof AuditConfig>;
export type AuditConfigInput = z.input<typeof AuditConfig>;

/** The audit capability, with its resolved binding attached for discovery. */
export interface AuditCapability extends Capability {
  /** The D1 binding the audit table lives in (the resolved `database` config). */
  auditDatabase: string;
}

/**
 * The audit capability. It contributes the `pithy_audit_events` table to the configured D1 binding
 * (default `DB`) and installs the request-context `emit()` recorder via middleware — replacing core's
 * no-op with a synchronous, non-fatal D1 writer. Any capability then records a security-relevant
 * action with `c.var.emit(...)` without importing this package (principle 4).
 */
export function audit(config: AuditConfigInput = {}): AuditCapability {
  const resolved = AuditConfig.parse(config);
  const capability = defineCapability({
    name: "audit",
    config: AuditConfig,
    requiredBindings: [{ type: "d1", name: resolved.database }],
    databases: {
      [AUDIT_DATABASE_NAME]: {
        binding: resolved.database,
        tables: auditTables,
        migrationOrder: AUDIT_MIGRATION_ORDER,
        migrations: { "0001_init": audit_0001_init },
      },
    },
    // Replace the no-op `emit` seam with a recorder over this request's audit database. The database
    // is resolved lazily inside the closure — only when a route actually emits — so a request that
    // never audits never triggers the lazy Kysely build. Runs after createBackend's default-setter
    // (which seeds `db` and the no-op `emit`), so `c.var.db` is ready by the time emit is called.
    middleware: [
      (app) => {
        app.use("*", async (c, next) => {
          c.set("emit", (event) =>
            recordAuditEvent(
              (c.var.db as Record<typeof AUDIT_DATABASE_NAME, AuditDatabase>)[AUDIT_DATABASE_NAME],
              event,
            ),
          );
          await next();
        });
      },
    ],
  });
  return Object.assign(capability, { auditDatabase: resolved.database });
}

/** Whether a capability is the audit capability — carries its resolved binding. */
export function isAuditCapability(capability: Capability): capability is AuditCapability {
  return capability.name === "audit" && "auditDatabase" in capability;
}
