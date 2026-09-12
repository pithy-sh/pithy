// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEventInput, AuditOutcome, AuditSeverity } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { z } from "zod";
import type { OrganizationAuditAction } from "./actions";

/**
 * The one writer of this capability's audit trail.
 *
 * **This is the file that makes "every administrative action is audited" true rather than intended.**
 * `./actions.ts` is the register; this is the emitter, and it is a single function so that a membership
 * write cannot be added without either calling it or visibly not calling it.
 *
 * ## Four rules, and none of them survives being a review comment
 *
 * **The tenant is on every event.** Core's seam carries `tenant` for exactly this — the recorder stamps
 * `project`, `environment` and `worker` from the Worker's own vars, which read the same on every row a
 * multi-tenant Worker writes, so without it a trail over a multi-tenant product cannot be read per
 * customer at all. It is stamped here, at write time, because the tenant of an action is a fact *at the
 * time of the action* while membership is a fact *now*: deriving one from the other later moves a year
 * of history between tenants every time somebody joins or leaves.
 *
 * **The actor and the tenant arrive as one object.** {@link recordOrganizationAction} takes an
 * {@link OrganizationActor} rather than an actor id beside an organization id, so there is no call shape
 * that records one person's action inside another person's account. That pairing is what a trail is for,
 * and two adjacent string arguments are two a hand can transpose — transposed, they typecheck.
 *
 * **An address is never a fact.** These events are *about* email addresses, so a copy of one reaches an
 * append-only table by the ordinary route: a field that seemed harmless. {@link AuditFact} refuses
 * anything address-shaped by value, and a refused fact leaves its **name** behind in `factsRejected` —
 * a visible mistake in the row instead of a silent disclosure. The resource is a pointer of ours: an
 * invitation id, a membership id, an organization id, meaningless outside this database.
 *
 * **Recording never breaks the action.** `emit` is non-fatal by contract and this is non-fatal again on
 * top of it, because by the time an event is recorded the thing it records has already happened. A
 * failed audit write must not turn a completed removal into a 500 somebody retries — and retrying a
 * removal that already happened is how one person gets removed twice and a second one not at all.
 */

/** How long a fact's text may be before it stops being a fact and starts being a payload. */
const FACT_MAX_LENGTH = 200;

/** Anything shaped like an address. Content, not a pointer — and the realistic way content creeps in. */
const LOOKS_LIKE_AN_ADDRESS = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * One value a fact may carry: a short scalar and nothing else.
 *
 * No objects, no arrays, no long strings. Every one of those is a container, and a container is how a
 * person's row reaches the trail — never by somebody deciding to store it, always by a field that
 * seemed harmless. A count, a role name, an id, a boolean: that is the whole vocabulary.
 */
export const AuditFact = z
  .union([
    z
      .string()
      .max(FACT_MAX_LENGTH)
      .refine((value) => !LOOKS_LIKE_AN_ADDRESS.test(value), "An address is content; record the id instead."),
    z.number(),
    z.boolean(),
    z.null(),
  ])
  .describe(
    "One value attached to an audit event: a short string carrying no address, at most 200 characters; a number; a boolean; or null. Deliberately not an object or an array — a container is how somebody's record reaches the trail.",
  );
export type AuditFact = z.output<typeof AuditFact>;

/**
 * Who acted, and inside which organization.
 *
 * **Structural on purpose.** The resolved membership this capability puts on `c.var.acting` satisfies it
 * without being named here, and so does the founder of an account nobody is yet a member of — which is
 * the one act taken by somebody who has no acting context at all, because the membership that would
 * have given them one is written by the same statement as the organization.
 */
export interface OrganizationActor {
  /** The organization the action was taken in. Becomes the event's `tenant`, and is never derived later. */
  readonly organizationId: string;
  /** The person who took it. From the session, never from a request field. */
  readonly userId: string;
}

/** What an event names: a kind of thing of ours, and its id. Never the row itself. */
export interface OrganizationAuditResource {
  /** `organization`, `membership`, or `invitation`. Ours, all three. */
  readonly type: "organization" | "membership" | "invitation";
  /** Its id. A pointer into the adopter's own database, useless anywhere else. */
  readonly id: string;
}

/** One administrative act, as a caller describes it. */
export interface OrganizationAuditEvent {
  /** What happened, from `./actions.ts`. Closed, so a typo is a compile error rather than a lost row. */
  readonly action: OrganizationAuditAction;
  /** Who did it and where. The actor and the tenant come from here and from nowhere else. */
  readonly actor: OrganizationActor;
  /** What it was done to. */
  readonly resource: OrganizationAuditResource;
  /**
   * Structured detail: roles, counts, whether an offer replaced another.
   *
   * Short scalars only, held to {@link AuditFact} value by value. A caller that passes `{ email }` leaves
   * `factsRejected: ["email"]` in the row rather than the address.
   */
  readonly facts?: Readonly<Record<string, unknown>>;
  /**
   * The session the action was taken from, tying a chain of acts together.
   *
   * From `c.var.auth`, not from the acting selection: the session is who is signed in, and the selection
   * is what they are entitled to here. Absent where there is no session — an invitation accepted by a
   * flow that has not yet made one, a provisioning call from a seed.
   */
  readonly sessionId?: string | null;
  /** The client IP, for correlation. Never derived from a header a caller can spoof without saying so. */
  readonly ip?: string | null;
  /** The client user-agent, for correlation. */
  readonly userAgent?: string | null;
  /** The request correlation id, tying this event to one request. */
  readonly requestId?: string | null;
  /**
   * How it turned out, when `success` is not the answer.
   *
   * A refusal is worth recording where the refusal is the interesting event — the last administrator
   * somebody tried to remove, an invitation redeemed by the wrong address. Both are what an intrusion
   * looks like from inside the trail, and neither leaves a row if only successes are written.
   */
  readonly outcome?: AuditOutcome;
  /**
   * How loudly the trail should say it, when `info` is not the right answer.
   *
   * Absent means `info`, which is what every routine membership write wants. Ownership changing hands is
   * the case that earns more: it succeeded, and a reader scanning for what went quiet before an incident
   * should find it above the routine.
   */
  readonly severity?: AuditSeverity;
}

/** Pull request correlation off the request's own headers. No PII beyond ip and user-agent. */
export function correlation(headers: Headers | undefined): { ip?: string; userAgent?: string } {
  return {
    ip: headers?.get("cf-connecting-ip") ?? undefined,
    userAgent: headers?.get("user-agent") ?? undefined,
  };
}

/** What survived {@link AuditFact}, and the names of what did not. */
interface CheckedFacts {
  /** The facts that may be written, by name. */
  readonly kept: Record<string, AuditFact>;
  /** The names of the facts refused. The row says a mistake was made without repeating it. */
  readonly rejected: string[];
}

/**
 * Hold each fact to {@link AuditFact}, by name.
 *
 * **By name and not as a whole object**, because one refused field must not silently drop the ten beside
 * it: a row missing the count it was supposed to carry is a row nobody notices is wrong.
 */
function checkFacts(facts: Readonly<Record<string, unknown>> | undefined): CheckedFacts | undefined {
  if (facts === undefined) return undefined;
  const kept: Record<string, AuditFact> = {};
  const rejected: string[] = [];
  for (const [name, value] of Object.entries(facts)) {
    const checked = AuditFact.safeParse(value);
    if (checked.success) kept[name] = checked.data;
    else rejected.push(name);
  }
  return { kept, rejected };
}

/**
 * Record one administrative act against the organization it was taken in.
 *
 * Never throws and never rejects. `emit` is non-fatal by contract; this swallows anything that gets past
 * that anyway, because a recorder an adopter composed themselves is not bound by a contract this package
 * wrote.
 */
export async function recordOrganizationAction(emit: AuditEmit, event: OrganizationAuditEvent): Promise<void> {
  const facts = checkFacts(event.facts);
  const metadata: Record<string, unknown> | undefined = facts
    ? { ...facts.kept, ...(facts.rejected.length > 0 ? { factsRejected: facts.rejected } : {}) }
    : undefined;

  const input: AuditEventInput = {
    action: event.action,
    outcome: event.outcome ?? "success",
    actorType: "user",
    actorId: event.actor.userId,
    // The tenant, stamped from the resolved actor. Never from a request field, and never derived at read.
    tenant: event.actor.organizationId,
    resourceType: event.resource.type,
    resourceId: event.resource.id,
    sessionId: event.sessionId ?? undefined,
    ip: event.ip ?? undefined,
    userAgent: event.userAgent ?? undefined,
    requestId: event.requestId ?? undefined,
    ...(event.severity ? { severity: event.severity } : {}),
    ...(metadata ? { metadata } : {}),
  };

  try {
    await emit(input);
  } catch {
    // An audit write is non-fatal by contract. The act it records already happened.
  }
}
