// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { ControlPlaneAuditActions } from "@pithy-sh/core/src/controlPlane/audit/actions";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { sql } from "kysely";
import { z } from "zod";
import type { AuditDatabase } from "./data/tables";
import { ReachPattern, routeParams, routeSubject } from "./routePattern";

/**
 * What one control-plane credential reached — `#828`.
 *
 * "This key leaked. What did it touch?" Every admitted call writes `controlplane/call_allowed` against the connection
 * as `resourceId`, with the scope, the key, the method and the path as called in `metadata`. The listing carries no
 * metadata, so answering from it means one forensic read per event, behind the scope that also discloses the client
 * IP. This reads the same rows in SQL and returns one row per tenant, action, method, route and outcome.
 *
 * **A refusal is the handler's, paired with the gate's row.** The gate's own refusal (`auditDenial`) is of a call that
 * never verified, so it names no connection and no actor and is no credential's reach. What a verified credential was
 * refused is a handler's refusal past the gate (`auditHandlerDenial`): a `controlplane/call_denied` row against the
 * connection, written in the same request as the gate's `call_allowed` for the same call. The two are one call, and
 * it was refused, so the `call_allowed` row of a request that also holds a refusal for the same actor, method and path
 * is dropped, and the refusal reads its scope and key from that row when its own names none — as rows written before
 * the guard recorded them do not. `scope` is the scope the credential carried, never `required`, which on a handler's
 * refusal is the gate's requirement the call met; what it lacked is only in the log. A call with no request id, as off
 * Cloudflare, cannot be paired: its refusal stands on the scope and key its own row names, and its gate row stays an
 * admitted call.
 *
 * **Grouped by the declared route, expandable to the subjects.** The path is recorded as called, so
 * `/admin/users/u_8f2` names a user. Each call is matched back to the admin route the manifest declares
 * (`routePattern.ts`), most specific first; a path no route matches is its own row, marked unmatched.
 * {@link controlPlaneReachSubjects} expands one route into the paths it was called with and the subject ids they
 * name — the *whose data* list a breach scope is drawn from. The subject is the route's last id parameter
 * ({@link routeSubject}), so a ledger read by user and currency names the user, and a group's subject count is of
 * distinct subjects, not distinct paths.
 *
 * **The tenant is the handler's, joined by request id.** The gate writes its row before the handler runs, so before
 * any tenant is resolved, and that row's own `tenant` is null. The handler's events in the same request carry it, and
 * share the call's `requestId` (`cf-ray`) and `actorId`. So a call reached every tenant its handler recorded, and a
 * call whose handler recorded none — or that carries no request id, as off Cloudflare — reached no named tenant. Only
 * `control-plane` events by the same actor count, so a stray event sharing a request id cannot attribute a call.
 *
 * **One statement, never a page walk.** The calls are found through `pithyAuditEventsCallIdx` and the handler events
 * through `pithyAuditEventsRequestIdx`. The routes go in as one JSON parameter, so a manifest of any size is one bound
 * value rather than four per route against D1's limit. The statement groups by called path, and the Worker folds the
 * paths of each group, because a subject is read from a path by splitting it on `/`, which SQLite cannot do without a
 * recursive CTE per row.
 *
 * **Nothing personal leaves this function.** It reads the scope, the key id, the method and the path out of
 * `metadata`, and no other key, and never the IP or the user-agent. Of the handler's events it reads the tenant.
 */

/** What to read: one connection over an inclusive window, optionally one key and one route. */
export interface ControlPlaneReachFilter {
  /** The connection whose calls are read — the rows' `resourceId`. */
  connectionId: string;
  /** Inclusive lower bound on `occurredAt`. */
  since: Date;
  /** Inclusive upper bound on `occurredAt`. */
  until: Date;
  /** Narrow to the calls one registered key signed — `metadata.keyId`. */
  keyId?: string;
  /** Narrow to one route — a declared pattern, or the called path of an unmatched row. */
  route?: string;
}

/** The two actions that record a verified call: the gate's admission and a handler's refusal past it. */
const CALL_ACTIONS = [ControlPlaneAuditActions.callAllowed, ControlPlaneAuditActions.callDenied];

/** The resource type every attributed call row carries. */
const CONNECTION_RESOURCE = "controlplane_connection";

/** The routes, as the statement's one JSON parameter. */
const ReachPatterns = sqliteJson(z.array(ReachPattern).describe("Every declared admin route, ranked."));

/** The columns every grouping carries, in the order the answer is sorted by. */
const GROUP = ["tenant", "route", "action", "method", "matched", "outcome", "scope"] as const;

/** The order the statement sorts in: the group, with the path after the route. */
const ORDER = [...GROUP.slice(0, 2), "path" as const, ...GROUP.slice(2)];

/**
 * The statement, as one Kysely query — exported so a test can read its query plan.
 *
 * 1. **`routes`** — the declared routes, unpacked from the one JSON parameter.
 * 2. **`rows`** — the connection's call rows in the window, with the scope, key, method and path lifted out of
 *    `metadata`. A row with no path is no call to a route and is dropped.
 * 3. **`calls`** — one row per call: a refusal takes its scope and key from the gate's row in the same request when its
 *    own names none, and that gate row is dropped, since the call it admitted was refused. The key filter applies here,
 *    after the refusal has its key.
 * 4. **`matches`** — each call against every route of its method, by glob and slash count, ranked so the most specific
 *    match is `pick = 1`.
 * 5. **`tenants`** — the distinct tenants each call's handler recorded, by request id and actor, from `control-plane`
 *    events only.
 * 6. **`reached`** — each call once per tenant it reached, with its route, or its own path when unmatched.
 * 7. **The group** — counts and instants per tenant, route, action, method, outcome and path.
 */
export function controlPlaneReachStatement(
  db: AuditDatabase,
  filter: ControlPlaneReachFilter,
  patterns: readonly ReachPattern[],
) {
  const allowed = ControlPlaneAuditActions.callAllowed;
  const denied = ControlPlaneAuditActions.callDenied;
  const encoded = ReachPatterns.encode([...patterns]);
  const field = (name: string) => sql`json_extract(${sql.ref("value")}, ${`$.${name}`})`;

  let reached = db
    .with("routes", (q) =>
      q
        .selectFrom(sql`json_each(${encoded})`.as("each"))
        .select([
          sql<string>`${field("method")}`.as("method"),
          sql<string>`${field("pattern")}`.as("pattern"),
          sql<string>`${field("glob")}`.as("glob"),
          sql<number | null>`${field("slashes")}`.as("slashes"),
          sql<number>`${field("params")}`.as("params"),
          sql<number>`${field("rank")}`.as("rank"),
        ]),
    )
    .with("rows", (q) =>
      q
        .selectFrom("pithyAuditEvents")
        .select((eb) => [
          "id",
          "action",
          "outcome",
          "occurredAt",
          "requestId",
          "actorId",
          "tenant",
          sql<string | null>`json_extract(${eb.ref("metadata")}, '$.scope')`.as("scope"),
          sql<string | null>`json_extract(${eb.ref("metadata")}, '$.keyId')`.as("keyId"),
          sql<string>`json_extract(${eb.ref("metadata")}, '$.method')`.as("method"),
          sql<string>`json_extract(${eb.ref("metadata")}, '$.path')`.as("path"),
        ])
        // In `pithyAuditEventsCallIdx`'s column order: the actions, the connection, then the window.
        .where("action", "in", CALL_ACTIONS)
        .where("resourceId", "=", filter.connectionId)
        .where("occurredAt", ">=", SQLiteDate.encode(filter.since))
        .where("occurredAt", "<=", SQLiteDate.encode(filter.until))
        .where("resourceType", "=", CONNECTION_RESOURCE)
        .where(sql`json_extract(${sql.ref("metadata")}, '$.path')`, "is not", null),
    )
    .with("calls", (q) => {
      const keyId = sql<string | null>`coalesce(${sql.ref("call.keyId")}, ${sql.ref("gate.keyId")})`;
      let calls = q
        .selectFrom("rows as call")
        // A refusal's own gate row: the same request, actor, method and path. A null request id pairs with nothing.
        .leftJoin("rows as gate", (join) =>
          join
            .on("call.action", "=", denied)
            .on("gate.action", "=", allowed)
            .onRef("gate.requestId", "=", "call.requestId")
            .onRef("gate.actorId", "=", "call.actorId")
            .onRef("gate.method", "=", "call.method")
            .onRef("gate.path", "=", "call.path"),
        )
        .where((eb) =>
          eb.or([
            eb("call.action", "=", denied),
            eb.not(
              eb.exists(
                eb
                  .selectFrom("rows as refusal")
                  .select(sql<number>`1`.as("one"))
                  .where("refusal.action", "=", denied)
                  .whereRef("refusal.requestId", "=", "call.requestId")
                  .whereRef("refusal.actorId", "=", "call.actorId")
                  .whereRef("refusal.method", "=", "call.method")
                  .whereRef("refusal.path", "=", "call.path"),
              ),
            ),
          ]),
        )
        .select([
          "call.id as id",
          "call.action as action",
          "call.outcome as outcome",
          "call.occurredAt as occurredAt",
          "call.requestId as requestId",
          "call.actorId as actorId",
          "call.tenant as tenant",
          sql<string | null>`coalesce(${sql.ref("call.scope")}, ${sql.ref("gate.scope")})`.as("scope"),
          "call.method as method",
          "call.path as path",
        ]);
      if (filter.keyId !== undefined) calls = calls.where(keyId, "=", filter.keyId);
      return calls;
    })
    .with("matches", (q) =>
      q
        .selectFrom("calls")
        .innerJoin("routes", (join) =>
          join
            .onRef("routes.method", "=", "calls.method")
            .on(sql<boolean>`${sql.ref("calls.path")} glob ${sql.ref("routes.glob")}`)
            .on((eb) =>
              eb.or([
                eb("routes.slashes", "is", null),
                eb(
                  "routes.slashes",
                  "=",
                  sql<number>`length(${sql.ref("calls.path")}) - length(replace(${sql.ref("calls.path")}, '/', ''))`,
                ),
              ]),
            ),
        )
        .select([
          "calls.id as callId",
          "routes.pattern as pattern",
          "routes.params as params",
          sql<number>`row_number() over (partition by ${sql.ref("calls.id")} order by ${sql.ref("routes.rank")})`.as(
            "pick",
          ),
        ]),
    )
    .with("tenants", (q) =>
      q
        .selectFrom("calls")
        .innerJoin("pithyAuditEvents as handled", (join) =>
          join
            .onRef("handled.requestId", "=", "calls.requestId")
            .onRef("handled.actorId", "=", "calls.actorId")
            .onRef("handled.id", "!=", "calls.id")
            .on("handled.actorType", "=", "control-plane")
            .on("handled.tenant", "is not", null),
        )
        .select(["calls.id as callId", "handled.tenant as tenant"])
        .distinct(),
    )
    .with("reached", (q) =>
      q
        .selectFrom("calls")
        .leftJoin("matches", (join) => join.onRef("matches.callId", "=", "calls.id").on("matches.pick", "=", 1))
        .leftJoin("tenants", "tenants.callId", "calls.id")
        .select([
          sql<string | null>`coalesce(${sql.ref("tenants.tenant")}, ${sql.ref("calls.tenant")})`.as("tenant"),
          sql<string>`coalesce(${sql.ref("matches.pattern")}, ${sql.ref("calls.path")})`.as("route"),
          sql<number>`${sql.ref("matches.pattern")} is not null`.as("matched"),
          sql<number>`coalesce(${sql.ref("matches.params")}, 0)`.as("params"),
          "calls.action as action",
          "calls.method as method",
          "calls.outcome as outcome",
          "calls.scope as scope",
          "calls.path as path",
          "calls.occurredAt as occurredAt",
        ]),
    )
    .selectFrom("reached")
    .select((eb) => [
      ...GROUP,
      "path",
      sql<number>`count(*)`.as("count"),
      sql<number>`max(${eb.ref("params")})`.as("params"),
      eb.fn.min("occurredAt").as("firstAt"),
      eb.fn.max("occurredAt").as("lastAt"),
    ]);

  if (filter.route !== undefined) reached = reached.where("route", "=", filter.route);
  let ordered = reached.groupBy([...GROUP, "path"]);
  for (const column of ORDER) ordered = ordered.orderBy(column);
  return ordered;
}

/** One grouped row as the statement returns it, decoded. Internal: the two readers below project it. */
const ReachStatementRow = z
  .object({
    tenant: z.string().nullable().describe("The tenant the calls reached, or null when their handler named none."),
    route: z.string().describe("The declared route, or the called path when no route matched."),
    action: z.string().describe("`controlplane/call_allowed` or `controlplane/call_denied`."),
    method: z.string().describe("The HTTP method called."),
    matched: SQLiteBoolean.describe("Whether a declared route matched the called path."),
    outcome: z.string().describe("The calls' outcome — `success` or `denied`."),
    scope: z.string().nullable().describe("The scope the calls' credential carried, refused or not."),
    path: z.string().describe("The path the group was called with."),
    count: z.number().int().describe("How many calls the group holds."),
    params: z.number().int().describe("How many parameters the matched route declares; 0 when unmatched."),
    firstAt: SQLiteDate.describe("The earliest call in the group."),
    lastAt: SQLiteDate.describe("The latest call in the group."),
  })
  .describe("One grouped row of the reach statement.");
type ReachStatementRow = z.output<typeof ReachStatementRow>;

/**
 * One tenant, action, method, route and outcome a credential reached.
 *
 * Internal: the wire shape is `ControlPlaneReachView` in `http/responses.ts`, and `http/views.ts` projects this into it.
 */
export const ControlPlaneReachRow = z
  .object({
    tenant: z
      .string()
      .nullable()
      .describe("The tenant the calls reached, as their handler recorded it. Null when the handler named none."),
    action: z
      .string()
      .describe("`controlplane/call_allowed` for admitted calls, `controlplane/call_denied` for refusals."),
    method: z.string().describe("The HTTP method called."),
    route: z
      .string()
      .describe("The declared route pattern the calls matched, or the path as called when no declared route matched."),
    matched: z.boolean().describe("Whether `route` is a declared pattern. False marks an unmatched path's own row."),
    outcome: z.string().describe("The calls' outcome: `success` or `denied`."),
    scope: z
      .string()
      .nullable()
      .describe(
        "The scope the calls' credential carried. On a refusal it is the scope the refused credential held, not one it lacked, which the trail does not record.",
      ),
    count: z.number().int().describe("How many calls."),
    subjects: z
      .number()
      .int()
      .nullable()
      .describe(
        "How many distinct subjects the calls touched — distinct values of the route's subject parameter and the parameters before it, 0 for a route with none, null for an unmatched path, which names no subject it can count.",
      ),
    firstAt: z.date().describe("When the first call landed."),
    lastAt: z.date().describe("When the last call landed."),
  })
  .describe("One tenant, action, method, route and outcome one control-plane credential reached, with its counts.");
export type ControlPlaneReachRow = z.output<typeof ControlPlaneReachRow>;

/** One subject a route reached, from the paths it was called with. Internal, like {@link ControlPlaneReachRow}. */
export const ControlPlaneReachSubjectRow = ControlPlaneReachRow.omit({ subjects: true })
  .extend({
    path: z.string().describe("The path as called."),
    subjectId: z
      .string()
      .nullable()
      .describe(
        "The value of the route's last id parameter (`id`, or a name ending in `Id`), or of its last parameter when none names an id — whose data the call acted on. Null when the route declares none.",
      ),
    params: z.record(z.string(), z.string()).describe("Every parameter the route declares, with its value in `path`."),
  })
  .describe("One path a route was called with, and the subject ids it names.");
export type ControlPlaneReachSubjectRow = z.output<typeof ControlPlaneReachSubjectRow>;

/** What one path's subject is counted as: its {@link routeSubject} key, or the path itself when that names none. */
function subjectKey(row: ReachStatementRow): string {
  return routeSubject(row.route, row.path).key ?? row.path;
}

/** One group of the aggregate, folded from its per-path rows. */
interface Folded {
  row: ReachStatementRow;
  count: number;
  subjects: Set<string>;
  first: Date;
  last: Date;
}

/**
 * Fold the per-path rows into one reach row per group. Every group is the union of its paths' rows, so the counts sum,
 * the instants are the extremes, and the subjects are the distinct subject keys among its paths: a route with
 * parameters counts them, a route with none counts 0, and an unmatched path names no subject it can count.
 */
function fold(rows: readonly ReachStatementRow[]): ControlPlaneReachRow[] {
  const folded = new Map<string, Folded>();
  for (const row of rows) {
    const key = JSON.stringify(GROUP.map((column) => row[column]));
    const group = folded.get(key);
    if (!group) {
      folded.set(key, {
        row,
        count: row.count,
        subjects: new Set([subjectKey(row)]),
        first: row.firstAt,
        last: row.lastAt,
      });
      continue;
    }
    group.count += row.count;
    group.subjects.add(subjectKey(row));
    if (row.firstAt < group.first) group.first = row.firstAt;
    if (row.lastAt > group.last) group.last = row.lastAt;
  }
  return [...folded.values()]
    .map(({ row, count, subjects, first, last }) => ({
      tenant: row.tenant,
      action: row.action,
      method: row.method,
      route: row.route,
      matched: row.matched,
      outcome: row.outcome,
      scope: row.scope,
      count,
      subjects: !row.matched ? null : row.params > 0 ? subjects.size : 0,
      firstAt: first,
      lastAt: last,
    }))
    .sort(byGroup);
}

/** Read the statement's rows, decoded. */
async function grouped(
  db: AuditDatabase,
  filter: ControlPlaneReachFilter,
  patterns: readonly ReachPattern[],
): Promise<ReachStatementRow[]> {
  const rows = await controlPlaneReachStatement(db, filter, patterns).execute();
  return rows.map((row) => ReachStatementRow.parse(row));
}

/** Everything one connection's calls reached over a window, one row per tenant, action, method, route and outcome. */
export async function controlPlaneReach(
  db: AuditDatabase,
  filter: ControlPlaneReachFilter,
  patterns: readonly ReachPattern[],
): Promise<ControlPlaneReachRow[]> {
  return fold(await grouped(db, filter, patterns));
}

/** One route's subjects, and that route's reach rows beside them — from the one statement's per-path rows. */
export async function controlPlaneReachSubjects(
  db: AuditDatabase,
  filter: ControlPlaneReachFilter & { route: string },
  patterns: readonly ReachPattern[],
): Promise<{ reach: ControlPlaneReachRow[]; subjects: ControlPlaneReachSubjectRow[] }> {
  const rows = await grouped(db, filter, patterns);
  const subjects = rows.map((row) => {
    const params = row.matched ? routeParams(row.route, row.path) : {};
    return {
      tenant: row.tenant,
      action: row.action,
      method: row.method,
      route: row.route,
      matched: row.matched,
      path: row.path,
      outcome: row.outcome,
      scope: row.scope,
      subjectId: row.matched ? routeSubject(row.route, row.path).subjectId : null,
      params,
      count: row.count,
      firstAt: row.firstAt,
      lastAt: row.lastAt,
    } satisfies ControlPlaneReachSubjectRow;
  });
  return { reach: fold(rows), subjects };
}

/** The aggregate's order, as SQLite sorts it: null first, then by code unit. */
function byGroup(a: ControlPlaneReachRow, b: ControlPlaneReachRow): number {
  for (const column of GROUP) {
    const [x, y] = [a[column], b[column]];
    if (x === y) continue;
    if (x === null) return -1;
    if (y === null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
