// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import type { Context, Hono } from "hono";
import { accessHistory } from "../accessHistory";
import { AuditTrailActions } from "../actions";
import type { AuditDatabase } from "../data/tables";
import { pageAuditEvents, readAuditEvent } from "../query";
import { controlPlaneReach, controlPlaneReachSubjects } from "../reach";
import { reachPatterns } from "../routePattern";
import { AUDIT_EVENT_DETAIL_READ_SCOPE, AUDIT_TRAIL_READ_SCOPE } from "./guards";
import { AccessHistoryResponse, AuditEventResponse, AuditEventsResponse, ControlPlaneReachResponse } from "./responses";
import { AccessHistoryQuery, AuditEventIdParam, ControlPlaneReachQuery, ListAuditEventsQuery } from "./schemas";
import {
  accessChangeView,
  auditEventDetailView,
  auditEventView,
  controlPlaneReachSubjectView,
  controlPlaneReachView,
} from "./views";

/**
 * The audit routes, their verification strategies, and what each accepts:
 *
 *   GET /audit/events           → a page of the trail   (control-plane: audit:events:read)        query: ListAuditEventsQuery
 *   GET /audit/events/:eventId  → one event in full     (control-plane: audit:events:read_detail) param: AuditEventIdParam
 *   GET /audit/control-plane/access-history → every access change in a window, before and after
 *                                                       (control-plane: audit:events:read)        query: AccessHistoryQuery
 *   GET /audit/control-plane/reach → what one credential reached, by tenant, route and outcome
 *                                                       (control-plane: audit:events:read)        query: ControlPlaneReachQuery
 *
 * **All are reads, and there is nothing else.** The trail is append-only: no route here deletes,
 * edits, or prunes, because a management credential that could erase an audit row could erase the
 * evidence of its own use. Retention is a lifecycle concern for a Workflow, not a button on a
 * dashboard.
 *
 * **None has an end-user surface.** A user does not call the record of themselves being audited,
 * so `requireAuth()` appears nowhere in this file — and must not: the seam leaves `c.var.auth` null
 * for a control-plane caller by design, so an auth gate would deny every legitimate management call
 * permanently, with no credential able to fix it.
 *
 * **Validators sit after the gate on every line.** A validator ahead of it turns a 403 into a 400 and
 * tells an unverified caller which requests were well-formed — here that is a live oracle for which
 * projects, Workers, and action codes this deployment records.
 */

/**
 * What every route this capability mounts declares: its path, its strategy, and the scope it checks.
 *
 * Exported so a test asserts against the declaration rather than against a middleware count. Counting
 * `app.routes` entries proves that *something* runs before the handler — a bare `validate` satisfies
 * it — and cannot prove *what*. This is a declaration, so it can drift from the router;
 * `routeContract.test.ts` checks it against Hono in both directions, so a route added without an entry
 * and an entry naming no route both fail.
 */
export interface AuditRouteDeclaration {
  readonly method: "GET";
  /** The path relative to the configured `basePath`, e.g. `/events`. */
  readonly path: string;
  readonly strategy: VerificationStrategy;
  /** The control-plane scope this route checks. */
  readonly scope: ControlPlaneScope;
}

/** Every route, and how it is gated. */
export const AUDIT_ROUTES: readonly AuditRouteDeclaration[] = [
  { method: "GET", path: "/events", strategy: "control-plane", scope: AUDIT_TRAIL_READ_SCOPE },
  { method: "GET", path: "/events/:eventId", strategy: "control-plane", scope: AUDIT_EVENT_DETAIL_READ_SCOPE },
  { method: "GET", path: "/control-plane/access-history", strategy: "control-plane", scope: AUDIT_TRAIL_READ_SCOPE },
  { method: "GET", path: "/control-plane/reach", strategy: "control-plane", scope: AUDIT_TRAIL_READ_SCOPE },
];

/** How the audit sub-router is built. */
export interface AuditRoutesOptions {
  /**
   * The path the routes mount under — **required, with no fallback here**. The default lives in
   * `AuditConfig`, and the capability passes its resolved value to both this and `auditAdminRoutes`,
   * so the mounted path and the advertised path are one value read twice rather than two defaults
   * that can drift apart.
   */
  basePath: string;
  /** The audit database for this request — resolved by the capability, which owns the registry key. */
  database: (c: Context<PithyHonoEnv>) => AuditDatabase;
  /**
   * Every admin route the composed Worker declares — what the manifest reports, and what a credential's reach groups
   * its called paths by. A function, because the capability learns them at `compose`, after these routes are built.
   */
  adminRoutes: () => readonly AdminRoute[];
}

/**
 * The verified management client behind a control-plane call.
 *
 * `requireControlPlane()` has run on every route in this file, so `c.var.controlPlane` is populated by
 * the time a handler reads it. The throw is a programming-error guard, not a runtime path: reaching it
 * would mean a route was mounted without its gate, which is the one mistake this file is arranged to
 * make impossible.
 */
function caller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const context = c.var.controlPlane;
  if (!context) {
    throw new InternalError({
      message: "Audit could not identify the management caller.",
      detail: "requireControlPlane() must run before an audit handler reads the caller.",
    });
  }
  return context;
}

/**
 * The filter, as the audit trail should record that it was asked.
 *
 * Built here rather than inline in the `metadata:` literal for two reasons. It keeps dates as ISO
 * strings — a `Date` would round-trip out of the JSON column as a string anyway, so writing one is a
 * silent type change. And `metadata` may not carry top-level keys that name a column (`project`,
 * `environment`, `worker`, `tenant`); nesting the filter under one key keeps the record of *what was
 * asked for* distinct from the record of *where the reading happened* and *whose events these were*,
 * which is what those columns mean. A `tenant` here is a filter the caller typed, not the tenant this
 * read belonged to — collapsing the two would make the trail lie about its own reads.
 */
function askedFor(query: ListAuditEventsQuery): Record<string, unknown> {
  const { from, to, cursor, ...rest } = query;
  return {
    ...rest,
    ...(from ? { from: from.toISOString() } : {}),
    ...(to ? { to: to.toISOString() } : {}),
    // The cursor's value is noise in a trail; whether the caller was paging is not.
    resumed: cursor !== undefined,
  };
}

/** Register the audit sub-router. Returned as the capability's `routes` hook. */
export function registerAuditRoutes(options: AuditRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath;
  const database = options.database;
  const adminRoutes = options.adminRoutes;

  return (app) => {
    /**
     * CONTROL-PLANE READ. A filtered, resumable page of the trail — keyset, never offset, because the
     * table is appended to while it is being read and an offset page silently skips records.
     */
    app.get(
      `${base}/events`,
      describeRoute({
        summary: "Page through the audit trail, newest first.",
        verification: "control-plane",
        scopes: [AUDIT_TRAIL_READ_SCOPE],
        responses: { 200: AuditEventsResponse },
      }),
      requireControlPlane(AUDIT_TRAIL_READ_SCOPE),
      validate("query", ListAuditEventsQuery),
      async (c) => {
        const operator = caller(c);
        const query = c.req.valid("query");
        const page = await pageAuditEvents(database(c), query);
        // Audited *after* the read, so `returned` is the truth rather than an intention, and audited at
        // all because reading the record of everyone else's actions is itself one. Core's guard already
        // recorded that the call was allowed; what it cannot know is what was asked for and how much
        // came back, which is the difference between "an operator opened the pane" and "something
        // paged the entire trail".
        await c.var.emit({
          action: AuditTrailActions.trailRead,
          outcome: "success",
          actorType: "control-plane",
          actorId: operator.subject,
          resourceType: "audit_trail",
          requestId: c.req.header("cf-ray"),
          ip: c.req.header("cf-connecting-ip"),
          userAgent: c.req.header("user-agent"),
          metadata: {
            connectionId: operator.connectionId,
            query: askedFor(query),
            returned: page.events.length,
            more: page.nextCursor !== null,
          },
        });
        // `satisfies`, not `.parse()`. The check belongs at compile time: parsing every response would
        // spend a validation pass on data this Worker just built from its own rows, and it would turn a
        // shape mistake into a 500 in production rather than a red build.
        return c.json(
          { events: page.events.map(auditEventView), nextCursor: page.nextCursor } satisfies AuditEventsResponse,
          200,
        );
      },
    );

    /**
     * CONTROL-PLANE READ, the forensic one. Returns the client IP, the user-agent, and the capability's
     * metadata bag, which is why it sits behind its own scope rather than the listing's.
     */
    app.get(
      `${base}/events/:eventId`,
      describeRoute({
        summary: "Read one audit event in full, with its IP, user-agent and metadata.",
        verification: "control-plane",
        scopes: [AUDIT_EVENT_DETAIL_READ_SCOPE],
        responses: { 200: AuditEventResponse },
      }),
      requireControlPlane(AUDIT_EVENT_DETAIL_READ_SCOPE),
      validate("param", AuditEventIdParam),
      async (c) => {
        const operator = caller(c);
        const { eventId } = c.req.valid("param");
        const row = await readAuditEvent(database(c), eventId);
        // Recorded whether or not the event existed, and with the same `resourceId` either way. A read
        // that found nothing is still somebody asking after a specific event, and a miss that went
        // unrecorded would make probing for ids the one action on this surface that leaves no trace.
        await c.var.emit({
          action: AuditTrailActions.eventRead,
          outcome: row ? "success" : "failure",
          actorType: "control-plane",
          actorId: operator.subject,
          resourceType: "audit_event",
          resourceId: eventId,
          requestId: c.req.header("cf-ray"),
          ip: c.req.header("cf-connecting-ip"),
          userAgent: c.req.header("user-agent"),
          metadata: { connectionId: operator.connectionId, found: row !== null },
        });
        if (!row) {
          throw new NotFoundError({
            message: "No audit event with that id.",
            action: "Check the eventId against a page from GET /events.",
          });
        }
        return c.json({ event: auditEventDetailView(row) } satisfies AuditEventResponse, 200);
      },
    );

    /**
     * CONTROL-PLANE READ (#831). Who could do what, over time: every membership, connection and key change in a
     * window, oldest first, with its before and after — one SQL statement per page, never a walk of events here.
     * Behind the listing scope, not the detail one: it lifts named metadata keys and never an IP or a user-agent.
     */
    app.get(
      `${base}/control-plane/access-history`,
      describeRoute({
        summary:
          "Replay every membership, connection and key change in a window, oldest first, with its before and after.",
        verification: "control-plane",
        scopes: [AUDIT_TRAIL_READ_SCOPE],
        responses: { 200: AccessHistoryResponse },
      }),
      requireControlPlane(AUDIT_TRAIL_READ_SCOPE),
      validate("query", AccessHistoryQuery),
      async (c) => {
        const operator = caller(c);
        const query = c.req.valid("query");
        const window = { since: query.since, until: query.until ?? new Date() };
        const page = await accessHistory(database(c), { ...window, cursor: query.cursor, limit: query.limit });
        // Audited like the listing: replaying who held what across every account is a read of everyone's access,
        // and the trail should answer who asked, for which window, and how much came back.
        await c.var.emit({
          action: AuditTrailActions.accessHistoryRead,
          outcome: "success",
          actorType: "control-plane",
          actorId: operator.subject,
          resourceType: "audit_trail",
          requestId: c.req.header("cf-ray"),
          ip: c.req.header("cf-connecting-ip"),
          userAgent: c.req.header("user-agent"),
          metadata: {
            connectionId: operator.connectionId,
            query: {
              since: window.since.toISOString(),
              until: window.until.toISOString(),
              resumed: query.cursor !== undefined,
            },
            returned: page.changes.length,
            more: page.nextCursor !== null,
          },
        });
        return c.json(
          {
            since: window.since.toISOString(),
            until: window.until.toISOString(),
            changes: page.changes.map(accessChangeView),
            nextCursor: page.nextCursor,
          } satisfies AccessHistoryResponse,
          200,
        );
      },
    );

    /**
     * CONTROL-PLANE READ (#828). What one credential reached — by tenant, action, method, route and outcome — over a
     * window, in one SQL statement, never by paging events here. `subjects=true` expands one route into the subject
     * ids its called paths name. Behind the listing scope, not the detail one: the answer is the tenant, the route,
     * the scope and ids the listing already shows, and never an IP, a user-agent or any other metadata key.
     */
    app.get(
      `${base}/control-plane/reach`,
      describeRoute({
        summary: "Read what one control-plane credential reached, by tenant, route and outcome, over a window.",
        verification: "control-plane",
        scopes: [AUDIT_TRAIL_READ_SCOPE],
        responses: { 200: ControlPlaneReachResponse },
      }),
      requireControlPlane(AUDIT_TRAIL_READ_SCOPE),
      validate("query", ControlPlaneReachQuery),
      async (c) => {
        const operator = caller(c);
        const query = c.req.valid("query");
        const filter = {
          connectionId: query.connectionId,
          since: query.since,
          until: query.until ?? new Date(),
          ...(query.keyId !== undefined ? { keyId: query.keyId } : {}),
          ...(query.route !== undefined ? { route: query.route } : {}),
        };
        const patterns = reachPatterns(adminRoutes());
        const expanded =
          query.subjects === "true" && filter.route !== undefined
            ? await controlPlaneReachSubjects(database(c), { ...filter, route: filter.route }, patterns)
            : { reach: await controlPlaneReach(database(c), filter, patterns), subjects: undefined };
        // Audited like the listing, and against the connection whose reach was read: "who reviewed what this
        // credential touched" is a question the trail should answer about that credential.
        await c.var.emit({
          action: AuditTrailActions.reachRead,
          outcome: "success",
          actorType: "control-plane",
          actorId: operator.subject,
          resourceType: "controlplane_connection",
          resourceId: query.connectionId,
          requestId: c.req.header("cf-ray"),
          ip: c.req.header("cf-connecting-ip"),
          userAgent: c.req.header("user-agent"),
          metadata: {
            connectionId: operator.connectionId,
            query: {
              connectionId: filter.connectionId,
              keyId: filter.keyId ?? null,
              since: filter.since.toISOString(),
              until: filter.until.toISOString(),
              route: filter.route ?? null,
              subjects: expanded.subjects !== undefined,
            },
            returned: expanded.reach.length,
            ...(expanded.subjects !== undefined ? { subjects: expanded.subjects.length } : {}),
          },
        });
        return c.json(
          {
            connectionId: filter.connectionId,
            keyId: filter.keyId ?? null,
            since: filter.since.toISOString(),
            until: filter.until.toISOString(),
            reach: expanded.reach.map(controlPlaneReachView),
            ...(expanded.subjects !== undefined
              ? { subjects: expanded.subjects.map(controlPlaneReachSubjectView) }
              : {}),
          } satisfies ControlPlaneReachResponse,
          200,
        );
      },
    );
  };
}
