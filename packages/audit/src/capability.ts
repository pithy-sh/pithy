// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { workerIdentity } from "@pithy-sh/core/src/worker/identity";
import { z } from "zod";
import type { AuditDatabase } from "./data/tables";
import { auditTables } from "./data/tables";
import { auditAdminRoutes } from "./http/guards";
import { registerAuditRoutes } from "./http/routes";
import { audit_0001_init } from "./migrations/0001_init";
import { audit_0002_tenant } from "./migrations/0002_tenant";
import { recordAuditEvent } from "./recorder";
import { auditExampleSeed } from "./seeds/example";
import { PACKAGE_VERSION } from "./version.generated";

/**
 * Sort order of the audit migration within the audit database, relative to other capabilities
 * (core low, app high). Unique per database; the migration registry composes the key
 * `0250_audit_0001_init`.
 */
export const AUDIT_MIGRATION_ORDER = 250;

/**
 * The registry name the audit table joins. The store of record is D1, shared with the primary app
 * database (`app`, the `DB` binding) by default — so the audit migration tracks alongside the app's
 * in one `pithy_migrations` table rather than fighting it on a second provider over the same binding.
 * The physical binding is config-selectable; this registry key is the coordination point capabilities
 * use to share one database (CLAUDE.md §Data layer; isolating audit into its own D1 is a later issue).
 */
const AUDIT_DATABASE_NAME = "app" as const;

/**
 * Configuration for the audit capability, passed in `pithy.config.ts`. `database` names the D1
 * **binding** the audit table lives in and writes go to, defaulting to `DB` (the shared app
 * database). KV is deliberately not an option: an audit log is a query workload (by actor, action,
 * time range, resource, outcome) and KV is get-by-key only.
 *
 * `basePath` is where the read-only control-plane routes mount. It is config rather than a constant
 * for the reason every capability's is: an adopter may already own `/audit`, and the admin manifest
 * reports whatever they chose, so a management client follows the move without either side
 * coordinating.
 */
export const AuditConfig = z
  .object({
    database: z
      .string()
      .default("DB")
      .describe("The D1 binding the audit table and its migrations target. Defaults to `DB`, the shared app database."),
    basePath: z
      .string()
      .startsWith("/")
      .default("/audit")
      .describe(
        "Where the control-plane routes that read the trail mount. Reads only — the trail is append-only and this surface never writes.",
      ),
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
    // The package version this capability ships at, stamped by `scripts/stampVersions.ts` — a Worker
    // cannot read its own package.json. Reported per capability by the control-plane manifest.
    version: PACKAGE_VERSION,
    config: AuditConfig,
    requiredBindings: [{ type: "d1", name: resolved.database }],
    databases: {
      [AUDIT_DATABASE_NAME]: {
        binding: resolved.database,
        tables: auditTables,
        migrationOrder: AUDIT_MIGRATION_ORDER,
        migrations: { "0001_init": audit_0001_init, "0002_tenant": audit_0002_tenant },
      },
    },
    seeds: [auditExampleSeed],
    // Built from the resolved `basePath`, never the default: an adopter who mounts this at `/trail`
    // gets a manifest naming their paths, where a client assuming the default would 404.
    adminRoutes: auditAdminRoutes(resolved.basePath),
    // The registry key is this package's own detail, so the routes are handed a resolver rather than
    // being made to know it — the same reason the middleware below resolves lazily.
    routes: registerAuditRoutes({
      basePath: resolved.basePath,
      database: (c) => (c.var.db as Record<typeof AUDIT_DATABASE_NAME, AuditDatabase>)[AUDIT_DATABASE_NAME],
    }),
    // Replace the no-op `emit` seam with a recorder over this request's audit database. The database
    // is resolved lazily inside the closure — only when a route actually emits — so a request that
    // never audits never triggers the lazy Kysely build. Runs after createBackend's default-setter
    // (which seeds `db`, `log`, and the no-op `emit`), so `c.var.db` and `c.var.log` are ready by the
    // time emit is called. A non-fatal write failure routes through the logger seam — replacing the
    // former `console.error` stopgap — as a namespaced `audit/*` record on the `audit` sub-logger.
    middleware: [
      (app) => {
        app.use("*", async (c, next) => {
          // Origin is read from `c.env` here and handed to the recorder, so no emitter supplies it and
          // none can override it. Read per request rather than once at capability construction: the
          // capability object is built before any request exists, and `env` is only reachable from a
          // context. `workerIdentity` never throws and returns nulls for whatever is unstamped, so a
          // Worker predating these vars still records its events — just without an origin.
          c.set("emit", (event) =>
            recordAuditEvent(
              (c.var.db as Record<typeof AUDIT_DATABASE_NAME, AuditDatabase>)[AUDIT_DATABASE_NAME],
              event,
              {
                origin: workerIdentity(c.env),
                onError: (error) => c.var.log.child("audit").error("audit event dropped", { error }),
              },
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
