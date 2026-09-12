// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { CompiledQuery, ExpressionBuilder } from "kysely";
import { Membership } from "../data/membership";
import {
  ACTING_TABLE,
  MEMBERSHIPS_TABLE,
  type OrganizationDatabase,
  type OrganizationTables,
  OWNERSHIP_NOMINATIONS_TABLE,
  organizationDatabase,
} from "../data/tables";
import {
  OrganizationForbiddenError,
  OrganizationLastAdministratorError,
  OrganizationNotFoundError,
} from "../error/errors";
import type { KitPower, RoleCatalog } from "../roles/roles";

/**
 * The roster, and the two writes that change it.
 *
 * Between them those writes can make an account unusable in ways nothing else in this capability can,
 * so the rules are in one module, checked in one order, and expressed as questions about the
 * organization rather than about the request.
 *
 * ## The account always keeps somebody who can administer it
 *
 * **The invariant, and it is stated over a power rather than over a word.** An organization where
 * nobody holds {@link RoleCatalog.administrativePower} cannot invite, cannot change a role, cannot
 * repair itself; the operator becomes the only path back in. So the last member holding that power
 * cannot be demoted, cannot be removed, and cannot leave.
 *
 * Counting **members who hold the power** rather than members whose role is spelled `admin` is the
 * deliberate reading, and it is the case a name count gets wrong: a catalog where the owning role holds
 * the administrative power too does not become unadministrable when its one `admin` goes, and refusing
 * that removal would be a rule enforcing its own wording rather than its own reason. The set is derived
 * from the catalog on every call, so a role added to the matrix is counted here without anybody
 * remembering to come back.
 *
 * **And the floor is in the statement, not only in front of it.** {@link refuseIfLastAdministrator}
 * reads a count and produces a sentence somebody can act on; {@link stillAdministered} is the same
 * question carried by the write as a predicate, evaluated by SQLite inside the statement. Two concurrent
 * demotions that both read two cannot both land — the second matches no row and is told so. The check in
 * front is the explanation; the predicate is what makes the rule true.
 *
 * ## Three doors, one invariant
 *
 * Demote, remove, leave. All three reach {@link refuseIfLastAdministrator} and all three carry
 * {@link stillAdministered}, because an invariant checked at two of three doors is an invariant with a
 * third door. {@link leaveOrganization} is {@link removeMember} seen from the other end rather than a
 * second write: removing somebody else needs `organization:manage`, removing yourself needs nothing but
 * being yourself, and splitting the write in half would mean two places for the floor to be checked —
 * the second of which is the one that gets it wrong.
 *
 * ## An unassignable role does not change here
 *
 * A role the catalog excludes from assignment got where it is by a path that is not assignment — the
 * two-party transfer in `../ownership/ownership.ts`. So this surface, which exists to undo assignments,
 * refuses to touch one: it cannot be demoted, its holder cannot be removed, and its holder cannot leave.
 * That is the kit's generalization of the dashboard's *the owner has no exit that is not a transfer*,
 * and it costs a catalog that excludes nothing exactly nothing.
 *
 * ## Nobody mints an administrator without `members:manage`
 *
 * Running the roster day to day is `organization:manage`. Handing somebody a role that **administers**
 * is `members:manage`, checked in {@link requireMayAssign} — one function, called here before a role
 * change is written and by the invitation path before an offer is written, because an invitation
 * offering an administering role is this act arriving by the other door.
 */

/** One membership as a write needs to see it: the id the request named, whose it is, and what it holds. */
export interface TargetMembership<Role extends string> {
  /** The membership row's id. */
  readonly id: string;
  /** The person it belongs to, in `pithy_auth_users`. */
  readonly userId: string;
  /** What they may do here today, decoded through the catalog rather than asserted. */
  readonly role: Role;
}

/**
 * Who is acting, as the gate proved them — never as the request claimed them.
 *
 * Two fields, because two are all any rule here asks: which person, and what they hold. The resolved
 * membership `requireOrganization()` puts on the context satisfies this shape, so a handler passes
 * `c.var.acting` straight through and a test passes a literal.
 */
export interface MemberActor<Role extends string> {
  /** The acting person, in `pithy_auth_users`. */
  readonly userId: string;
  /** Their role in the organization in force. */
  readonly role: Role;
}

/** Which of the three writes is being refused. The wording differs; the rules do not. */
type Act = "demote" | "remove" | "leave";

/**
 * The sentence each refusal ends with.
 *
 * Written out per act rather than interpolated from a verb, because "the owner cannot be left" is what
 * interpolation produces and it is not a sentence anybody would write. A refusal is copy on a screen
 * where somebody is trying to do something reasonable, and the rule about deliberate periods applies to
 * the ones that say no as much as to the ones that say done.
 */
const FLOOR_TAIL: Record<Act, string> = {
  demote: "They cannot be demoted.",
  remove: "They cannot be removed.",
  leave: "You cannot leave.",
};

/** The same, for a role the catalog will not let anybody hand out. */
function unassignableSentence(act: Act, role: string): string {
  if (act === "demote") return `The \`${role}\` role does not change here.`;
  if (act === "remove") return `Somebody holding \`${role}\` cannot be removed.`;
  return `You cannot leave while you hold \`${role}\`.`;
}

/**
 * Demand a power, or refuse with a 403.
 *
 * A 403 and not the 404 the rest of the tenancy surface answers with, and the difference is earned. By
 * the time this runs the caller has been proved a member, so they already know the organization exists.
 * Telling them their role is short leaks nothing further, and it is the only answer that lets them go
 * and ask somebody for the power.
 */
export function assertPower<Power extends string, Role extends string>(
  catalog: RoleCatalog<Power, Role>,
  role: Role,
  power: KitPower | Power,
): void {
  if (catalog.roleAllows(role, power)) return;
  throw new OrganizationForbiddenError({
    message: `That role does not allow \`${power}\`.`,
    action: "Ask somebody who administers the organization.",
    detail: `role ${role} does not hold ${power}`,
  });
}

/**
 * Demand the standing to hand somebody a role, or refuse with a 403.
 *
 * **Handing over the administrative power is not the same act as running the roster.** Whoever holds
 * `organization:manage` invites, removes and demotes; minting another administrator takes
 * `members:manage`, because an administrator who could mint a second administrator could install a
 * fourth party at their own level and the two of them could then hand the account on between
 * themselves. Requiring a second power means somebody with standing over the whole account has agreed
 * before anybody else is given its keys.
 *
 * **Which roles count as administering is read off the matrix, never from the word `admin`.** A role
 * added to the catalog carrying the administrative power is governed by this the day it is added.
 *
 * One function, two callers: the role-change path below and the invitation path, which writes an offer
 * of a role and is therefore this act arriving early. A rule checked in one of the two is a rule with a
 * second door.
 */
export function requireMayAssign<Power extends string, Role extends string>(
  catalog: RoleCatalog<Power, Role>,
  actorRole: Role,
  assigned: Role,
): void {
  if (!catalog.administers(assigned)) return;
  if (catalog.roleAllows(actorRole, "members:manage")) return;
  throw new OrganizationForbiddenError({
    message: `Only somebody holding \`members:manage\` can give out the \`${assigned}\` role.`,
    action: "Ask somebody who holds it.",
    detail: `role ${actorRole} does not hold members:manage and may not assign ${assigned}`,
  });
}

/** Every role in the catalog that holds the administrative power. Derived, never listed. */
function administeringRoles<Power extends string, Role extends string>(
  catalog: RoleCatalog<Power, Role>,
): readonly Role[] {
  return catalog.roles.filter((role) => catalog.administers(role));
}

/**
 * The roster of one organization, oldest membership first.
 *
 * **No catalog, and that is the difference between a list and a gate.** Every gate below decodes a role
 * through {@link RoleCatalog.Role} and refuses a value the catalog does not know, because a role
 * matching no branch of a matrix would deny everything today and, one refactor later, allow it. A roster
 * is not a matrix read: refusing the whole list because one row carries a role this build has not heard
 * of would hide every good row behind one bad one, on the screen somebody would use to find and fix it.
 * So the rows come back as the table defines them, `role` bounded text, and the caller renders what it
 * understands.
 *
 * Ordered by `createdAt`, with the id as the tiebreak — two people added in the same millisecond are
 * otherwise in whatever order SQLite felt like, and a roster that reshuffles between reads is a roster
 * nobody trusts.
 */
export async function listMembers(db: OrganizationDatabase, organizationId: string): Promise<readonly Membership[]> {
  const rows = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .selectAll()
    .where("organizationId", "=", organizationId)
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .execute();
  return rows.map((row) => Membership.parse(row));
}

/**
 * Resolve a membership id inside one organization, or refuse.
 *
 * **Both halves in one predicate.** A lookup by id alone would find a membership of another
 * organization and hand it to a handler that had already checked the caller's power in *theirs* — the
 * exact shape of a cross-tenant write. The refusal is the same 404 either way, so the answer is not an
 * oracle for which membership ids exist elsewhere.
 *
 * **A role the catalog does not know is the same 404.** The column is text, so a repair script, an older
 * build or a migration can put anything in it, and a membership this build cannot decode is not a member
 * this build can act on. Saying so in `detail` — which the HTTP codec strips and the log keeps — is what
 * lets an operator tell that apart from a membership that was never there.
 */
export async function requireMembershipInOrganization<Power extends string, Role extends string>(
  db: OrganizationDatabase,
  catalog: RoleCatalog<Power, Role>,
  organizationId: string,
  membershipId: string,
): Promise<TargetMembership<Role>> {
  const row = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select(["id", "userId", "role"])
    .where("id", "=", membershipId)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();
  if (!row) {
    throw new OrganizationNotFoundError({
      message: "No such member.",
      detail: `membership ${membershipId} is not in organization ${organizationId}`,
    });
  }
  const decoded = catalog.Role.safeParse(row.role);
  if (!decoded.success) {
    throw new OrganizationNotFoundError({
      message: "No such member.",
      detail: `membership ${row.id} in organization ${organizationId} holds role ${JSON.stringify(row.role)}, which this catalog does not declare`,
    });
  }
  return { id: row.id, userId: row.userId, role: decoded.data };
}

/**
 * How many people in this organization hold the administrative power right now.
 *
 * **Counted over the power, never over a role named `admin`.** That is the whole point of the number:
 * an owner who also administers keeps the account administered when the one `admin` leaves, and a count
 * by name would refuse that removal for a reason that is not true.
 */
export async function countAdministrators<Power extends string, Role extends string>(
  db: OrganizationDatabase,
  catalog: RoleCatalog<Power, Role>,
  organizationId: string,
): Promise<number> {
  const roles = administeringRoles(catalog);
  // `defineRoles` refuses a catalog where no role holds the administrative power, so this is unreachable
  // — and `in ()` is not valid SQLite, so the unreachable branch is answered rather than generated.
  if (roles.length === 0) return 0;
  const row = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select((eb) => eb.fn.countAll<number>().as("administrators"))
    .where("organizationId", "=", organizationId)
    .where("role", "in", [...roles])
    .executeTakeFirstOrThrow();
  return Number(row.administrators);
}

/**
 * Refuse when this member is the last one who can administer the account.
 *
 * **This is the sentence, and {@link stillAdministered} is the rule.** Asked before the write because a
 * refusal somebody can act on has to name what they hit, and because the count is cheap. What it is not
 * is the enforcement: two requests can both read two, and both would write. Every write below therefore
 * carries the same question as a predicate.
 */
async function refuseIfLastAdministrator<Power extends string, Role extends string>(
  db: OrganizationDatabase,
  catalog: RoleCatalog<Power, Role>,
  organizationId: string,
  target: TargetMembership<Role>,
  act: Act,
): Promise<void> {
  if (!catalog.administers(target.role)) return;
  if ((await countAdministrators(db, catalog, organizationId)) > 1) return;
  throw lastAdministrator(organizationId, target, act);
}

/** The refusal itself, thrown by the check in front of a write and by the write that matched nothing. */
function lastAdministrator<Role extends string>(
  organizationId: string,
  target: TargetMembership<Role>,
  act: Act,
): OrganizationLastAdministratorError {
  return new OrganizationLastAdministratorError({
    message: `This is the only person who can administer the organization. ${FLOOR_TAIL[act]}`,
    action: "Give somebody else an administering role first.",
    detail: `membership ${target.id} is the last administrator of organization ${organizationId}`,
  });
}

/**
 * The floor as a predicate: **somebody other than this membership can still administer the account.**
 *
 * `exists (select … where role in (administering) and id <> target)` rather than a counted subquery,
 * because that is the invariant said out loud — the question is never "how many" but "is there anybody
 * else" — and because SQLite stops at the first matching row.
 *
 * Evaluated inside the statement, which is the whole point. The count read a moment earlier is one
 * another request is free to have changed; this is read by the database in the same statement that
 * writes, so of two concurrent demotions that both counted two, the second matches no row.
 *
 * Returns the callback Kysely's `where` takes, so the writes below share one definition of the floor
 * rather than copies of a subquery that could drift apart by a `<>`.
 */
function stillAdministered(organizationId: string, exceptMembershipId: string, roles: readonly string[]) {
  return (eb: ExpressionBuilder<DatabaseSchema<OrganizationTables>, typeof MEMBERSHIPS_TABLE>) =>
    eb.exists(
      eb
        .selectFrom(`${MEMBERSHIPS_TABLE} as other`)
        .select("other.id")
        .where("other.organizationId", "=", organizationId)
        .where("other.role", "in", [...roles])
        .where("other.id", "!=", exceptMembershipId),
    );
}

/**
 * Refuse to touch a role nobody may hand out.
 *
 * A role the catalog excludes from assignment arrived by a path that is not assignment, and this
 * surface only undoes assignments. Demoting it, removing its holder or letting its holder walk out would
 * each end that role's tenure by a door the catalog closed — and in a catalog where that role is the one
 * that signs for the account, the last of the three leaves a subscription nobody agreed to pay.
 */
function refuseIfUnassignable<Power extends string, Role extends string>(
  catalog: RoleCatalog<Power, Role>,
  target: TargetMembership<Role>,
  act: Act,
): void {
  if (catalog.assignableRoles.includes(target.role)) return;
  throw new OrganizationForbiddenError({
    message: unassignableSentence(act, target.role),
    action: "Hand it on first. The offer has to be accepted, and the previous holder takes another role.",
    detail: `membership ${target.id} holds ${target.role}, which this catalog excludes from assignment`,
  });
}

/**
 * **Nobody takes their own administration away.**
 *
 * Not a restatement of the floor. {@link refuseIfLastAdministrator} already stops the account being left
 * with nobody, and this is refused even where four administrators remain — because a role change is a
 * decision *about somebody*, and the whole of this surface's design is that such a decision is taken by
 * a person with standing over the person it lands on. Acting on yourself is the one case where those two
 * are the same person and nobody has agreed to anything.
 *
 * **There is already an exit, and it is a different one.** Somebody who wants out leaves. That ends the
 * membership, which is a decision with no aftermath anybody else has to notice; stepping quietly down
 * leaves a row that looks like it was always that way, in an account whose other administrators never
 * heard about it.
 *
 * Only when it is really a step down. Setting yourself to a role that still administers changes nothing
 * about the account's ability to administer itself and is not refused here.
 */
function refuseSelfDemotion<Role extends string>(
  target: TargetMembership<Role>,
  actor: MemberActor<Role>,
  demoting: boolean,
): void {
  if (!demoting || target.userId !== actor.userId) return;
  throw new OrganizationForbiddenError({
    message: "You cannot take away your own administration.",
    action: "Ask another administrator, or leave the organization.",
    detail: `user ${actor.userId} tried to demote their own membership ${target.id}`,
  });
}

/** What a role change names: where, whose, to what, and by whom. */
export interface ChangeRoleOptions<Role extends string> {
  /** The organization in force, from the gate. Never from the request body. */
  readonly organizationId: string;
  /** The membership being changed. Resolved inside that organization or refused. */
  readonly membershipId: string;
  /** The role it becomes. Parsed through {@link RoleCatalog.AssignableRole}, so an excluded role refuses. */
  readonly role: string;
  /** Who is acting, as the gate proved them. */
  readonly actor: MemberActor<Role>;
}

/**
 * Change what one member may do. `organization:manage`, and `members:manage` to hand out a role that
 * administers.
 *
 * **The new role is parsed, not asserted, and it is parsed through the *assignable* set.** That is the
 * single line standing between this surface and the two-party transfer: a role the catalog excludes
 * cannot be conferred here by any caller holding any power, so there is no role change that makes
 * somebody the owner of an account. `../ownership/ownership.ts` refuses to run a transfer whose
 * conferred role is assignable, which is the same rule read from the other end.
 *
 * A no-op change is allowed and writes. Refusing it would make the caller responsible for knowing
 * whether a change is a change, and the answer it holds is one read out of date.
 */
export async function changeRole<Power extends string, Role extends string>(
  db: OrganizationDatabase,
  catalog: RoleCatalog<Power, Role>,
  options: ChangeRoleOptions<Role>,
): Promise<TargetMembership<Role>> {
  assertPower(catalog, options.actor.role, "organization:manage");

  const assigned = catalog.AssignableRole.safeParse(options.role);
  if (!assigned.success) {
    throw new ValidationError({
      message: `\`${options.role}\` is not a role that can be given to somebody.`,
      action: `Pick one of: ${catalog.assignableRoles.join(", ")}.`,
      detail: `role ${JSON.stringify(options.role)} is not in the assignable set of this catalog`,
    });
  }
  const role = assigned.data as Role;

  const target = await requireMembershipInOrganization(db, catalog, options.organizationId, options.membershipId);

  // After the membership resolves, deliberately. A caller naming a membership in another organization is
  // owed the 404 that says nothing about it, before any sentence explaining what the role there is.
  refuseIfUnassignable(catalog, target, "demote");
  requireMayAssign(catalog, options.actor.role, role);

  // Only when the change would actually take the power away. Promoting, or moving between two roles that
  // both administer, is not a demotion and must not be refused as one.
  const demoting = catalog.administers(target.role) && !catalog.administers(role);
  // Before the floor, and the order is the reason a reader gets: somebody demoting themselves in an
  // account of one is refused for being themselves, not for being the last — the second sentence would
  // send them looking for a colleague to promote when nothing they could do makes this act allowed.
  refuseSelfDemotion(target, options.actor, demoting);
  if (demoting) await refuseIfLastAdministrator(db, catalog, options.organizationId, target, "demote");

  const administering = administeringRoles(catalog);
  const changed = await db
    .updateTable(MEMBERSHIPS_TABLE)
    .set({ role })
    .where("id", "=", target.id)
    // The organization again, in the write. The read above proved it; this makes the *statement* unable
    // to touch another organization's row whatever a later refactor does to the order above.
    .where("organizationId", "=", options.organizationId)
    // And the floor, in the statement rather than only in front of it. Only on a demotion: a promotion
    // cannot take the last administrator away, and a predicate that refused one would be a rule
    // enforcing its own wording.
    .$if(demoting, (query) => query.where(stillAdministered(options.organizationId, target.id, administering)))
    .executeTakeFirst();
  if (changed.numUpdatedRows !== 1n) {
    refuseUnwritten(await stillThere(db, options.organizationId, target.id), options.organizationId, target, "demote");
  }

  return { ...target, role };
}

/** Whether the membership is still there, asked after a write that matched nothing. */
async function stillThere(db: OrganizationDatabase, organizationId: string, membershipId: string): Promise<boolean> {
  const row = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select(["id"])
    .where("id", "=", membershipId)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Say why a conditional write matched nothing, having lost the race it was written to lose.
 *
 * Two things can have happened between the read and the write, and they are different answers to the
 * person who pressed the control: the other administrator went — so this one is now the last, and the
 * floor is what stopped it — or this membership itself went, and there is nothing left to act on.
 * Guessing would mean telling somebody they are the last administrator of an account they are no longer
 * in.
 */
function refuseUnwritten<Role extends string>(
  present: boolean,
  organizationId: string,
  target: TargetMembership<Role>,
  act: Act,
): never {
  if (!present) {
    throw new OrganizationNotFoundError({
      message: "No such member.",
      detail: `membership ${target.id} left organization ${organizationId} mid-request`,
    });
  }
  throw lastAdministrator(organizationId, target, act);
}

/** What a removal names: where, whose membership ends, and who decided. */
export interface RemoveMemberOptions<Role extends string> {
  /** The organization in force, from the gate. */
  readonly organizationId: string;
  /** The membership being ended. Resolved inside that organization or refused. */
  readonly membershipId: string;
  /** Who is acting, as the gate proved them. */
  readonly actor: MemberActor<Role>;
}

/** What a leaving names. No membership id: you leave the organization, you do not name a row. */
export interface LeaveOrganizationOptions<Role extends string> {
  /** The organization in force, from the gate. */
  readonly organizationId: string;
  /** Who is leaving, as the gate proved them. */
  readonly actor: MemberActor<Role>;
}

/** What a removal was, once it is decided. The two are audited under different actions. */
export interface RemovedMember<Role extends string> {
  /** The membership that ended. */
  readonly membership: TargetMembership<Role>;
  /** Whether the person removed themselves. `false` is somebody else deciding, which is a different event. */
  readonly left: boolean;
}

/**
 * End a membership — somebody else's with `organization:manage`, or your own with nothing.
 *
 * **Three rows go, in one batch.** The membership; the acting selection of the person who left, because
 * a session pointed at an account they no longer belong to falls back to another one on its next read
 * and silently moves somebody to a different company's screen mid-task; and any standing offer of
 * ownership made to that membership, because there are no foreign keys in D1 and an offer left behind is
 * an offer accepted by somebody who is no longer inside.
 *
 * The second and third statements are **conditional on the membership having actually gone**, since the
 * first carries the administrator floor and can match nothing. A selection cleared for somebody who is
 * still a member would cause the exact failure the deletion exists to prevent.
 */
export async function removeMember<Power extends string, Role extends string>(
  d1: D1Database,
  catalog: RoleCatalog<Power, Role>,
  options: RemoveMemberOptions<Role>,
): Promise<RemovedMember<Role>> {
  const db = organizationDatabase(d1);
  const target = await requireMembershipInOrganization(db, catalog, options.organizationId, options.membershipId);
  const left = target.userId === options.actor.userId;
  // Leaving needs no power. Removing somebody else is a decision about another person's access to this
  // tenant's data, and it needs the power that says so.
  if (!left) assertPower(catalog, options.actor.role, "organization:manage");
  return endMembership(d1, db, catalog, options.organizationId, target, left);
}

/**
 * Leave the organization. Nothing but being yourself.
 *
 * **The same write as {@link removeMember}, reached by the door where the actor is the subject.** A
 * person is always entitled to stop holding another organization's access — but the floor and the
 * unassignable-role rule still apply, because walking out as the last administrator leaves exactly the
 * account nobody can repair that the invariant exists to prevent.
 */
export async function leaveOrganization<Power extends string, Role extends string>(
  d1: D1Database,
  catalog: RoleCatalog<Power, Role>,
  options: LeaveOrganizationOptions<Role>,
): Promise<RemovedMember<Role>> {
  const db = organizationDatabase(d1);
  const row = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select(["id"])
    // Both halves in one predicate, the same as every other read here: the person and the organization.
    .where("userId", "=", options.actor.userId)
    .where("organizationId", "=", options.organizationId)
    .executeTakeFirst();
  if (!row) {
    throw new OrganizationNotFoundError({
      message: "No such member.",
      detail: `user ${options.actor.userId} holds no membership in organization ${options.organizationId}`,
    });
  }
  const target = await requireMembershipInOrganization(db, catalog, options.organizationId, row.id);
  return endMembership(d1, db, catalog, options.organizationId, target, true);
}

/** The one write both doors reach, and the one place the floor is carried into a statement. */
async function endMembership<Power extends string, Role extends string>(
  d1: D1Database,
  db: OrganizationDatabase,
  catalog: RoleCatalog<Power, Role>,
  organizationId: string,
  target: TargetMembership<Role>,
  left: boolean,
): Promise<RemovedMember<Role>> {
  const act: Act = left ? "leave" : "remove";
  refuseIfUnassignable(catalog, target, act);
  const floors = catalog.administers(target.role);
  if (floors) await refuseIfLastAdministrator(db, catalog, organizationId, target, act);

  const administering = administeringRoles(catalog);
  let membership = db
    .deleteFrom(MEMBERSHIPS_TABLE)
    .where("id", "=", target.id)
    .where("organizationId", "=", organizationId);
  // The floor, in the statement. The count read a moment ago is one another request is free to have
  // changed.
  if (floors) membership = membership.where(stillAdministered(organizationId, target.id, administering));

  // **D1 declares no foreign keys, so nothing cascades.** The acting selection and any standing offer of
  // ownership made to this membership are deleted by statements of their own, in the same batch — and
  // each is conditional on the deletion above having actually landed, because that statement carries the
  // floor and can match nothing. A selection cleared for somebody who is still a member would move them
  // to another organization's screen on their next read: the exact failure the cleanup exists to
  // prevent, caused by the cleanup. One subquery, built once and read by both, rather than two copies of
  // a `not exists` that could drift apart by a negation.
  const stillThereQuery = db.selectFrom(MEMBERSHIPS_TABLE).select("id").where("id", "=", target.id);

  const written = await withD1Retry<D1Result<unknown>[] | undefined>(() =>
    d1.batch([
      prepared(d1, membership),
      prepared(
        d1,
        db
          .deleteFrom(ACTING_TABLE)
          .where("userId", "=", target.userId)
          .where("organizationId", "=", organizationId)
          .where((eb) => eb.not(eb.exists(stillThereQuery))),
      ),
      prepared(
        d1,
        db
          .deleteFrom(OWNERSHIP_NOMINATIONS_TABLE)
          .where("membershipId", "=", target.id)
          .where((eb) => eb.not(eb.exists(stillThereQuery))),
      ),
    ]),
  );

  if ((written?.[0]?.meta.changes ?? 0) === 0) {
    const present = await stillThere(db, organizationId, target.id);
    // `undefined` is `withD1Retry`'s idempotency guard — a failure on a *retry*, which it reads as "my
    // own earlier attempt committed". Here that inference is checkable rather than assumed: the row it
    // would have written is this one, so a membership that is gone is a membership this call removed.
    if (present || written !== undefined) refuseUnwritten(present, organizationId, target, act);
  }

  return { membership: target, left };
}

/** Compile a Kysely query to a D1 statement, so it can join a `batch` transaction. */
function prepared(d1: D1Database, query: { compile(): CompiledQuery }): D1PreparedStatement {
  const compiled = query.compile();
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}
