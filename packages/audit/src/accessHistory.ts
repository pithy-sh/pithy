// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { AuditActorType } from "@pithy-sh/core/src/audit/auditEvent";
import { ControlPlaneAuditActions } from "@pithy-sh/core/src/controlPlane/audit/actions";
import { ControlPlaneActorKind } from "@pithy-sh/core/src/controlPlane/data/connection";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { decodeCursor, type PageCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { type RawBuilder, sql } from "kysely";
import { z } from "zod";
import type { AuditDatabase } from "./data/tables";

/**
 * Who could do what, over time — `#831`.
 *
 * Every change to who can reach an environment's data is already in the trail: a membership joining, changing role,
 * leaving or being removed, and a control-plane connection being registered, updated or removed, or a key on it
 * registered, expired or revoked. What each changed — the role before and after, the scopes before and after — is in
 * the row's `metadata`, which only the forensic one-event read returns, beside the IP and the user-agent. This reads
 * the same rows in SQL and answers the changes.
 *
 * **One statement per page, never a walk.** The events are filtered, their known metadata keys lifted out, and each
 * classified and given its before and after, all in D1. The handler pages the *answer*, oldest first; it never pages
 * events to compute it.
 *
 * **Nothing personal, and nothing else, leaves this function.** It reads {@link ACCESS_HISTORY_METADATA_KEYS} out of
 * `metadata` and no other key, and never the IP or the user-agent columns. The principal is the one personal field,
 * and it is what the question is: who sanctioned a connection is half of who could reach the data through it.
 *
 * **A change recorded before its emitter carried the detail reads as `not_recorded`**, never as a guess. A role
 * change from before `previousRole` was written has no before, and an update that moved no scope, from before the
 * grant was written on every update, has neither — so their values are null and `recorded` says why.
 */

/**
 * The code an accepted invitation writes. It carries `joined: false` when the person was already a member: acceptance
 * then changed nothing, and its `role` is the role the invitation offered, not the one the membership holds.
 */
export const INVITATION_ACCEPTED_ACTION = "organization/member_joined";

/**
 * The membership codes `@pithy-sh/organization` writes, as literals.
 *
 * Literals rather than an import: audit depends on core alone, and a capability never reaches into another's
 * internals (principle 4). A code is stable forever once a row holds one, and `packages/cli/src/audit/accessHistoryCodes.test.ts`
 * holds every literal here to the register that declares it, so a rename there fails the build here.
 */
export const MEMBER_ACCESS_ACTIONS = {
  /** A membership was created with nothing before it — save {@link INVITATION_ACCEPTED_ACTION} with `joined: false`. */
  joins: ["organization/created", INVITATION_ACCEPTED_ACTION, "organization/admin_member_added"],
  /** A membership's role changed, recorded with `previousRole` from #831 on. */
  changes: ["organization/member_role_changed", "organization/admin_member_role_changed"],
  /** Ownership reached a membership: its role became the conferred one. */
  ownership: ["organization/ownership_accepted", "organization/admin_ownership_forced"],
  /** A membership ended, recorded with the role it held. */
  ends: ["organization/member_removed", "organization/member_left", "organization/admin_member_removed"],
} as const;

/** The member codes whose actor is the member, so an older row without `subjectUserId` still names them. */
const SELF_ACTIONS = [
  "organization/created",
  "organization/member_joined",
  "organization/member_left",
  "organization/ownership_accepted",
];

/** The connection-lifecycle codes, written by the CLI's `connectionRegistry`. */
const CONNECTION_ACTIONS = [
  ControlPlaneAuditActions.connectionRegistered,
  ControlPlaneAuditActions.connectionUpdated,
  ControlPlaneAuditActions.connectionRemoved,
];

/** The key codes the seam's own routes write. */
const KEY_ACTIONS = [ControlPlaneAuditActions.keyRegistered, ControlPlaneAuditActions.keyExpired];

/** Every code an access change is read from. */
export const ACCESS_ACTIONS: readonly string[] = [
  ...MEMBER_ACCESS_ACTIONS.joins,
  ...MEMBER_ACCESS_ACTIONS.changes,
  ...MEMBER_ACCESS_ACTIONS.ownership,
  ...MEMBER_ACCESS_ACTIONS.ends,
  ...CONNECTION_ACTIONS,
  ...KEY_ACTIONS,
];

/**
 * Every `metadata` key this read lifts, and the only ones. `accessHistory.workers.test.ts` holds the compiled
 * statement to this list, so a key added to the SQL and not here fails.
 */
export const ACCESS_HISTORY_METADATA_KEYS = [
  "role",
  "previousRole",
  "confers",
  "subjectUserId",
  "membershipId",
  "scopes",
  "scopesBefore",
  "scopesAfter",
  "actorKind",
  "purpose",
  "authorizedBy",
  "registeredKeyId",
  "expiredKeyId",
  "revokedKeyId",
  "joined",
  "replacedConnectionId",
] as const;

/** What to read: an inclusive window, and where to resume. */
export interface AccessHistoryFilter {
  /** Inclusive lower bound on `occurredAt`. */
  since: Date;
  /** Inclusive upper bound on `occurredAt`. */
  until: Date;
  /** Where to resume, from the previous page's `nextCursor`. Opaque; a malformed one is a first page. */
  cursor?: string;
  /** How many changes to return, clamped into `[1, MAX_PAGE_SIZE]`. */
  limit?: number;
}

/** A list of scopes, as `json_extract` hands an array back: JSON text, decoded through the codec. */
const ScopeList = sqliteJson(z.array(z.string()).describe("A connection's granted scopes."));

/**
 * One access change, decoded from the statement's row. Flat, because SQL is: `subject` says which fields mean
 * something, and `http/views.ts` projects it into the wire union `AccessChangeView`.
 */
export const AccessHistoryRow = z
  .object({
    id: z.number().int().describe("The event's surrogate id. The keyset tiebreak; never on the wire."),
    eventId: z.string().describe("The event's public UUID."),
    occurredAt: SQLiteDate.describe("When the change happened."),
    action: z.string().describe("The `domain/reason` code the change was read from."),
    actorType: AuditActorType.describe("The kind of principal that made the change."),
    actorId: z.string().nullable().describe("The principal that made the change, or null."),
    actorKind: ControlPlaneActorKind.nullable().describe("For a `control-plane` actor, which kind of client, or null."),
    subject: z.enum(["member", "connection", "key"]).describe("What changed: a membership, a connection, or a key."),
    recorded: SQLiteBoolean.describe("Whether the event carried its before and after. False reads as not recorded."),
    organizationId: z.string().nullable().describe("A member change's organization — the event's tenant."),
    membershipId: z.string().nullable().describe("A member change's membership."),
    userId: z.string().nullable().describe("A member change's member."),
    roleBefore: z.string().nullable().describe("A member change's role before, or null for none or not recorded."),
    roleAfter: z.string().nullable().describe("A member change's role after, or null for none or not recorded."),
    connectionId: z.string().nullable().describe("A connection or key change's connection."),
    connectionKind: ControlPlaneActorKind.nullable().describe("The connection's kind of client, or null."),
    purpose: z.string().nullable().describe("The connection's purpose, or null."),
    principal: z.string().nullable().describe("Who sanctioned the connection, or null."),
    scopesBefore: ScopeList.nullable().describe("The connection's scopes before, or null for none or not recorded."),
    scopesAfter: ScopeList.nullable().describe("The connection's scopes after, or null for none or not recorded."),
    replacedConnectionId: z
      .string()
      .nullable()
      .describe("For a registration that started over, the connection it replaced, whose grant ended with it."),
    keyId: z.string().nullable().describe("A key change's key id."),
    keyChange: z.enum(["registered", "expired", "revoked"]).nullable().describe("What happened to the key."),
  })
  .describe("One access change, as the access-history statement answers it.");
export type AccessHistoryRow = z.output<typeof AccessHistoryRow>;

/** One page of access changes, oldest first, and where the next starts. */
export interface AccessHistoryPage {
  /** The page, oldest first. */
  changes: AccessHistoryRow[];
  /** Where the next page starts, or null at the end of the window. */
  nextCursor: string | null;
}

/** `json_extract(metadata, '<path>')`, the path a literal of ours and never a caller's. */
function meta(path: string): RawBuilder<unknown> {
  return sql`json_extract(${sql.ref("metadata")}, ${sql.lit(path)})`;
}

/**
 * A key an update may write as the value it holds now, or as `{ from, to }` when the update moved it: the `to`, or
 * the plain value. `json_type` is null for an absent key, which reads as the plain value — also null.
 */
function currentValue(key: string): RawBuilder<unknown> {
  return sql`case json_type(${sql.ref("metadata")}, ${sql.lit(`$.${key}`)})
    when 'object' then ${meta(`$.${key}.to`)} else ${meta(`$.${key}`)} end`;
}

/** `<column> in (<codes>)`, the codes bound as parameters. */
function oneOf(column: string, codes: readonly string[]): RawBuilder<boolean> {
  return sql<boolean>`${sql.ref(column)} in (${sql.join(codes)})`;
}

/** A decoded cursor, narrowed to the `(occurredAt, id)` pair this ordering can use. Anything else is a first page. */
function keysetPosition(cursor: PageCursor | undefined): { sort: number; id: number } | undefined {
  if (!cursor) return undefined;
  if (typeof cursor.sort !== "number" || typeof cursor.id !== "number") return undefined;
  return { sort: cursor.sort, id: cursor.id };
}

/**
 * The page, as one Kysely statement — exported so a test can read what it compiles to.
 *
 * Three steps, in one statement:
 *
 * 1. **`extracted`** — the window's successful access events, after the cursor, with each named metadata key lifted
 *    out. `scopes` is an array on a registration and a removal and `{ from, to }` on an update that moved it, so the
 *    two are read apart. Kind, purpose and principal are the update's `to` where it moved them. An invitation redeemed
 *    by someone already a member (`joined` false) is left out here: it changed nothing.
 * 2. **`classified`** — what changed. A member code is a member change; a key code is a key change, and so is a CLI
 *    update that registered or revoked a key, because that is what it did; the rest of the connection codes are
 *    connection changes.
 * 3. **The answer** — each change's before and after by its code, and whether the event recorded them.
 */
export function accessHistoryStatement(
  db: AuditDatabase,
  filter: AccessHistoryFilter,
  page: { position?: { sort: number; id: number }; limit: number },
) {
  const { joins, changes, ownership, ends } = MEMBER_ACCESS_ACTIONS;
  const memberActions = [...joins, ...changes, ...ownership, ...ends];
  const position = page.position;
  return db
    .with("extracted", (q) =>
      q
        .selectFrom("pithyAuditEvents")
        .select([
          "id",
          "eventId",
          "occurredAt",
          "action",
          "actorType",
          "actorId",
          "actorKind",
          "tenant",
          "resourceId",
          meta("$.role").as("role"),
          meta("$.previousRole").as("previousRole"),
          meta("$.confers").as("confers"),
          meta("$.subjectUserId").as("subjectUserId"),
          meta("$.membershipId").as("recordedMembershipId"),
          sql`case json_type(${sql.ref("metadata")}, '$.scopes') when 'array' then ${meta("$.scopes")} end`.as(
            "scopes",
          ),
          meta("$.scopes.from").as("scopesFrom"),
          meta("$.scopes.to").as("scopesTo"),
          meta("$.scopesBefore").as("scopesBeforeKey"),
          meta("$.scopesAfter").as("scopesAfterKey"),
          currentValue("actorKind").as("connectionKind"),
          currentValue("purpose").as("purpose"),
          currentValue("authorizedBy").as("principal"),
          meta("$.registeredKeyId").as("registeredKeyId"),
          meta("$.expiredKeyId").as("expiredKeyId"),
          meta("$.revokedKeyId").as("revokedKeyId"),
          meta("$.replacedConnectionId").as("replacedConnectionId"),
        ])
        .where("action", "in", ACCESS_ACTIONS)
        // An invitation redeemed by someone already a member changed nothing. `json_extract` reads a JSON `false` as
        // 0 and an absent key as null, so a row written before `joined` was recorded still reads as the join it was.
        .where(
          sql<boolean>`not (${sql.ref("action")} = ${INVITATION_ACCEPTED_ACTION} and coalesce(${meta("$.joined")}, 1) = 0)`,
        )
        .where("outcome", "=", "success")
        .where("occurredAt", ">=", SQLiteDate.encode(filter.since))
        .where("occurredAt", "<=", SQLiteDate.encode(filter.until))
        .$if(position !== undefined, (query) =>
          query.where((eb) =>
            eb.or([
              eb("occurredAt", ">", position?.sort ?? 0),
              eb.and([eb("occurredAt", "=", position?.sort ?? 0), eb("id", ">", position?.id ?? 0)]),
            ]),
          ),
        ),
    )
    .with("classified", (q) =>
      q
        .selectFrom("extracted")
        .selectAll()
        .select(
          sql<string>`case
            when ${oneOf("action", memberActions)} then 'member'
            when ${oneOf("action", KEY_ACTIONS)} then 'key'
            when ${sql.ref("registeredKeyId")} is not null or ${sql.ref("revokedKeyId")} is not null then 'key'
            else 'connection' end`.as("subject"),
        ),
    )
    .with("answered", (q) =>
      q.selectFrom("classified").select([
        "id",
        "eventId",
        "occurredAt",
        "action",
        "actorType",
        "actorId",
        "actorKind",
        "subject",
        sql`case when ${sql.ref("subject")} = 'member' then ${sql.ref("tenant")} end`.as("organizationId"),
        sql`case when ${sql.ref("subject")} = 'member' then
            case when ${sql.ref("action")} = 'organization/created' then ${sql.ref("recordedMembershipId")}
            else ${sql.ref("resourceId")} end end`.as("membershipId"),
        sql`case when ${sql.ref("subject")} = 'member' then coalesce(${sql.ref("subjectUserId")},
            case when ${oneOf("action", SELF_ACTIONS)} then ${sql.ref("actorId")} end) end`.as("userId"),
        sql`case
            when ${oneOf("action", changes)} or ${oneOf("action", ownership)} then ${sql.ref("previousRole")}
            when ${oneOf("action", ends)} then ${sql.ref("role")} end`.as("roleBefore"),
        sql`case
            when ${oneOf("action", joins)} or ${oneOf("action", changes)} then ${sql.ref("role")}
            when ${oneOf("action", ownership)} then coalesce(${sql.ref("role")}, ${sql.ref("confers")}) end`.as(
          "roleAfter",
        ),
        sql`case when ${sql.ref("subject")} != 'member' then ${sql.ref("resourceId")} end`.as("connectionId"),
        sql`case when ${sql.ref("subject")} = 'connection' then ${sql.ref("connectionKind")} end`.as("connectionKind"),
        sql`case when ${sql.ref("subject")} = 'connection' then ${sql.ref("purpose")} end`.as("purpose"),
        sql`case when ${sql.ref("subject")} = 'connection' then ${sql.ref("principal")} end`.as("principal"),
        sql`case when ${sql.ref("subject")} = 'connection' then case ${sql.ref("action")}
            when ${ControlPlaneAuditActions.connectionUpdated} then coalesce(${sql.ref("scopesBeforeKey")}, ${sql.ref("scopesFrom")})
            when ${ControlPlaneAuditActions.connectionRemoved} then ${sql.ref("scopes")} end end`.as("scopesBefore"),
        sql`case when ${sql.ref("subject")} = 'connection' then case ${sql.ref("action")}
            when ${ControlPlaneAuditActions.connectionRegistered} then ${sql.ref("scopes")}
            when ${ControlPlaneAuditActions.connectionUpdated} then coalesce(${sql.ref("scopesAfterKey")}, ${sql.ref("scopesTo")})
            end end`.as("scopesAfter"),
        sql`case when ${sql.ref("subject")} = 'connection' and ${sql.ref("action")} = ${ControlPlaneAuditActions.connectionRegistered}
            then ${sql.ref("replacedConnectionId")} end`.as("replacedConnectionId"),
        sql`case when ${sql.ref("subject")} = 'key' then
            coalesce(${sql.ref("registeredKeyId")}, ${sql.ref("expiredKeyId")}, ${sql.ref("revokedKeyId")}) end`.as(
          "keyId",
        ),
        sql`case when ${sql.ref("subject")} = 'key' then case
            when ${sql.ref("action")} = ${ControlPlaneAuditActions.keyExpired} then 'expired'
            when ${sql.ref("action")} = ${ControlPlaneAuditActions.keyRegistered} or ${sql.ref("registeredKeyId")} is not null then 'registered'
            else 'revoked' end end`.as("keyChange"),
      ]),
    )
    .selectFrom("answered")
    .selectAll()
    .select(
      sql<number>`case ${sql.ref("subject")}
        when 'member' then case
          when ${oneOf("action", joins)} then ${sql.ref("roleAfter")} is not null
          when ${oneOf("action", ends)} then ${sql.ref("roleBefore")} is not null
          else ${sql.ref("roleBefore")} is not null and ${sql.ref("roleAfter")} is not null end
        when 'connection' then case ${sql.ref("action")}
          when ${ControlPlaneAuditActions.connectionRegistered} then ${sql.ref("scopesAfter")} is not null
          when ${ControlPlaneAuditActions.connectionRemoved} then ${sql.ref("scopesBefore")} is not null
          else ${sql.ref("scopesBefore")} is not null and ${sql.ref("scopesAfter")} is not null end
        else ${sql.ref("keyId")} is not null end`.as("recorded"),
    )
    .orderBy("occurredAt", "asc")
    .orderBy("id", "asc")
    .limit(page.limit + 1);
}

/**
 * Read one page of access changes in a window, oldest first.
 *
 * **Keyset, never offset**, ascending: the trail is appended to while it is read, and a change recorded mid-read
 * lands after the window's last page rather than pushing a row from one page onto the next.
 */
export async function accessHistory(db: AuditDatabase, filter: AccessHistoryFilter): Promise<AccessHistoryPage> {
  const limit = pageLimit(filter.limit);
  const position = keysetPosition(decodeCursor(filter.cursor));
  const rows = await accessHistoryStatement(db, filter, { position, limit }).execute();
  const decoded = rows.map((row) => AccessHistoryRow.parse(row));
  const page = toPage(decoded, limit, (row) => ({ sort: row.occurredAt.getTime(), id: row.id }));
  return { changes: page.items, nextCursor: page.nextCursor };
}
