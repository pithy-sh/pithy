// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * **The audit trail's hash chain (#822): its canonical form, its commitments, and its verifier.**
 *
 * Every event `@pithy-sh/audit` records after the upgrade carries the hash of the event before it in its tenant's
 * chain, computed over a canonical serialization. Editing, deleting or inserting a row then breaks a link, and a
 * chain rewritten end to end is caught against a checkpoint written outside the database.
 *
 * **It lives in core, not in the audit package**, because three readers need the same bytes: the recorder that
 * writes a link, the Worker's verify read, and `pithy audit verify`, which an auditor runs on an export with no
 * project and no `@pithy-sh/audit` installed. A second copy of the canonical form is a second definition of the
 * evidence, and the first time they differ every export reads as tampered.
 *
 * **Personal fields are committed, not included.** An event's hash covers a salted hash of its IP, user-agent and
 * metadata rather than the values, so an export that leaves them out still verifies. The salt is per event and
 * travels only with the values, so a commitment cannot be reversed by hashing every IPv4 address.
 *
 * **Nothing is signed.** The chain proves the trail is whole against its checkpoints; it adds no key and no way
 * to change the trail.
 */

/** The canonical form's version, the first element of every serialization. A new form is a new string. */
export const AUDIT_CHAIN_FORMAT = "pithy-audit-chain/1";

/** A lowercase hex SHA-256 digest. */
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "A SHA-256 digest is 64 lowercase hex characters.")
  .describe("A SHA-256 digest, 64 lowercase hex characters.");

/**
 * Every field of an event its hash covers, as the row stores it. Loose strings, never the taxonomy's enums: a
 * verifier reads an export somebody may have altered, and an altered value must reach the hash check and be
 * named as a break rather than fail to parse.
 */
export const ChainedEventFields = z
  .object({
    eventId: z.string().describe("The event's stable public id."),
    occurredAt: z.number().int().describe("When it happened, ms since the epoch, exactly as stored."),
    action: z.string().describe("The `domain/reason` action code."),
    outcome: z.string().describe("Whether it succeeded, failed, or was denied."),
    severity: z.string().describe("How serious it is."),
    actorType: z.string().describe("The kind of principal that acted."),
    actorId: z.string().nullable().describe("The acting principal's id, or null."),
    actorKind: z.string().nullable().describe("For a control-plane actor, the kind of client, or null."),
    sessionId: z.string().nullable().describe("The session the action belongs to, or null."),
    resourceType: z.string().nullable().describe("The kind of thing acted on, or null."),
    resourceId: z.string().nullable().describe("The thing acted on, or null."),
    requestId: z.string().nullable().describe("The request correlation id, or null."),
    tenant: z
      .string()
      .nullable()
      .describe("The tenant whose chain this event is in, or null for the untenanted chain."),
    project: z.string().nullable().describe("The project the recorder stamped, or null."),
    environment: z.string().nullable().describe("The environment the recorder stamped, or null."),
    worker: z.string().nullable().describe("The Worker that recorded it, or null."),
    version: z.string().nullable().describe("The Cloudflare build id that recorded it, or null."),
    ipCommitment: Sha256Hex.nullable().describe("The salted hash of the client IP, or null when there was none."),
    userAgentCommitment: Sha256Hex.nullable().describe(
      "The salted hash of the user-agent, or null when there was none.",
    ),
    metadataCommitment: Sha256Hex.nullable().describe(
      "The salted hash of the metadata's stored JSON text, or null when there was none.",
    ),
  })
  .describe("Every field of an audit event its chain hash covers, personal values committed by hash.");
export type ChainedEventFields = z.infer<typeof ChainedEventFields>;

/** One event's place in its chain: its position and the hash of the event before it. */
export interface ChainPosition {
  /** The 1-based position in the tenant's chain. */
  seq: number;
  /** The previous event's hash, or null for the first event. */
  prev: string | null;
}

/** A link a range starts from or ends at: a position and the hash of the event there. */
export const ChainLink = z
  .object({
    seq: z.number().int().min(1).describe("The 1-based position in the tenant's chain."),
    hash: Sha256Hex.describe("The hash of the event at that position."),
  })
  .describe("One position in a tenant's chain and the hash of the event there.");
export type ChainLink = z.infer<typeof ChainLink>;

/**
 * One chained event as an export carries it: the hashed fields, its link, and — only with the detail scope — the
 * personal values and the salt their commitments were made under.
 */
export const ChainedEvent = ChainedEventFields.extend({
  seq: z.number().int().min(1).describe("The 1-based position in the tenant's chain."),
  prev: Sha256Hex.nullable().describe("The hash of the event before it, or null for the first event."),
  hash: Sha256Hex.describe("This event's hash, over its canonical serialization."),
  salt: z
    .string()
    .optional()
    .describe("The per-event salt the commitments were made under. Present only with the personal values."),
  ip: z.string().nullable().optional().describe("The client IP. Present only with the detail scope."),
  userAgent: z.string().nullable().optional().describe("The user-agent. Present only with the detail scope."),
  metadata: z
    .string()
    .nullable()
    .optional()
    .describe("The metadata's stored JSON text, byte for byte. Present only with the detail scope."),
}).describe("One chained audit event as an export carries it.");
export type ChainedEvent = z.infer<typeof ChainedEvent>;

/** The format string of a checkpoint object. */
export const AUDIT_CHECKPOINT_FORMAT = "pithy-audit-checkpoint/1";

/** One checkpoint: a tenant chain's length and head, written outside the database on a schedule. */
export const AuditCheckpoint = z
  .object({
    format: z.literal(AUDIT_CHECKPOINT_FORMAT).describe("The checkpoint format."),
    tenant: z.string().nullable().describe("The tenant whose chain this is, or null for the untenanted chain."),
    count: z.number().int().min(1).describe("How many events the chain held: the head's position."),
    head: Sha256Hex.describe("The hash of the event at that position."),
    takenAt: z.iso.datetime().describe("When the checkpoint was written, ISO-8601."),
  })
  .describe("A tenant chain's length and head, written to append-only object storage on a schedule.");
export type AuditCheckpoint = z.infer<typeof AuditCheckpoint>;

/** The format string of a tombstone object. */
export const AUDIT_TOMBSTONE_FORMAT = "pithy-audit-tombstone/1";

/**
 * A pruned run of one chain: which positions the retention prune removed, the link before them, and the hashes at
 * either end. Written to the checkpoint bucket before the rows are deleted, never overwritten, so a verify bridges
 * the gap from the event before it to the event after it and reads the chain as whole across it.
 */
export const AuditTombstone = z
  .object({
    format: z.literal(AUDIT_TOMBSTONE_FORMAT).describe("The tombstone format."),
    tenant: z.string().nullable().describe("The tenant whose chain was pruned, or null for the untenanted chain."),
    fromSeq: z.number().int().min(1).describe("The first position the prune removed."),
    throughSeq: z.number().int().min(1).describe("The last position the prune removed."),
    count: z.number().int().min(1).describe("How many events the prune removed: every position from first to last."),
    prior: Sha256Hex.nullable().describe(
      "The hash of the event before the first one removed, or null when the run began the chain.",
    ),
    first: Sha256Hex.describe("The hash of the first event removed."),
    last: Sha256Hex.describe("The hash of the last event removed, which the event after the gap names as its link."),
    prunedAt: z.iso.datetime().describe("When the run was pruned, ISO-8601."),
  })
  .describe("A run of a tenant chain the retention prune removed, written to append-only object storage.");
export type AuditTombstone = z.infer<typeof AuditTombstone>;

/** The format string of an export document. */
export const AUDIT_EXPORT_FORMAT = "pithy-audit-export/1";

/** An export: one tenant's events in a range, the link before it, and the checkpoints covering it. */
export const AuditChainExport = z
  .object({
    format: z.literal(AUDIT_EXPORT_FORMAT).describe("The export format."),
    chain: z.literal(AUDIT_CHAIN_FORMAT).describe("The canonical form every hash in it was computed over."),
    tenant: z.string().nullable().describe("The tenant whose chain this is, or null for the untenanted chain."),
    since: z.iso.datetime().nullable().describe("The range's inclusive start as asked, or null for the chain's start."),
    until: z.iso.datetime().nullable().describe("The range's inclusive end as asked, or null for the chain's head."),
    exportedAt: z.iso.datetime().describe("When the export was taken."),
    detail: z
      .boolean()
      .describe("Whether the personal values travel with their commitments. Only with `audit:events:read_detail`."),
    prior: ChainLink.nullable().describe("The link before the first event, or null when the range starts the chain."),
    events: z.array(ChainedEvent).describe("The range's chained events, in chain order."),
    checkpoints: z.array(AuditCheckpoint).describe("Every checkpoint covering the range, and the latest one after it."),
    tombstones: z
      .array(AuditTombstone)
      .optional()
      .describe(
        "Every pruned run of the chain, so a verify bridges each gap the retention prune left. Absent from a Worker that has never pruned one.",
      ),
    complete: z
      .boolean()
      .describe("Whether the events run to the chain's head, so a checkpoint past the last event is a truncation."),
    beforeChain: z
      .number()
      .int()
      .nonnegative()
      .describe("How many of the tenant's events in the range were written before the chain, and are not in it."),
    outsideChain: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "How many rows in the range carry no chain though written after it began — an older recorder's during an upgrade or a rollback. Not in the chain, and not a break.",
      ),
    nextCursor: z.string().nullable().describe("Where the next page resumes, or null at the end of the range."),
  })
  .describe("One tenant's chained audit events over a range, verifiable offline against its checkpoints.");
export type AuditChainExport = z.infer<typeof AuditChainExport>;

/** Why a chain is not whole. */
export const ChainBreakReason = z
  .enum(["edited", "commitment", "missing", "inserted", "unlinked", "checkpoint", "truncated"])
  .describe(
    "`edited` — the event's hash does not match its fields. `commitment` — a personal value does not match its commitment. `missing` — events before it are gone. `inserted` — it is not where the chain says it should be. `unlinked` — it does not name the event before it. `checkpoint` — its hash differs from the checkpoint at its position. `truncated` — the chain ends before a checkpoint says it reached.",
  );
export type ChainBreakReason = z.infer<typeof ChainBreakReason>;

/** The first place a chain is not whole. */
export const ChainBreak = z
  .object({
    eventId: z
      .string()
      .nullable()
      .describe("The event at the break, or null where the break is an absence the trail no longer holds."),
    position: z.number().int().min(1).describe("The position in the tenant's chain where the break is."),
    reason: ChainBreakReason,
    detail: z.string().describe("The break in one sentence."),
  })
  .describe("The first break in a chain: which event, at which position, and why.");
export type ChainBreak = z.infer<typeof ChainBreak>;

/** The canonical serialization: a JSON array in one fixed order, so no key order or whitespace can vary it. */
export function canonicalEvent(position: ChainPosition, fields: ChainedEventFields): string {
  return JSON.stringify([
    AUDIT_CHAIN_FORMAT,
    position.seq,
    position.prev,
    fields.eventId,
    fields.occurredAt,
    fields.action,
    fields.outcome,
    fields.severity,
    fields.actorType,
    fields.actorId,
    fields.actorKind,
    fields.sessionId,
    fields.resourceType,
    fields.resourceId,
    fields.requestId,
    fields.tenant,
    fields.project,
    fields.environment,
    fields.worker,
    fields.version,
    fields.ipCommitment,
    fields.userAgentCommitment,
    fields.metadataCommitment,
  ]);
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A fresh per-event salt: 16 random bytes, hex. */
export function newChainSalt(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The salted commitment to one personal value, or null when there is no value. */
export async function commitment(salt: string, value: string | null): Promise<string | null> {
  return value === null ? null : sha256Hex(JSON.stringify([salt, value]));
}

/** An event's chain hash: SHA-256 over its canonical serialization. */
export async function chainHash(position: ChainPosition, fields: ChainedEventFields): Promise<string> {
  return sha256Hex(canonicalEvent(position, fields));
}

/** The hashed fields of an exported event, without its link or its personal values. */
function hashedFields(event: ChainedEvent): ChainedEventFields {
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    action: event.action,
    outcome: event.outcome,
    severity: event.severity,
    actorType: event.actorType,
    actorId: event.actorId,
    actorKind: event.actorKind,
    sessionId: event.sessionId,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    requestId: event.requestId,
    tenant: event.tenant,
    project: event.project,
    environment: event.environment,
    worker: event.worker,
    version: event.version,
    ipCommitment: event.ipCommitment,
    userAgentCommitment: event.userAgentCommitment,
    metadataCommitment: event.metadataCommitment,
  };
}

/** The personal value an event carries for one commitment, when it carries the values at all. */
const COMMITTED = [
  ["ip", "ipCommitment", "IP"],
  ["userAgent", "userAgentCommitment", "user-agent"],
  ["metadata", "metadataCommitment", "metadata"],
] as const;

/** What {@link chainVerifier} needs: whose chain, where the range starts, and the checkpoints to hold it to. */
export interface ChainVerifierOptions {
  /** The tenant whose chain is walked. An event from any other chain is a break. */
  tenant: string | null;
  /** The link before the first event, or null when the walk starts the chain. */
  prior: ChainLink | null;
  /** Checkpoints to hold the walk to. Another tenant's are ignored. */
  checkpoints: readonly AuditCheckpoint[];
  /** The chain's pruned runs, each bridged where the walk reaches it. Another tenant's are ignored. */
  tombstones?: readonly AuditTombstone[];
  /**
   * Whether every event must carry its personal values and their salt, so every commitment is checked: an export
   * taken with the detail says it does. Omitted, an event without them is one whose commitments stand unopened.
   */
  values?: boolean;
}

/** A walk over one chain, fed in order, page by page. */
export interface ChainVerifier {
  /** Check the next event. Returns the break it is, or null. Stop at the first break. */
  push(event: ChainedEvent): Promise<ChainBreak | null>;
  /** End the walk. With `complete`, a checkpoint past the last event is a truncation. */
  finish(complete: boolean): ChainBreak | null;
  /** The last link walked, or the prior when none was. */
  readonly head: ChainLink | null;
  /** How many events were checked. */
  readonly checked: number;
  /** How many of the tenant's checkpoints applied. */
  readonly checkpoints: number;
  /** How many events the walk crossed as pruned, bridged by a tombstone rather than checked. */
  readonly pruned: number;
}

/**
 * Walk one tenant's chain in order. Each event is checked for its tenant, its position, its link, its commitments
 * (when it carries its values), its hash, and the checkpoint at its position — in that order, so the reason names
 * the first thing wrong.
 */
export function chainVerifier(options: ChainVerifierOptions): ChainVerifier {
  const own = options.checkpoints.filter((checkpoint) => checkpoint.tenant === options.tenant);
  const byCount = new Map<number, AuditCheckpoint>();
  for (const checkpoint of own) byCount.set(checkpoint.count, checkpoint);
  const tombstones = (options.tombstones ?? []).filter((tombstone) => tombstone.tenant === options.tenant);
  let head = options.prior;
  let checked = 0;
  let pruned = 0;

  /**
   * Cross every pruned run that starts where the walk stands and links to its head, before the event at `seq`. A
   * tombstone that does not link, or that a checkpoint at either end disagrees with, bridges nothing.
   */
  const bridge = (seq: number): ChainBreak | null => {
    for (;;) {
      const expected = (head?.seq ?? 0) + 1;
      if (seq <= expected) return null;
      const run = tombstones.find(
        (tombstone) =>
          tombstone.fromSeq === expected &&
          tombstone.throughSeq < seq &&
          tombstone.count === tombstone.throughSeq - tombstone.fromSeq + 1 &&
          tombstone.prior === (head?.hash ?? null),
      );
      if (!run) return null;
      for (const [position, hash] of [
        [run.fromSeq, run.first],
        [run.throughSeq, run.last],
      ] as const) {
        const checkpoint = byCount.get(position);
        if (checkpoint && checkpoint.head !== hash) {
          return {
            eventId: null,
            position,
            reason: "checkpoint",
            detail: `The pruned run ${run.fromSeq} to ${run.throughSeq} differs from the checkpoint taken at ${checkpoint.takenAt}.`,
          };
        }
      }
      head = { seq: run.throughSeq, hash: run.last };
      pruned += run.count;
    }
  };

  return {
    get head() {
      return head;
    },
    get checked() {
      return checked;
    },
    get checkpoints() {
      return own.length;
    },
    get pruned() {
      return pruned;
    },
    async push(event) {
      if (event.tenant === options.tenant) {
        const bridged = bridge(event.seq);
        if (bridged) return bridged;
      }
      const expected = (head?.seq ?? 0) + 1;
      if (event.tenant !== options.tenant) {
        return {
          eventId: event.eventId,
          position: expected,
          reason: "inserted",
          detail: `Event ${event.eventId} belongs to another tenant's chain.`,
        };
      }
      if (event.seq > expected) {
        return {
          eventId: event.eventId,
          position: expected,
          reason: "missing",
          detail:
            event.seq - expected === 1
              ? `The event at position ${expected} is missing.`
              : `The events at positions ${expected} to ${event.seq - 1} are missing.`,
        };
      }
      if (event.seq < expected) {
        return {
          eventId: event.eventId,
          position: expected,
          reason: "inserted",
          detail: `Event ${event.eventId} claims position ${event.seq}, which the chain has already passed.`,
        };
      }
      if (event.prev !== (head?.hash ?? null)) {
        return {
          eventId: event.eventId,
          position: event.seq,
          reason: "unlinked",
          detail: `Event ${event.eventId} does not name the event before it.`,
        };
      }
      // A value is not in the hash, only its commitment is, so a value no salt opens is a value nothing checked.
      if (event.salt === undefined) {
        const carried = COMMITTED.find(([valueKey]) => event[valueKey] !== undefined);
        if (carried || options.values) {
          return {
            eventId: event.eventId,
            position: event.seq,
            reason: "commitment",
            detail: carried
              ? `Event ${event.eventId} carries its ${carried[2]} without the salt its commitment needs.`
              : `Event ${event.eventId} carries no salt, though the export says it carries the values.`,
          };
        }
      } else {
        for (const [valueKey, commitmentKey, label] of COMMITTED) {
          const value = event[valueKey];
          if (value === undefined) {
            if (!options.values) continue;
            return {
              eventId: event.eventId,
              position: event.seq,
              reason: "commitment",
              detail: `Event ${event.eventId} carries no ${label}, though the export says it carries the values.`,
            };
          }
          if ((await commitment(event.salt, value)) !== event[commitmentKey]) {
            return {
              eventId: event.eventId,
              position: event.seq,
              reason: "commitment",
              detail: `Event ${event.eventId}'s ${label} does not match its commitment.`,
            };
          }
        }
      }
      if ((await chainHash({ seq: event.seq, prev: event.prev }, hashedFields(event))) !== event.hash) {
        return {
          eventId: event.eventId,
          position: event.seq,
          reason: "edited",
          detail: `Event ${event.eventId} does not hash to the value it carries.`,
        };
      }
      const checkpoint = byCount.get(event.seq);
      if (checkpoint && checkpoint.head !== event.hash) {
        return {
          eventId: event.eventId,
          position: event.seq,
          reason: "checkpoint",
          detail: `Event ${event.eventId} differs from the checkpoint taken at ${checkpoint.takenAt}.`,
        };
      }
      head = { seq: event.seq, hash: event.hash };
      checked++;
      return null;
    },
    finish(complete) {
      if (!complete) return null;
      const end = head?.seq ?? 0;
      const beyond = own.filter((checkpoint) => checkpoint.count > end).sort((a, b) => b.count - a.count)[0];
      if (!beyond) return null;
      return {
        eventId: null,
        position: end + 1,
        reason: "truncated",
        detail: `The chain ends at position ${end}, and the checkpoint taken at ${beyond.takenAt} recorded ${beyond.count}.`,
      };
    },
  };
}

/** What verifying one export found. */
export interface ChainVerification {
  /** Whether the export's chain is whole. */
  intact: boolean;
  /** How many events were checked before the first break, or all of them. */
  checked: number;
  /** How many of the tenant's checkpoints the export carried. */
  checkpoints: number;
  /** How many events the walk crossed as pruned, each run bridged by its tombstone. */
  pruned: number;
  /** The first break, or null. */
  break: ChainBreak | null;
}

/** Verify an export offline: every link, every commitment it can check, every checkpoint it carries. */
export async function verifyChainExport(document: AuditChainExport): Promise<ChainVerification> {
  const verifier = chainVerifier({
    tenant: document.tenant,
    prior: document.prior,
    checkpoints: document.checkpoints,
    tombstones: document.tombstones ?? [],
    values: document.detail,
  });
  for (const event of document.events) {
    const found = await verifier.push(event);
    if (found) {
      return {
        intact: false,
        checked: verifier.checked,
        checkpoints: verifier.checkpoints,
        pruned: verifier.pruned,
        break: found,
      };
    }
  }
  const truncated = verifier.finish(document.complete);
  return {
    intact: truncated === null,
    checked: verifier.checked,
    checkpoints: verifier.checkpoints,
    pruned: verifier.pruned,
    break: truncated,
  };
}
