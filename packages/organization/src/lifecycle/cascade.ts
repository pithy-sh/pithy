// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthDatabase } from "@pithy-sh/auth/src/data/tables";
import { accountStanding, LifecycleColumns } from "@pithy-sh/auth/src/lifecycle/state";
import {
  deleteUser,
  type LifecycleActor,
  type LifecycleDeps,
  suspendUser,
} from "@pithy-sh/auth/src/lifecycle/transitions";
import { MEMBERSHIPS_TABLE, type OrganizationDatabase } from "../data/tables";

/**
 * What an organization's suspension or deletion does to the people in it (#623).
 *
 * ## The rule: a member is reached only when this is their only organization
 *
 * "Suspend the org and its users" reads as one act, and a member can belong to several organizations. Written
 * naively, freezing one tenant locks people out of every other tenant they work in. So the cascade is opt-in —
 * `members: "sole"`, never the default — and even then it reaches **only** a member who holds no membership
 * anywhere else. A member of any other organization is never modified: they simply stop seeing this one.
 *
 * "Anywhere else" counts every other membership row, the other organization's own state notwithstanding. A
 * person whose other organization is itself suspended or deleted still belongs to it, and it may come back;
 * reaching their account because of this one would decide that organization's question too.
 *
 * ## Through the user lifecycle, never around it
 *
 * A reached account is suspended or deleted by `@pithy-sh/auth`'s own transitions — the same columns, history
 * row, audit event, mail and hook an operator suspending that one person would produce — with the
 * organization's reason. Nothing here writes an auth column itself. An account already suspended keeps its own
 * suspension, reason and end: restating it with this organization's reason would overwrite why somebody else
 * suspended them. An account already deleted is left as it is.
 *
 * ## Selected once, so it can be previewed
 *
 * Who a cascade reaches is decided by one function, `selectCascade`, before anything is applied. The write runs
 * what it selects; the preview routes answer with it and stop (#813). A preview therefore cannot name a member the
 * write would then treat differently — on the same data. Between the two, a membership can change, and the write's
 * own response stays the record of what happened.
 *
 * ## And nothing undoes it silently
 *
 * A reinstatement or a restore of the organization lifts nobody's own suspension. `membersStillShut` is how the
 * response says which members remain refused, so an operator decides each one.
 */

/** Which members a cascade reaches: none, or those whose only organization this is. */
export type MemberCascade = "none" | "sole";

/** Why a member was not reached. */
export type CascadeSkip = "member_elsewhere" | "already_suspended" | "account_deleted" | "no_account" | "failed";

/** What the cascade did, member by member. */
export interface CascadeOutcome {
  /** The mode it ran in. */
  readonly mode: MemberCascade;
  /** The members whose accounts it suspended or deleted. */
  readonly reached: readonly { readonly userId: string; readonly outcome: "suspended" | "deleted" }[];
  /** The members it left alone, and why. */
  readonly skipped: readonly { readonly userId: string; readonly reason: CascadeSkip }[];
}

/** How many ids one statement names, inside D1's bound-parameter budget. */
const CHUNK = 50;

/** Every member of one organization, split by whether they belong to any other. Sorted, so a response is stable. */
export async function classifyMembers(
  db: OrganizationDatabase,
  organizationId: string,
): Promise<{ readonly sole: string[]; readonly elsewhere: string[] }> {
  const members = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select("userId")
    .where("organizationId", "=", organizationId)
    .orderBy("userId", "asc")
    .execute();
  const userIds = members.map((row) => row.userId);
  const elsewhere = new Set<string>();
  for (let at = 0; at < userIds.length; at += CHUNK) {
    const chunk = userIds.slice(at, at + CHUNK);
    const rows = await db
      .selectFrom(MEMBERSHIPS_TABLE)
      .select("userId")
      .where("userId", "in", chunk)
      .where("organizationId", "!=", organizationId)
      .execute();
    for (const row of rows) elsewhere.add(row.userId);
  }
  return {
    sole: userIds.filter((userId) => !elsewhere.has(userId)),
    elsewhere: userIds.filter((userId) => elsewhere.has(userId)),
  };
}

/** Where each named account stands now, read off `pithy_auth_users` in chunks. An absent id has no entry. */
export async function accountStandings(auth: AuthDatabase, userIds: readonly string[], now: Date) {
  const standings = new Map<string, ReturnType<typeof accountStanding>>();
  for (let at = 0; at < userIds.length; at += CHUNK) {
    const chunk = userIds.slice(at, at + CHUNK);
    if (chunk.length === 0) continue;
    const rows = await auth
      .selectFrom("pithyAuthUsers")
      .select(["id", "suspendedAt", "suspendedUntil", "deletedAt", "purgeAfter"])
      .where("id", "in", chunk)
      .execute();
    for (const row of rows) standings.set(row.id, accountStanding(LifecycleColumns.parse(row), now));
  }
  return standings;
}

/** What a cascade needs: the tenancy tables, and the user lifecycle's own dependencies and actor. */
export interface CascadeDeps {
  /** The tenancy tables, to find who belongs where. */
  readonly db: OrganizationDatabase;
  /** The user lifecycle's dependencies, built from `@pithy-sh/auth`'s composed config, hooks and mail. */
  readonly users: LifecycleDeps;
  /** Who acted, as the user lifecycle records it. */
  readonly actor: LifecycleActor;
  /** The instant standings are judged at. */
  readonly now: Date;
}

/** No cascade: nobody considered, nobody touched. What omitting `members` means. */
export const NO_CASCADE: CascadeOutcome = { mode: "none", reached: [], skipped: [] };

/**
 * What the composed `@pithy-sh/auth` hands a cascade: its lifecycle config and the adopter's user hooks. Read off
 * the composed capability in `organization()`'s `compose`, so a cascaded suspension is configured, mailed and
 * hooked exactly as an operator's suspension of that one person would be.
 */
export interface UserLifecycleWiring {
  /** Auth's resolved config: the purge window, and which lifecycle mails are sent. */
  readonly config: LifecycleDeps["config"];
  /** The adopter's user-lifecycle hooks, as `auth()` was handed them. */
  readonly hooks: LifecycleDeps["hooks"];
}

/** What deciding a cascade reads: who belongs where, and where each account stands, at one instant. */
export interface CascadeReads {
  /** The tenancy tables, to find who belongs where. */
  readonly db: OrganizationDatabase;
  /** `@pithy-sh/auth`'s tables, to read each account's standing. */
  readonly auth: AuthDatabase;
  /** The instant standings are judged at. */
  readonly now: Date;
}

/** Why one sole member with an account would be left alone, or null when the cascade would reach them. */
type CascadeJudge = (standing: ReturnType<typeof accountStanding>) => CascadeSkip | null;

/** A suspension's judgment: an account already suspended keeps its own suspension; one deleted is left alone. */
const suspensionJudge: CascadeJudge = (standing) =>
  standing.state === "deleted" ? "account_deleted" : standing.state === "suspended" ? "already_suspended" : null;

/** A deletion's: a suspended account is deleted too; one already deleted is left alone, unless this one is hard. */
const deletionJudge =
  (deletion: "soft" | "hard"): CascadeJudge =>
  (standing) =>
    standing.state === "deleted" && deletion === "soft" ? "account_deleted" : null;

/**
 * **The cascade's selection, and the one place it is made** (#813): who a cascade would reach, and why each other
 * member would be left alone. The preview answers with it and the cascade runs it, so a preview cannot name a
 * member the write then treats differently. It writes nothing; `reached` is the outcome the transition would give.
 */
async function selectCascade(
  reads: CascadeReads,
  organizationId: string,
  mode: MemberCascade,
  judge: CascadeJudge,
  outcome: "suspended" | "deleted",
): Promise<CascadeOutcome> {
  if (mode === "none") return NO_CASCADE;
  const { sole, elsewhere } = await classifyMembers(reads.db, organizationId);
  const reached: { userId: string; outcome: "suspended" | "deleted" }[] = [];
  const skipped: { userId: string; reason: CascadeSkip }[] = elsewhere.map((userId) => ({
    userId,
    reason: "member_elsewhere",
  }));
  const standings = await accountStandings(reads.auth, sole, reads.now);
  for (const userId of sole) {
    const standing = standings.get(userId);
    const skip = standing ? judge(standing) : "no_account";
    if (skip) skipped.push({ userId, reason: skip });
    else reached.push({ userId, outcome });
  }
  return { mode, reached, skipped: sorted(skipped) };
}

/** Skipped members by id, so a response is stable whichever way each was left alone. */
function sorted<T extends { readonly userId: string }>(members: T[]): T[] {
  return members.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/** What deciding a cascade reads, off what running one needs. */
function readsOf(deps: CascadeDeps): CascadeReads {
  return { db: deps.db, auth: deps.users.db, now: deps.now };
}

/**
 * Run a selected cascade, member by member, and say what it did.
 *
 * Each member is its own transition, and one that fails is reported as `failed` rather than ending the rest: the
 * organization's own transition has already happened, and the members after a failure are owed the same rule.
 */
async function applyCascade(
  deps: CascadeDeps,
  organizationId: string,
  plan: CascadeOutcome,
  run: (userId: string) => Promise<"suspended" | "deleted">,
): Promise<CascadeOutcome> {
  if (plan.mode === "none") return plan;
  const reached: { userId: string; outcome: "suspended" | "deleted" }[] = [];
  const skipped = [...plan.skipped];
  for (const { userId } of plan.reached) {
    try {
      reached.push({ userId, outcome: await run(userId) });
    } catch (error) {
      deps.users.log?.warn("an organization cascade could not reach one member; the rest go on", {
        organizationId,
        userId,
        reason: error instanceof Error ? error.message : String(error),
      });
      skipped.push({ userId, reason: "failed" });
    }
  }
  return { mode: plan.mode, reached, skipped: sorted(skipped) };
}

/**
 * Who suspending an organization with this cascade would reach, as things stand now, with nothing applied. What
 * the suspension's preview answers (#813).
 */
export function planSuspension(
  reads: CascadeReads,
  input: { organizationId: string; mode: MemberCascade },
): Promise<CascadeOutcome> {
  return selectCascade(reads, input.organizationId, input.mode, suspensionJudge, "suspended");
}

/**
 * Who deleting an organization with this cascade would reach, softly or hard, as things stand now, with nothing
 * applied. What the deletion's preview answers (#813).
 */
export function planDeletion(
  reads: CascadeReads,
  input: { organizationId: string; mode: MemberCascade; deletion: "soft" | "hard" },
): Promise<CascadeOutcome> {
  return selectCascade(reads, input.organizationId, input.mode, deletionJudge(input.deletion), "deleted");
}

/**
 * Suspend the accounts of the members whose only organization this is, with the organization's reason and end.
 * An account already suspended keeps its own suspension; one already deleted is left alone.
 */
export async function suspendSoleMembers(
  deps: CascadeDeps,
  input: { organizationId: string; mode: MemberCascade; reason: string; until: Date | null },
): Promise<CascadeOutcome> {
  const plan = await planSuspension(readsOf(deps), input);
  return applyCascade(deps, input.organizationId, plan, async (userId) => {
    await suspendUser(deps.users, { userId, actor: deps.actor, reason: input.reason, until: input.until });
    return "suspended";
  });
}

/**
 * Delete the accounts of the members whose only organization this is, softly or hard as the organization's own
 * deletion runs, with its reason. A suspended account is deleted too — deletion outranks a suspension. One
 * already deleted is left alone by a soft deletion; a hard one brings its purge forward to now. `onHard` is told
 * each account a hard deletion reached, so the caller can start that account's purge.
 */
export async function deleteSoleMembers(
  deps: CascadeDeps,
  input: {
    organizationId: string;
    mode: MemberCascade;
    reason: string;
    deletion: "soft" | "hard";
    onHard?: (userId: string, deletedAt: Date) => Promise<void>;
  },
): Promise<CascadeOutcome> {
  const plan = await planDeletion(readsOf(deps), input);
  return applyCascade(deps, input.organizationId, plan, async (userId) => {
    const result = await deleteUser(deps.users, {
      userId,
      actor: deps.actor,
      reason: input.reason,
      mode: input.deletion,
    });
    if (input.deletion === "hard") await input.onHard?.(userId, result.deletedAt);
    return "deleted";
  });
}

/**
 * The members of an organization whose own accounts are still refused — suspended or deleted — and which. What a
 * reinstatement or a restore reports, because neither lifts anybody's own suspension.
 */
export async function membersStillShut(
  db: OrganizationDatabase,
  auth: AuthDatabase,
  organizationId: string,
  now: Date,
): Promise<{ userId: string; state: "suspended" | "deleted" }[]> {
  const members = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select("userId")
    .where("organizationId", "=", organizationId)
    .orderBy("userId", "asc")
    .execute();
  const standings = await accountStandings(
    auth,
    members.map((row) => row.userId),
    now,
  );
  return members.flatMap((row) => {
    const standing = standings.get(row.userId);
    return standing && standing.state !== "active" ? [{ userId: row.userId, state: standing.state }] : [];
  });
}
