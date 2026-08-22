// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import { SQLiteBoolean } from "@pithy-sh/core/src/data/codecs";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { isStoreOptInUrl, type ResetPolicy, STORE_OPT_IN_HOSTS, type TesterPlatform } from "../config/config";
import { generateOptInToken } from "../crypto/token";
import { TestersCohort } from "../data/cohort";
import type { EventActor, MemberEventKind, MemberState, NudgeKind } from "../data/enums";
import { type EventMetadata, TestersEvent } from "../data/event";
import { TestersMember } from "../data/member";
import {
  TESTERS_COHORTS_TABLE,
  TESTERS_EVENTS_TABLE,
  TESTERS_MEMBERS_TABLE,
  type TestersDatabase,
} from "../data/tables";
import {
  TestersAlreadyOnRosterError,
  TestersCohortNotFoundError,
  TestersMemberNotFoundError,
  TestersRosterFullError,
  TestersWithdrawnError,
} from "../error/errors";

/**
 * Every write to the roster, and the one rule they all obey.
 *
 * **The event is written first, and the member row is a cache of it.** If the projection write fails
 * after the event lands, the roster is stale but the truth is intact and a replay repairs it. The
 * reverse ordering would lose the fact permanently while leaving a row that looks authoritative — and
 * the fact in question is the opt-in date the whole streak is measured from. So: append, then project,
 * always, and never the other way round.
 *
 * D1 has no interactive transactions through Kysely, so this is genuinely two statements rather than
 * one. That is survivable precisely because the event log is the source of truth: a replay of
 * `pithy_testers_events` reconstructs every member row from scratch, which makes the projection
 * disposable by design rather than by luck.
 */

/** The states a member may hold and still be considered on the roster. */
export const LIVE_STATES: readonly MemberState[] = ["invited", "accepted", "opted_in"];

/** What every write needs from its caller: the clock and an id source, both injected for determinism. */
export interface WriteDeps {
  readonly db: TestersDatabase;
  readonly now: Date;
  readonly newId: () => string;
}

/** Append one event. The source of truth; nothing else in this file runs before it. */
async function appendEvent(
  deps: WriteDeps,
  input: { cohortId: string; memberId: string; kind: MemberEventKind; actor: EventActor; metadata?: EventMetadata },
): Promise<void> {
  const row = TestersEvent.encode({
    // The id is assigned by SQLite; the encoded value is discarded below along with the rest of the
    // generated column, and only exists because the schema's input side declares it.
    id: 0,
    cohortId: input.cohortId,
    memberId: input.memberId,
    kind: input.kind,
    actor: input.actor,
    occurredAt: deps.now,
    metadata: input.metadata ?? {},
    createdAt: deps.now,
  });
  const { id: _generated, ...insertable } = row;
  await deps.db
    .insertInto(TESTERS_EVENTS_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
    .values(insertable as any)
    .execute();
}

/** Read one member, or raise the capability's own 404. */
export async function requireMember(db: TestersDatabase, memberId: string): Promise<TestersMember> {
  const row = await db.selectFrom(TESTERS_MEMBERS_TABLE).selectAll().where("id", "=", memberId).executeTakeFirst();
  if (!row) throw new TestersMemberNotFoundError({ detail: `no member ${memberId}` });
  return TestersMember.parse(row);
}

/** Read one member of a cohort by address, or undefined. */
export async function findMemberByEmail(
  db: TestersDatabase,
  cohortId: string,
  email: string,
): Promise<TestersMember | undefined> {
  const row = await db
    .selectFrom(TESTERS_MEMBERS_TABLE)
    .selectAll()
    .where("cohortId", "=", cohortId)
    .where("email", "=", normalizeAddress(email))
    .executeTakeFirst();
  return row ? TestersMember.parse(row) : undefined;
}

/** Patch a member row, always stamping `updatedAt`. */
async function patchMember(
  deps: WriteDeps,
  memberId: string,
  patch: Partial<Record<string, string | number | null>>,
): Promise<void> {
  await deps.db
    .updateTable(TESTERS_MEMBERS_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: the patch is a partial of the schema's z.input side.
    .set({ ...patch, updatedAt: deps.now.getTime() } as any)
    .where("id", "=", memberId)
    .execute();
}

/** What an invitation produced: the member, and whether this call created them. */
export interface InviteResult {
  readonly member: TestersMember;
  readonly created: boolean;
}

/**
 * Invite an address onto a cohort.
 *
 * Refuses an address already on the roster in a live state rather than quietly resetting it. Swallowing
 * that would be worse than it sounds: re-inviting an opted-in tester and overwriting `invitedAt` would
 * silently move the date their streak is measured from, which is the one number the whole capability
 * exists to get right. The caller either meant `resend` — which preserves the history — or is making a
 * mistake worth being told about.
 *
 * A previously removed or lapsed member is revived instead, keeping their id so their event history
 * stays attached to one person rather than fragmenting across two rows.
 */
export async function inviteMember(
  deps: WriteDeps,
  input: { cohortId: string; email: string; name?: string | null; maxRosterSize: number; actor?: EventActor },
): Promise<InviteResult> {
  const email = normalizeAddress(input.email);
  const existing = await findMemberByEmail(deps.db, input.cohortId, email);

  if (existing && LIVE_STATES.includes(existing.state)) {
    throw new TestersAlreadyOnRosterError({ detail: `${email} is already ${existing.state} on ${input.cohortId}` });
  }

  // A withdrawal is the tester's own decision, and it is durable. `lapsed` has exactly one producer —
  // the opt-out route they followed themselves — so unlike `removed` it is never a state the developer
  // chose and never one they may quietly reverse. Without this, a re-invite revived them to `invited`
  // with a fresh token and a zeroed nudge count, and `POST /invite` sends by default: one call, and
  // somebody who asked to be left alone is mailed again and re-enrolled in the daily chase. Every other
  // send path already refused them; this was the one that did not, and it is the path a routine
  // contact-list re-import takes.
  if (existing && existing.state === "lapsed") {
    throw new TestersWithdrawnError({
      detail: `${email} withdrew from ${input.cohortId} on ${existing.lapsedAt?.toISOString() ?? "an unrecorded date"}`,
    });
  }

  // The cap is checked for any invite that will produce a LIVE member — a revival included. Nesting it
  // under `if (!existing)` let a cohort exceed its own cap: remove someone, invite a replacement to
  // refill the cap, then re-invite the removed person and the check never ran. The existing row is by
  // definition not live here, since the throw above guarantees it, so the same count is correct either
  // way.
  const live = await deps.db
    .selectFrom(TESTERS_MEMBERS_TABLE)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("cohortId", "=", input.cohortId)
    .where("state", "in", [...LIVE_STATES])
    .executeTakeFirst();
  // Refuse at the roster edge rather than at the store. A cohort that silently exceeded its cap would
  // surface as a rejected email list days later, with no indication which invitation caused it.
  if ((live?.count ?? 0) >= input.maxRosterSize) {
    throw new TestersRosterFullError({
      detail: `cohort ${input.cohortId} holds ${live?.count ?? 0} of ${input.maxRosterSize}`,
    });
  }

  const memberId = existing?.id ?? deps.newId();
  await appendEvent(deps, {
    cohortId: input.cohortId,
    memberId,
    kind: "invited",
    actor: input.actor ?? "developer",
  });

  if (existing) {
    // A revival: the person is the same, so the id and the event history stay. Their clock restarts
    // from this invitation, which is correct — their previous opt-in ended when they lapsed.
    await patchMember(deps, memberId, {
      state: "invited",
      invitedAt: deps.now.getTime(),
      lastInvitedAt: deps.now.getTime(),
      acceptedAt: null,
      optedInAt: null,
      lapsedAt: null,
      name: input.name ?? existing.name,
      // The outreach history goes with the old membership. Left in place, `dueNudge`'s prompt-first
      // rule never fires for a revived member — they wait two days for an invitation that was never
      // sent to them — and the health score keeps deducting for probes sent before they left.
      // The chase counter restarts, because `dueNudge`'s prompt-first rule keys on it: left in place, a
      // revived member waits two days for an invitation that was never sent to them, and the health
      // score keeps deducting for probes sent before they left.
      nudgeCount: 0,
      // `lastNudgedAt` does NOT reset. It is what the cooldown reads, and clearing it made a
      // remove-then-invite cycle a way to mail immediately somebody who was inside the cooldown a
      // moment ago — bypassing by the back door the guard that `resend` and `nudge` re-check by hand.
      // A fresh token on revival. The old one went out in an email that may still be sitting in an
      // inbox — or in a forwarded one — and a revived member should not be confirmable by a link issued
      // for the membership that ended.
      optInToken: generateOptInToken(),
    });
    return { member: await requireMember(deps.db, memberId), created: false };
  }

  const row = TestersMember.encode({
    id: memberId,
    cohortId: input.cohortId,
    email,
    name: input.name ?? null,
    // Generated here, once, and never again. The invitation, every resend, and every confirm nudge all
    // read the same value off the row, so nothing has to be minted at send time and the CLI can build a
    // working invitation without reaching a secret.
    optInToken: generateOptInToken(),
    state: "invited",
    invitedAt: deps.now,
    acceptedAt: null,
    optedInAt: null,
    lapsedAt: null,
    lastInvitedAt: deps.now,
    lastNudgedAt: null,
    nudgeCount: 0,
    unreachable: false,
    createdAt: deps.now,
    updatedAt: deps.now,
  });
  await deps.db
    .insertInto(TESTERS_MEMBERS_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
    .values(row as any)
    .execute();
  return { member: await requireMember(deps.db, memberId), created: true };
}

/** Send another invitation to someone already on the roster, preserving every date that matters. */
export async function resendInvite(deps: WriteDeps, memberId: string): Promise<TestersMember> {
  const member = await requireMember(deps.db, memberId);
  await appendEvent(deps, { cohortId: member.cohortId, memberId, kind: "reinvited", actor: "developer" });
  // Only `lastInvitedAt` moves. `invitedAt` is the first contact and the anchor of every latency
  // statistic the forecast computes; resetting it on a resend would make conversion look instant.
  await patchMember(deps, memberId, { lastInvitedAt: deps.now.getTime() });
  return requireMember(deps.db, memberId);
}

/** What answering produced: the member, and whether this call was the one that recorded it. */
export interface AcceptResult {
  readonly member: TestersMember;
  /** False when they had already answered — a second click, a prefetching mail client, a forwarded link. */
  readonly firstTime: boolean;
}

/**
 * Record that a tester has agreed to test.
 *
 * This is their answer to the first email, and it is the developer's cue to add their address to the
 * store's tester list — a manual step, because no API can add an address to a Play email list. Only
 * once that is done does the store link work for them.
 *
 * **This is consent, not enrollment**, which is why it is a separate state from `opted_in`. Recording it
 * as an opt-in would inflate the count with people who agreed and never joined, and the count is the
 * one number the whole capability exists to keep honest.
 *
 * Idempotent, and one-way past `accepted`: a tester who has already reached the store does not go
 * backwards because they clicked the older email again.
 */
export async function recordAccepted(deps: WriteDeps, memberId: string): Promise<AcceptResult> {
  const member = await requireMember(deps.db, memberId);
  if (member.state !== "invited") return { member, firstTime: false };
  await appendEvent(deps, { cohortId: member.cohortId, memberId, kind: "accepted", actor: "tester" });
  // The counter resets because they answered. It feeds the health score's "unanswered probes" penalty,
  // and a lifetime total would keep deducting for messages the tester demonstrably *did* answer —
  // dropping a perfectly engaged tester two health bands for the crime of having been chased once.
  await patchMember(deps, memberId, { state: "accepted", acceptedAt: deps.now.getTime(), nudgeCount: 0 });
  return { member: await requireMember(deps.db, memberId), firstTime: true };
}

/** What confirming produced: the member, and whether this call was the one that confirmed them. */
export interface OptInResult {
  readonly member: TestersMember;
  /** False when they had already confirmed — a second click, a prefetching mail client, a forwarded link. */
  readonly firstTime: boolean;
}

/**
 * Record that a tester followed the link through to the store's own opt-in page.
 *
 * **This is the strongest evidence of enrollment Pithy can have, and it is still not proof.** We know
 * they reached Google's page; whether they accepted there, with the right account, is Google's to know
 * and no API reports it. That gap is exactly what `estimated*` names and the disclaimer states.
 *
 * **Idempotent, and that is a requirement rather than a nicety.** The link is followed from an email
 * client, and email clients prefetch links, scanners follow them, and people click twice when a page is
 * slow. If a second visit re-stamped `optedInAt`, every one of those would silently reset the tester's
 * streak to zero — turning the most ordinary user behavior there is into the exact failure this
 * capability exists to prevent. So a repeat visit returns the original date and writes nothing.
 */
export async function confirmOptIn(deps: WriteDeps, memberId: string): Promise<OptInResult> {
  const member = await requireMember(deps.db, memberId);
  if (member.state === "opted_in") return { member, firstTime: false };

  await appendEvent(deps, { cohortId: member.cohortId, memberId, kind: "opted_in", actor: "tester" });
  await patchMember(deps, memberId, {
    state: "opted_in",
    optedInAt: deps.now.getTime(),
    lapsedAt: null,
    // Answered, so the unanswered-probe count starts again. See `recordAccepted` for why a lifetime
    // total would be the wrong input to a penalty whose field is named for what went *unanswered*.
    nudgeCount: 0,
    // Someone confirming has demonstrably received mail at this address, so any earlier bounce is
    // stale. Leaving it set would exclude them from every future nudge for a delivery failure that has
    // visibly stopped being true.
    unreachable: 0,
  });
  return { member: await requireMember(deps.db, memberId), firstTime: true };
}

/** Record a tester's own opt-out. Idempotent for the same reason the confirmation is. */
export async function lapseMember(deps: WriteDeps, memberId: string): Promise<LapseResult> {
  const member = await requireMember(deps.db, memberId);
  if (member.state === "lapsed" || member.state === "removed") return { member, firstTime: false };
  await appendEvent(deps, { cohortId: member.cohortId, memberId, kind: "lapsed", actor: "tester" });
  // Rotating the token is what makes an opt-out stick. Without it the store link already sitting in the
  // tester's inbox stays live, and one replay — a mail client prefetching an older message, a forwarded
  // thread — silently re-enrolls someone who explicitly withdrew.
  await patchMember(deps, memberId, {
    state: "lapsed",
    lapsedAt: deps.now.getTime(),
    optInToken: generateOptInToken(),
  });
  return { member: await requireMember(deps.db, memberId), firstTime: true };
}

/** What withdrawing produced: the member, and whether this call was the one that withdrew them. */
export interface LapseResult {
  readonly member: TestersMember;
  /** False when they had already withdrawn — an unauthenticated replay of a link must not write again. */
  readonly firstTime: boolean;
}

/** Take a tester off the roster. The developer's act, recorded as theirs. */
export async function removeMember(deps: WriteDeps, memberId: string, reason?: string): Promise<TestersMember> {
  const member = await requireMember(deps.db, memberId);
  if (member.state === "removed") return member;
  await appendEvent(deps, {
    cohortId: member.cohortId,
    memberId,
    kind: "removed",
    actor: "developer",
    metadata: reason ? { reason } : {},
  });
  // Rotating the token is what makes removal a revocation rather than a label. A signed link could only
  // have expired; this one stops working on the next request, which is the point of holding it in a row.
  await patchMember(deps, memberId, {
    state: "removed",
    lapsedAt: deps.now.getTime(),
    optInToken: generateOptInToken(),
  });
  return requireMember(deps.db, memberId);
}

/**
 * Record that a nudge was enqueued.
 *
 * **Written at enqueue, not at delivery.** The cooldown reads `lastNudgedAt`, and a cooldown that
 * waited for the send Workflow to confirm delivery would leave a window in which a retried request
 * mails the same tester twice — which is precisely the failure the cooldown exists to prevent. An email
 * enqueued and then failing to send is a delivery problem; an email sent twice is a lost tester.
 */
export async function recordNudge(
  deps: WriteDeps,
  input: { memberId: string; nudgeKind: NudgeKind; jobId: string; copySource: "default" | "supplied" },
): Promise<void> {
  const member = await requireMember(deps.db, input.memberId);
  await appendEvent(deps, {
    cohortId: member.cohortId,
    memberId: input.memberId,
    kind: "nudged",
    actor: "system",
    metadata: { nudge: { nudgeKind: input.nudgeKind, jobId: input.jobId, copySource: input.copySource } },
  });
  await patchMember(deps, input.memberId, {
    lastNudgedAt: deps.now.getTime(),
    nudgeCount: member.nudgeCount + 1,
  });
}

/** Mark an address unreachable after a bounce or a suppression. No event: delivery is not roster state. */
export async function markUnreachable(deps: WriteDeps, memberId: string, unreachable: boolean): Promise<void> {
  // `patchMember` writes raw column values, so the conversion happens through the codec rather than by
  // hand — the one place `true` becomes `1` for this field. The narrowing is only to Zod's declared
  // input union, which is wide because the decode side accepts `0 | 1 | boolean | string`; the encode
  // side returns `0 | 1` and nothing else.
  const stored = SQLiteBoolean.encode(unreachable) as 0 | 1;
  await patchMember(deps, memberId, { unreachable: stored });
}

/** What creating a cohort needs. Every field explicit — the caller resolves the config defaults. */
export interface CreateCohortInput {
  readonly name: string;
  readonly targetSize: number;
  readonly windowDays: number;
  readonly maxRosterSize: number;
  readonly targetPlatform: TesterPlatform;
  readonly resetPolicy: ResetPolicy;
  /** The store's own opt-in page, where a tester actually enrolls. Null until the developer supplies it. */
  readonly storeOptInUrl: string | null;
}

/**
 * Create a cohort.
 *
 * The target, window, cap, and reset policy are written onto the row rather than read from config at
 * query time. A cohort runs for a fortnight while config is redeployed for unrelated reasons, and if
 * the clock read its rules live, raising the target from twelve to fifteen would retroactively rewrite
 * whether last Tuesday counted — and the trend chart would change shape behind the developer with
 * nothing to explain it.
 */
export async function createCohort(deps: WriteDeps, input: CreateCohortInput): Promise<TestersCohort> {
  // Checked here rather than only on the config default, because `--store-url` is the only way to set
  // this per cohort and it reached the column unvalidated — a bare `z.string().nullable()` over a plain
  // `text` column. A value that is present but not usable is worse than an absent one: the daily pass
  // reads presence as readiness and mails every accepted tester a link that enrolls nobody.
  if (input.storeOptInUrl !== null && !isStoreOptInUrl(input.storeOptInUrl)) {
    throw new ValidationError({
      message: "That store opt-in link is not a store link.",
      action: `Copy it from the console. It must be an https URL on ${STORE_OPT_IN_HOSTS.join(" or ")}.`,
      detail: `${input.storeOptInUrl} is not an https URL on a supported store host`,
    });
  }

  // The same invariant the migration enforces with a CHECK and the config layer enforces with a
  // sentence. Without it here, `--max-roster 5` against the default target of twelve — a natural thing
  // to type — surfaced as `CHECK constraint failed` out of Kysely: not a `PithyError`, so no action
  // line, and no `--json` error object for an agent driving the CLI.
  if (input.maxRosterSize < input.targetSize) {
    throw new ValidationError({
      message: `A target of ${input.targetSize} cannot fit in a roster capped at ${input.maxRosterSize}.`,
      action: "Raise the cap, or lower the target. The cap must be at least the target.",
      detail: `targetSize ${input.targetSize} exceeds maxRosterSize ${input.maxRosterSize}`,
    });
  }

  // Names are unique by constraint, so a repeat surfaces as `UNIQUE constraint failed` out of Kysely —
  // not a `PithyError`, so no action line and, under `--json`, no error object for an agent to read.
  // Checked here rather than caught below because the constraint tells us nothing about which name.
  const clash = await deps.db
    .selectFrom(TESTERS_COHORTS_TABLE)
    .select(["id"])
    .where("name", "=", input.name)
    .executeTakeFirst();
  if (clash) {
    throw new ValidationError({
      message: `There is already a cohort called ${input.name}.`,
      action: "Pick another name, or use the existing cohort.",
      detail: `cohort name ${input.name} is taken by ${String(clash.id)}`,
    });
  }

  const id = deps.newId();
  const row = TestersCohort.encode({
    id,
    name: input.name,
    targetPlatform: input.targetPlatform,
    targetSize: input.targetSize,
    windowDays: input.windowDays,
    maxRosterSize: input.maxRosterSize,
    storeOptInUrl: input.storeOptInUrl,
    resetPolicy: input.resetPolicy,
    closedAt: null,
    createdAt: deps.now,
    updatedAt: deps.now,
  });
  await deps.db
    .insertInto(TESTERS_COHORTS_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
    .values(row as any)
    .execute();
  const created = await deps.db.selectFrom(TESTERS_COHORTS_TABLE).selectAll().where("id", "=", id).executeTakeFirst();
  if (!created) throw new TestersCohortNotFoundError({ detail: `cohort ${id} vanished immediately after insert` });
  return TestersCohort.parse(created);
}

/** Close a cohort. It keeps its history and accrues no further snapshots or nudges. */
export async function closeCohort(deps: WriteDeps, cohortId: string): Promise<TestersCohort> {
  await deps.db
    .updateTable(TESTERS_COHORTS_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: partial of the schema's z.input side.
    .set({ closedAt: deps.now.getTime(), updatedAt: deps.now.getTime() } as any)
    .where("id", "=", cohortId)
    .execute();
  const row = await deps.db.selectFrom(TESTERS_COHORTS_TABLE).selectAll().where("id", "=", cohortId).executeTakeFirst();
  if (!row) throw new TestersCohortNotFoundError({ detail: `no cohort ${cohortId}` });
  return TestersCohort.parse(row);
}

/**
 * Find the member a confirmation token belongs to.
 *
 * Returns `undefined` rather than throwing, so the route can answer an unknown token with the same
 * words it answers an expired or removed one — a differentiated response here would turn the public
 * route into an oracle for which testers exist.
 */
export async function findMemberByToken(db: TestersDatabase, token: string): Promise<TestersMember | undefined> {
  const row = await db.selectFrom(TESTERS_MEMBERS_TABLE).selectAll().where("optInToken", "=", token).executeTakeFirst();
  return row ? TestersMember.parse(row) : undefined;
}
