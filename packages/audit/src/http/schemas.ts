// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { AuditAction, AuditActorType, AuditOutcome, AuditSeverity } from "@pithy-sh/core/src/audit/auditEvent";
import { ControlPlaneActorKind } from "@pithy-sh/core/src/controlPlane/data/connection";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { z } from "zod";

/**
 * The request contracts audit's routes declare (CLAUDE.md §HTTP).
 *
 * Every one of these is a **bound on something a caller chose**, which is the whole job here: a
 * control-plane credential is verified, but verified is not trusted, and a management client with a
 * bug can ask for a million rows off the largest table in the project as easily as a hostile one can.
 *
 * The free-text filters are bounded strings rather than enums, deliberately. `action` is a federated
 * taxonomy — every capability declares its own codes and core holds no closed union — so the valid
 * set is not knowable here, and the same is true of `resourceType`, `project`, and `worker`. Each is
 * only ever compared, never interpreted, so a filter naming something this deployment has never
 * recorded is an empty page rather than a 400. That is the better answer to the same question: a
 * dashboard filtering by a capability the adopter removed should show nothing, not fail.
 */

/** How long any single filter value may be. Generous for a name, far short of a payload. */
const MAX_FILTER_LENGTH = 256;

/** A bounded free-text filter value — compared against a column, never interpreted. */
const FilterValue = z.string().min(1).max(MAX_FILTER_LENGTH);

/**
 * The tenant filter, where **an empty value is the null filter**: `?tenant=acme` is one tenant's trail,
 * `?tenant=` is the events that belong to no tenant, and omitting it entirely filters nothing.
 *
 * Three states over a query string that natively has two, so the third needs an encoding. The empty
 * string is the one value that cannot collide: `FilterValue` is `min(1)`, so no tenant id is ever
 * empty, and no adopter can be locked out of filtering for a tenant whose id happens to be the sentinel
 * — which is what `?tenant=none` or `?tenant=null` would have risked. It is decoded here rather than in
 * the handler, so `AuditQuery`'s `string | null` is what reaches the query builder.
 */
const TenantFilter = z.union([FilterValue, z.literal("").transform(() => null)]);

/**
 * An inclusive time bound, as ISO-8601, decoded to a `Date` by the schema rather than by the handler.
 *
 * The conversion belongs here because a handler takes typed values: the route signature carries the
 * contract, so `from` reaches the query as the `Date` the filter wants and no handler ever parses a
 * caller's string.
 */
const TimeBound = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

/** One event's id in the path. */
export const AuditEventIdParam = z
  .object({
    eventId: z
      .string()
      .uuid()
      .describe(
        "The event's `eventId` — the recorder's UUID idempotency key, not the internal autoincrement `id`. A param schema constrains the string; the handler still does the lookup.",
      ),
  })
  .describe("The path parameters of the single-event route.");
export type AuditEventIdParam = z.infer<typeof AuditEventIdParam>;

/**
 * The trail query: what to filter by, and where to resume.
 *
 * Field names match {@link AuditQuery} exactly, so the validated object is the filter — there is no
 * hand-written mapping in the handler for a rename to fall out of sync with.
 */
export const ListAuditEventsQuery = z
  .object({
    actorType: AuditActorType.optional().describe(
      "Filter to one kind of principal. `control-plane` is the one that separates a management client's own actions from the adopter's users'.",
    ),
    actorId: FilterValue.optional().describe("Filter to one principal — a user id, a service name, a token subject."),
    actorKind: ControlPlaneActorKind.optional().describe(
      "Filter to one kind of client: `agent`, `dashboard` or `script`. `agent` finds a management agent's rows and every row a user's MCP client wrote, on both paths.",
    ),
    action: AuditAction.max(MAX_FILTER_LENGTH)
      .optional()
      .describe("Filter to one exact `domain/reason` action code. Exact, never a prefix — the taxonomy is federated."),
    outcome: AuditOutcome.optional().describe(
      "Filter to one outcome. `denied` is the one worth watching: a run of denials is what a credential being probed looks like.",
    ),
    severity: AuditSeverity.optional().describe("Filter to one severity."),
    resourceType: FilterValue.optional().describe("Filter to the kind of thing acted on (`user`, `secret`)."),
    resourceId: FilterValue.optional().describe("Filter to one target — everything that happened to this thing."),
    project: FilterValue.optional().describe("Filter to one project, as the recorder stamped it."),
    environment: FilterValue.optional().describe("Filter to one environment (`dev` | `staging` | `prod`)."),
    worker: FilterValue.optional().describe(
      "Filter to one `apps/<name>` Worker. Two Workers sharing a database share this table, so this is the only column that tells their events apart.",
    ),
    tenant: TenantFilter.optional().describe(
      "Filter to one tenant — whose actions these were, as the emitter recorded them. Send it empty (`?tenant=`) for the events that belong to no tenant: a CLI-originated action, a fleet-wide one, or a row recorded before the column existed. Omit it to filter nothing.",
    ),
    from: TimeBound.optional().describe("Inclusive lower bound on when the event occurred, ISO-8601."),
    to: TimeBound.optional().describe("Inclusive upper bound on when the event occurred, ISO-8601."),
    cursor: z
      .string()
      .max(512)
      .optional()
      .describe("Where to resume, from the previous page's `nextCursor`. Opaque; a malformed one is a first page."),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .optional()
      .describe("How many events to return. Bounded, because a verified client can still have a bug."),
  })
  .describe("The audit trail query: what to filter the trail by, and where to resume reading it.");
export type ListAuditEventsQuery = z.infer<typeof ListAuditEventsQuery>;

/**
 * The access-history query: over what window, and where to resume.
 *
 * `since` is required, so an unbounded replay of the whole trail is a 400 before any query runs; `until` defaults to
 * now in the handler, the one value a schema cannot compute for a request. A window that ends before it starts is
 * refused rather than answered with nothing, because nothing would read as nobody's access having changed.
 */
export const AccessHistoryQuery = z
  .object({
    since: TimeBound.describe("Inclusive lower bound on when a change happened, ISO-8601. Required."),
    until: TimeBound.optional().describe("Inclusive upper bound on when a change happened, ISO-8601. Defaults to now."),
    cursor: z
      .string()
      .max(512)
      .optional()
      .describe("Where to resume, from the previous page's `nextCursor`. Opaque; a malformed one is a first page."),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .optional()
      .describe("How many changes to return. Bounded, because a verified client can still have a bug."),
  })
  .refine((query) => query.until === undefined || query.until.getTime() >= query.since.getTime(), {
    message: "`until` must not be before `since`.",
    path: ["until"],
  })
  .describe("The access-history query: a window, oldest first, and where to resume reading it.");
export type AccessHistoryQuery = z.infer<typeof AccessHistoryQuery>;

/** A declared route pattern or a called path, as the reach answer names it. */
const RouteValue = z.string().min(1).max(512).startsWith("/");

/**
 * The reach query: whose calls to read, over what window, and whether to expand one route into its subjects.
 *
 * `connectionId` and `since` are required, so a missing one is a 400 before any query runs: an unbounded read over
 * every credential is not a question this route answers. `until` defaults to now in the handler, which is the one
 * value a schema cannot compute for a request. A window that ends before it starts is refused rather than answered
 * with nothing, because nothing would read as a credential that reached nothing. `subjects=true` needs a `route`:
 * the expansion is one route's subject list, never every route's.
 */
export const ControlPlaneReachQuery = z
  .object({
    connectionId: FilterValue.describe(
      "The control-plane connection whose reach to read — the `resourceId` its call rows carry. Required.",
    ),
    keyId: FilterValue.optional().describe(
      "Narrow to the calls one registered key signed. The leaked-key question: omit it for the whole connection.",
    ),
    since: TimeBound.describe("Inclusive lower bound on when a call landed, ISO-8601. Required."),
    until: TimeBound.optional().describe("Inclusive upper bound on when a call landed, ISO-8601. Defaults to now."),
    route: RouteValue.optional().describe(
      "Narrow to one route: a declared pattern such as `/admin/users/:userId`, or the called path of an unmatched row.",
    ),
    subjects: z
      .enum(["true", "false"])
      .optional()
      .describe(
        "`true` expands `route` into the paths it was called with and the subject ids they name. Needs `route`.",
      ),
  })
  .refine((query) => query.until === undefined || query.until.getTime() >= query.since.getTime(), {
    message: "`until` must not be before `since`.",
    path: ["until"],
  })
  .refine((query) => query.subjects !== "true" || query.route !== undefined, {
    message: "`subjects=true` needs a `route` to expand.",
    path: ["route"],
  })
  .describe("The control-plane reach query: one connection, over a window, optionally one key and one route.");
export type ControlPlaneReachQuery = z.infer<typeof ControlPlaneReachQuery>;

/**
 * The usage query: whose calls to count, and over what window.
 *
 * `connectionId` and `since` are required, so a missing one is a 400 before any query runs — an unbounded window over
 * every connection is not a question this route answers. `until` defaults to now in the handler, which is the one
 * value a schema cannot compute for a request. A window that ends before it starts is refused rather than answered
 * with nothing, because nothing would read as an idle connection.
 */
export const ControlPlaneUsageQuery = z
  .object({
    connectionId: FilterValue.describe(
      "The control-plane connection whose calls to count — the `resourceId` its call rows carry. Required.",
    ),
    since: TimeBound.describe("Inclusive lower bound on when a call landed, ISO-8601. Required."),
    until: TimeBound.optional().describe("Inclusive upper bound on when a call landed, ISO-8601. Defaults to now."),
  })
  .refine((query) => query.until === undefined || query.until.getTime() >= query.since.getTime(), {
    message: "`until` must not be before `since`.",
    path: ["until"],
  })
  .describe("The control-plane usage query: one connection, over a window.");
export type ControlPlaneUsageQuery = z.infer<typeof ControlPlaneUsageQuery>;

/**
 * The tenant whose chain to read. **Required**, because there is no "every chain": a chain is one tenant's.
 * Send it empty (`?tenant=`) for the untenanted chain — the same encoding the listing's filter uses.
 */
const ChainTenant = TenantFilter.describe(
  "The tenant whose chain to read. Send it empty (`?tenant=`) for the chain of events that belong to no tenant. Required: a chain is one tenant's.",
);

/** The chain verify query: whose chain, and over what window. */
export const ChainVerifyQuery = z
  .object({
    tenant: ChainTenant,
    since: TimeBound.optional().describe(
      "Inclusive start of the window, ISO-8601. Omitted, the walk starts at the chain's first event.",
    ),
    until: TimeBound.optional().describe(
      "Inclusive end of the window, ISO-8601. Omitted, the walk runs to the chain's head, and a checkpoint past it is a truncation.",
    ),
  })
  .refine((query) => query.until === undefined || query.since === undefined || query.until >= query.since, {
    message: "`until` must not be before `since`.",
    path: ["until"],
  })
  .describe("The chain verify query: one tenant's chain, over a window.");
export type ChainVerifyQuery = z.infer<typeof ChainVerifyQuery>;

/** The most events one export page carries. */
export const MAX_EXPORT_PAGE = 1000;

/** The chain export query: whose chain, over what window, and where to resume. */
export const ChainExportQuery = z
  .object({
    tenant: ChainTenant,
    since: TimeBound.optional().describe(
      "Inclusive start of the window, ISO-8601. Omitted, the export starts at the chain's first event.",
    ),
    until: TimeBound.optional().describe(
      "Inclusive end of the window, ISO-8601. Omitted, the export runs to the chain's head.",
    ),
    cursor: z
      .string()
      .max(32)
      .optional()
      .describe("Where to resume, from the previous page's `nextCursor`. A malformed one is a first page."),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_EXPORT_PAGE)
      .optional()
      .describe(`How many events one page carries. At most ${MAX_EXPORT_PAGE}; defaults to 500.`),
  })
  .refine((query) => query.until === undefined || query.since === undefined || query.until >= query.since, {
    message: "`until` must not be before `since`.",
    path: ["until"],
  })
  .describe("The chain export query: one tenant's chain, over a window, a page at a time.");
export type ChainExportQuery = z.infer<typeof ChainExportQuery>;
