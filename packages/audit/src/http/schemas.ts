// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { AuditAction, AuditActorType, AuditOutcome, AuditSeverity } from "@pithy-sh/core/src/audit/auditEvent";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { z } from "zod";

/**
 * The request contracts audit's two routes declare (CLAUDE.md §HTTP).
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
