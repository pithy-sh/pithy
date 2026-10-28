// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { AuditActorType, AuditMetadata, AuditOutcome, AuditSeverity } from "@pithy-sh/core/src/audit/auditEvent";
import { AuditChainExport, ChainBreak, ChainLink } from "@pithy-sh/core/src/audit/chain";
import { ControlPlaneActorKind } from "@pithy-sh/core/src/controlPlane/data/connection";
import { z } from "zod";

/**
 * What the audit routes return, as Zod objects a management client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves of the
 * contract are runtime values for the same reason: a client reading a customer's Worker is crossing a
 * trust boundary in *both* directions, and a TypeScript interface is erased before it can help — it
 * cannot check a response, so every client that had only an interface hand-wrote a mirror of it, and
 * the mirror drifted the first time a field landed here.
 *
 * **No codecs, and no transform anywhere in this file.** These schemas describe JSON on the wire, so
 * parsing one must hand back exactly what went in — that is what lets `responses.test.ts` compare the
 * parsed value with the projection's output and fail on a field either side forgot. A `SQLiteDate`
 * here would decode an ISO string into a `Date` and quietly make that comparison meaningless.
 *
 * The projections that fill these live in `views.ts`, which documents *why* each field is in one view
 * and not the other. This file is the shape; that file is the argument.
 *
 * **A field added here later is `.optional()`, not merely `.nullable()`.** This module is read across a
 * version boundary — a management client validates a response with this schema against a customer's
 * Worker at whatever kit version it is on — so an additive required key fails `safeParse` for everyone
 * below that release and takes the whole pane with it (#450). Absent then means *this Worker cannot
 * say*, which is a different fact from `null`.
 */

/** Where a page resumes, or the end of the list. */
const NextCursor = z
  .string()
  .nullable()
  .describe("Where the next page resumes. Null at the end of the list. Opaque — pass it back verbatim.");

/**
 * One event as the listing shows it — everything but the network identifiers and the metadata bag.
 *
 * The type is derived from this object rather than declared beside it, so a field cannot exist in one
 * and not the other.
 */
export const AuditEventView = z
  .object({
    eventId: z.string().describe("The event's stable public id (the recorder's UUID)."),
    occurredAt: z.iso.datetime().describe("When it happened, ISO-8601."),
    action: z.string().describe("The `domain/reason` action code."),
    outcome: AuditOutcome.describe("Whether it succeeded, failed, or was denied."),
    severity: AuditSeverity.describe("How serious it is, orthogonal to the outcome."),
    actorType: AuditActorType.describe("The kind of principal that acted."),
    actorId: z.string().nullable().describe("The acting principal's stable id, or null."),
    // Added (#721), so `.optional()` too: a client reading an older Worker receives no such field.
    actorKind: ControlPlaneActorKind.nullable()
      .optional()
      .describe(
        "For a `control-plane` actor, which kind of management client acted — `agent`, `dashboard` or `script` — or null. Absent from a Worker older than the field.",
      ),
    sessionId: z.string().nullable().describe("The session the action belongs to — a row id, never a token — or null."),
    resourceType: z.string().nullable().describe("The kind of thing acted on, or null."),
    resourceId: z.string().nullable().describe("The thing acted on, or null."),
    requestId: z.string().nullable().describe("The request correlation id, or null."),
    project: z.string().nullable().describe("The project the recorder stamped, or null when it recorded none."),
    environment: z.string().nullable().describe("The environment the recording Worker served, or null."),
    worker: z.string().nullable().describe("The `apps/<name>` Worker that recorded it, or null for a CLI action."),
    version: z.string().nullable().describe("The Cloudflare build id that recorded it, or null."),
    tenant: z
      .string()
      .nullable()
      .describe("The tenant the action was taken for, or null when it was not tenant-scoped."),
    // Added (#822), so `.optional()` too: a client reading an older Worker receives no such field.
    chainSeq: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        "The event's position in its tenant's hash chain, or null when it was written before the chain began and is marked so. Absent from a Worker older than the chain.",
      ),
  })
  .describe("One audit event as the listing shows it. No client IP, no user-agent, no metadata bag.");
export type AuditEventView = z.output<typeof AuditEventView>;

/**
 * One event in full — the listing view plus the three fields the detail scope exists to separate.
 *
 * Re-described after `.extend()`: extending builds a new schema, and a description does not follow it.
 */
export const AuditEventDetailView = AuditEventView.extend({
  ip: z
    .string()
    .nullable()
    .describe("The client IP the request came from, or null. Personal data; behind its own scope."),
  userAgent: z
    .string()
    .nullable()
    .describe("The client user-agent, or null. A device fingerprint; behind its own scope."),
  metadata: AuditMetadata.nullable().describe(
    "The capability's own structured detail, or null. Arbitrary payload; behind its own scope.",
  ),
}).describe("One audit event in full — the listing view plus the client IP, user-agent, and metadata bag.");
export type AuditEventDetailView = z.output<typeof AuditEventDetailView>;

/** `GET {base}/events`. */
export const AuditEventsResponse = z
  .object({
    events: z.array(AuditEventView).describe("The page, newest first."),
    nextCursor: NextCursor,
  })
  .describe("A filtered, resumable page of the audit trail.");
export type AuditEventsResponse = z.output<typeof AuditEventsResponse>;

/** `GET {base}/events/:eventId`. */
export const AuditEventResponse = z
  .object({ event: AuditEventDetailView.describe("The event, with the fields the detail scope gates.") })
  .describe("One audit event in full.");
export type AuditEventResponse = z.output<typeof AuditEventResponse>;

/**
 * Whether a change's event carried its before and after (#831).
 *
 * `not_recorded` is an event written before its emitter recorded the detail — a role change from before
 * `previousRole`, an update that moved no scope from before every update carried the grant. Its unknown values are
 * null, and this says they are unknown rather than none: the reader is told, never handed a guess.
 */
const ChangeDetail = z
  .enum(["recorded", "not_recorded"])
  .describe(
    "Whether the event recorded this change's before and after. `not_recorded` means a null before or after is unknown, not none: the event predates the emitter recording it.",
  );

/** What every access change carries: when, who, and from which code. */
const AccessChangeBase = z.object({
  eventId: z.string().describe("The event the change was read from — the listing's `eventId`."),
  occurredAt: z.iso.datetime().describe("When it changed, ISO-8601."),
  action: z.string().describe("The `domain/reason` code it was recorded under."),
  actorType: AuditActorType.describe("The kind of principal that made the change."),
  actorId: z.string().nullable().describe("The principal that made the change, or null."),
  actorKind: ControlPlaneActorKind.nullable().describe(
    "For a `control-plane` actor, which kind of management client made the change, or null.",
  ),
  detail: ChangeDetail,
});

/** A membership joined, changed role, or ended. */
export const MemberAccessChange = AccessChangeBase.extend({
  subject: z.literal("member").describe("A membership changed."),
  organizationId: z.string().nullable().describe("The organization the membership is in."),
  membershipId: z.string().nullable().describe("The membership that changed."),
  userId: z.string().nullable().describe("Whose membership it is, or null when the event did not say."),
  roleBefore: z
    .string()
    .nullable()
    .describe("The role it held before. Null for a join, or when `detail` is `not_recorded`."),
  roleAfter: z
    .string()
    .nullable()
    .describe("The role it holds after. Null for a leave or a removal, or when `detail` is `not_recorded`."),
}).describe("A membership joined, changed role, or ended.");
export type MemberAccessChange = z.output<typeof MemberAccessChange>;

/** A control-plane connection was registered, updated, or removed. */
export const ConnectionAccessChange = AccessChangeBase.extend({
  subject: z.literal("connection").describe("A control-plane connection changed."),
  connectionId: z.string().nullable().describe("The connection that changed."),
  connectionKind: ControlPlaneActorKind.nullable().describe(
    "What kind of client the connection is for, or null when it was not recorded.",
  ),
  purpose: z.string().nullable().describe("What the connection is for, in its registrant's words, or null."),
  principal: z
    .string()
    .nullable()
    .describe("Who sanctioned the connection — the registering session's email address — or null."),
  scopesBefore: z
    .array(z.string().describe("A granted scope."))
    .nullable()
    .describe("The scopes it held before. Null for a registration, or when `detail` is `not_recorded`."),
  scopesAfter: z
    .array(z.string().describe("A granted scope."))
    .nullable()
    .describe("The scopes it holds after. Null for a removal, or when `detail` is `not_recorded`."),
  replacedConnectionId: z
    .string()
    .nullable()
    .describe(
      "For a registration that started over, the connection it replaced: that connection's grant ended here. Null otherwise. A start-over recorded by a current CLI also has the old connection's own removal, just before.",
    ),
}).describe("A control-plane connection was registered, updated, or removed.");
export type ConnectionAccessChange = z.output<typeof ConnectionAccessChange>;

/** A key on a connection was registered, expired, or revoked. */
export const KeyAccessChange = AccessChangeBase.extend({
  subject: z.literal("key").describe("A key on a control-plane connection changed."),
  connectionId: z.string().nullable().describe("The connection the key belongs to."),
  keyId: z.string().nullable().describe("The key's id. Never key material."),
  change: z
    .enum(["registered", "expired", "revoked"])
    .describe("What happened to it: registered, expired at the end of a rotation, or revoked."),
}).describe("A key on a control-plane connection was registered, expired, or revoked.");
export type KeyAccessChange = z.output<typeof KeyAccessChange>;

/** One access change, discriminated on what changed. */
export const AccessChangeView = z
  .discriminatedUnion("subject", [MemberAccessChange, ConnectionAccessChange, KeyAccessChange])
  .describe("One change to who can reach this environment's data, with its before and after.");
export type AccessChangeView = z.output<typeof AccessChangeView>;

/** `GET {base}/control-plane/access-history`. */
export const AccessHistoryResponse = z
  .object({
    since: z.iso.datetime().describe("The window's inclusive start, ISO-8601."),
    until: z.iso.datetime().describe("The window's inclusive end, ISO-8601 — now, when the query named none."),
    changes: z.array(AccessChangeView).describe("The page, oldest first."),
    nextCursor: NextCursor,
  })
  .describe("Every membership, connection and key change in a window, oldest first, with its before and after.");
export type AccessHistoryResponse = z.output<typeof AccessHistoryResponse>;

/**
 * One tenant, action, method, route and outcome a control-plane credential reached (#828).
 *
 * Counts, two instants, and the route. No IP, no user-agent, no metadata key beyond what the route and scope already
 * say: this is the credential's own footprint, which is why it sits behind the listing scope.
 */
export const ControlPlaneReachView = z
  .object({
    tenant: z
      .string()
      .nullable()
      .describe(
        "The tenant the calls reached, as the handler behind them recorded it in the same request. Null when the handler named none.",
      ),
    action: z
      .string()
      .describe("`controlplane/call_allowed` for admitted calls, `controlplane/call_denied` for refusals."),
    method: z.string().describe("The HTTP method called."),
    route: z
      .string()
      .describe("The declared admin route the calls matched, or the path as called when no declared route matched."),
    matched: z
      .boolean()
      .describe("Whether `route` is a declared pattern. False marks an unmatched path, which is its own row."),
    outcome: z
      .string()
      .describe(
        "The calls' outcome: `success`, or `denied` for a call a handler refused past the gate, which is counted once, as denied.",
      ),
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
        "How many distinct subjects the calls touched: distinct values of the route's subject parameter and the parameters before it, so one user read in two currencies is one subject. 0 for a route with no parameters, null for an unmatched path.",
      ),
    firstAt: z.iso.datetime().describe("When the first call landed, ISO-8601."),
    lastAt: z.iso.datetime().describe("When the last call landed, ISO-8601."),
  })
  .describe("One tenant, action, method, route and outcome one control-plane credential reached in a window.");
export type ControlPlaneReachView = z.output<typeof ControlPlaneReachView>;

/** One path a route was called with, and the subject ids it names (#828). */
export const ControlPlaneReachSubjectView = z
  .object({
    tenant: z.string().nullable().describe("The tenant the calls reached, or null when their handler named none."),
    action: z.string().describe("`controlplane/call_allowed` or `controlplane/call_denied`."),
    method: z.string().describe("The HTTP method called."),
    route: z.string().describe("The route expanded, as asked for."),
    matched: z.boolean().describe("Whether the route is a declared pattern."),
    path: z.string().describe("The path as called."),
    outcome: z.string().describe("The calls' outcome: `success` or `denied`."),
    scope: z
      .string()
      .nullable()
      .describe("The scope the calls' credential carried, refused or not. Never the scope a refusal lacked."),
    subjectId: z
      .string()
      .nullable()
      .describe(
        "Whose data the call acted on: the value of the route's last id parameter (`id`, or a name ending in `Id`), or of its last parameter when none names an id. On `/accounts/:userId/:currency/transactions` it is the user, not the currency. `params` has the rest. Null when the route declares none.",
      ),
    params: z
      .record(z.string(), z.string())
      .describe("Every parameter the route declares, with the value it took in `path`, decoded."),
    count: z.number().int().describe("How many calls to this path."),
    firstAt: z.iso.datetime().describe("When the first call to this path landed, ISO-8601."),
    lastAt: z.iso.datetime().describe("When the last call to this path landed, ISO-8601."),
  })
  .describe("One path a route was called with by one control-plane credential, and the subject ids it names.");
export type ControlPlaneReachSubjectView = z.output<typeof ControlPlaneReachSubjectView>;

/** `GET {base}/control-plane/reach`. */
export const ControlPlaneReachResponse = z
  .object({
    connectionId: z.string().describe("The connection read, as asked for."),
    keyId: z.string().nullable().describe("The key the read was narrowed to, or null for every key."),
    since: z.iso.datetime().describe("The window's inclusive start, ISO-8601."),
    until: z.iso.datetime().describe("The window's inclusive end, ISO-8601 — now, when the query named none."),
    reach: z
      .array(ControlPlaneReachView)
      .describe("One row per tenant, route, action, method and outcome reached, ordered in that order."),
    subjects: z
      .array(ControlPlaneReachSubjectView)
      .optional()
      .describe(
        "The route's subjects, one row per tenant and path called. Present only when the query asked with `subjects=true`.",
      ),
  })
  .describe("Everything one control-plane credential reached over a window, by tenant, route and outcome.");
export type ControlPlaneReachResponse = z.output<typeof ControlPlaneReachResponse>;

/**
 * One `(scope, keyId)` a control-plane connection exercised (#812).
 *
 * Counts, two instants, and the method and path of the last allowed call. No IP, no user-agent, no other metadata key:
 * this is the management client's own footprint, which is why it sits behind the listing scope.
 */
export const ControlPlaneUsageView = z
  .object({
    scope: z
      .string()
      .describe(
        "The scope exercised — what an allowed call's token carried, or what a refused call required. A scope never exercised has no row.",
      ),
    keyId: z.string().nullable().describe("The registered key that signed the calls, or null when none was recorded."),
    allowed: z.number().int().describe("How many calls under this scope and key were admitted in the window."),
    denied: z
      .number()
      .int()
      .describe(
        "How many verified calls naming this scope were refused in the window. An under-grant shows here, beside an over-grant's zero. A refusal that failed verification proves no connection and is not counted.",
      ),
    lastAllowedAt: z.iso
      .datetime()
      .nullable()
      .describe("When the last admitted call landed, ISO-8601, or null when none was admitted."),
    lastAllowedMethod: z.string().nullable().describe("The HTTP method of the last admitted call, or null."),
    lastAllowedPath: z.string().nullable().describe("The path of the last admitted call, or null."),
    lastDeniedAt: z.iso
      .datetime()
      .nullable()
      .describe("When the last refusal landed, ISO-8601, or null when none was refused."),
  })
  .describe("One scope and key a control-plane connection exercised in a window.");
export type ControlPlaneUsageView = z.output<typeof ControlPlaneUsageView>;

/** `GET {base}/control-plane/usage`. */
export const ControlPlaneUsageResponse = z
  .object({
    connectionId: z.string().describe("The connection counted, as asked for."),
    since: z.iso.datetime().describe("The window's inclusive start, ISO-8601."),
    until: z.iso.datetime().describe("The window's inclusive end, ISO-8601 — now, when the query named none."),
    usage: z.array(ControlPlaneUsageView).describe("One row per scope and key exercised, ordered by scope then key."),
    oldestEventAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "The oldest event the trail holds, for any connection, or null on an empty trail. A window starting before it was not fully covered: retention removed what came before.",
      ),
  })
  .describe("Which scopes one control-plane connection exercised and was refused, by key, over a window.");
export type ControlPlaneUsageResponse = z.output<typeof ControlPlaneUsageResponse>;

/** `GET {base}/control-plane/verify` (#822). */
export const ChainVerifyResponse = z
  .object({
    tenant: z.string().nullable().describe("The tenant whose chain was walked, or null for the untenanted chain."),
    since: z.iso
      .datetime()
      .nullable()
      .describe("The window's inclusive start as asked, or null for the chain's start."),
    until: z.iso.datetime().nullable().describe("The window's inclusive end as asked, or null for the chain's head."),
    intact: z.boolean().describe("Whether the range is whole: every link, every hash, every checkpoint covering it."),
    checked: z
      .number()
      .int()
      .nonnegative()
      .describe("How many chained events were checked before the first break, or all of them."),
    checkpoints: z.number().int().nonnegative().describe("How many checkpoints the walk was held to."),
    pruned: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "How many events the walk crossed as pruned by the retention policy, each run bridged by the tombstone written before it was deleted. Absent from a Worker that cannot prune.",
      ),
    checkpointStore: z
      .enum(["bound", "absent"])
      .describe(
        "`absent` when this Worker binds no checkpoint bucket, so the walk checked links alone: a chain rewritten end to end would read as intact.",
      ),
    beforeChain: z
      .number()
      .int()
      .nonnegative()
      .describe("How many of the tenant's events in the window were written before the chain, and so are not in it."),
    outsideChain: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "How many rows in the window carry no chain though written after it began — an older recorder's during an upgrade or a rollback. Not in the chain, and not a break: `intact` is about the chain itself.",
      ),
    break: ChainBreak.nullable().describe("The first break — its event, its position and why — or null."),
    head: ChainLink.nullable().describe("The last position the walk reached intact, or null when it reached none."),
  })
  .describe("Whether one tenant's audit chain is whole over a window, or where it first breaks.");
export type ChainVerifyResponse = z.output<typeof ChainVerifyResponse>;

/**
 * `GET {base}/control-plane/export` (#822). Core's export document, which `pithy audit verify` reads offline —
 * one schema, so what the Worker writes and what the verifier accepts cannot drift.
 */
export const ChainExportResponse = AuditChainExport.describe(
  "One page of one tenant's audit chain: canonical events, their hashes, the link before them and the checkpoints covering them.",
);
export type ChainExportResponse = z.output<typeof ChainExportResponse>;
