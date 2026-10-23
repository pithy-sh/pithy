// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { ControlPlaneInsufficientScopeError } from "@pithy-sh/core/src/controlPlane/error/errors";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { type CompiledQuery, type ExpressionBuilder, sql } from "kysely";
import { Membership } from "../data/membership";
import {
  ACTING_TABLE,
  MEMBERSHIPS_TABLE,
  ORGANIZATIONS_TABLE,
  type OrganizationDatabase,
  type OrganizationTables,
  OWNERSHIP_NOMINATIONS_TABLE,
  organizationDatabase,
} from "../data/tables";
import {
  OrganizationAlreadyMemberError,
  OrganizationForbiddenError,
  OrganizationLastAdministratorError,
  OrganizationLastOwnerError,
  OrganizationNotFoundError,
  OrganizationSeatLimitReachedError,
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
export async function listMembers(
  db: OrganizationDatabase,
  organizationId: string,
  limit?: number,
): Promise<readonly Membership[]> {
  const rows = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .selectAll()
    .where("organizationId", "=", organizationId)
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    // **The bound reaches the statement, or it is not a bound.** A `slice` after the fact still asked
    // D1 for every membership in the account, which is the cost the limit exists to refuse — and the
    // reason `AdminListQuery` gives for having one is that a verified client can still have a bug. One
    // past the limit, so "was there more" is a fact the rows carry rather than an inference from a full
    // page. Optional because a roster pane wants the whole account and says so by passing nothing.
    .$if(limit !== undefined, (query) => query.limit((limit as number) + 1))
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
  return (await currentRole(db, organizationId, membershipId)) !== undefined;
}

/** The role one membership holds now, or `undefined` when it is gone. */
async function currentRole(
  db: OrganizationDatabase,
  organizationId: string,
  membershipId: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select(["role"])
    .where("id", "=", membershipId)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();
  return row?.role;
}

/**
 * The refusal a write gets when the role it was decided from is no longer the role the member holds.
 *
 * Every rule a write here carries — the owner floor, the administrator floor, whether the caller may move
 * the owning role at all — is chosen from the role read in front of it. Another request can change that
 * role in between (a forced transfer of ownership is the sharp case), and a write that landed anyway
 * would apply a member's rules to an owner. So each write is conditioned on the role it was decided
 * from, and losing that condition is this 409 rather than a guess at what the caller would have wanted.
 */
function staleRole<Role extends string>(organizationId: string, target: TargetMembership<Role>): ConflictError {
  return new ConflictError({
    message: "That member's role changed while this request was running.",
    action: "Read the member again and retry against the role they hold now.",
    detail: `membership ${target.id} in organization ${organizationId} no longer holds ${target.role}`,
  });
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

  const outcome = await deleteMembership(d1, db, organizationId, target, {
    floors: floors ? [administeringRoles(catalog)] : [],
    spendOffersMade: false,
  });
  if (outcome === "stale") throw staleRole(organizationId, target);
  if (outcome !== "removed") refuseUnwritten(outcome === "floored", organizationId, target, act);

  return { membership: target, left };
}

/**
 * What a conditional delete of one membership came to.
 *
 * `removed` — it went, by this call. `gone` — it was already gone, by somebody else's. `floored` — it is
 * still there, because a floor carried in the statement matched nothing: there was nobody else left to
 * hold what this membership held. `stale` — it is still there, holding a different role from the one
 * the floors were chosen for, so the delete was conditioned on a role it no longer holds.
 */
type EndOutcome = "removed" | "gone" | "floored" | "stale";

/** What {@link deleteMembership} carries beyond the membership itself. */
interface DeleteMembershipRules {
  /**
   * A list of role sets, and each one becomes a predicate: *somebody other than this membership still
   * holds one of these*. The member surface passes the administering roles; the operator surface passes
   * those and, for an owner, the owning role.
   */
  readonly floors: readonly (readonly string[])[];
  /**
   * Whether the offers of ownership this membership's holder **made** go too — true when an operator
   * removes an owner. An offer is the owner's to make, and one left standing after its maker stopped
   * owning the account would let its nominee take the account from the owners who remain.
   */
  readonly spendOffersMade: boolean;
}

/**
 * Delete one membership, its holder's selection of this account, and any offer of ownership made to it —
 * in one batch, with each floor carried in the statement. One write for both doors, so the floor is
 * carried the same way whoever pressed the control.
 */
async function deleteMembership<Role extends string>(
  d1: D1Database,
  db: OrganizationDatabase,
  organizationId: string,
  target: TargetMembership<Role>,
  rules: DeleteMembershipRules,
): Promise<EndOutcome> {
  const { floors } = rules;
  let membership = db
    .deleteFrom(MEMBERSHIPS_TABLE)
    .where("id", "=", target.id)
    .where("organizationId", "=", organizationId)
    // The role the floors below were chosen from. Promoted to the owning role in between — by a forced
    // transfer — the member would otherwise be deleted with a member's floors and the account left with
    // no owner; see `staleRole`.
    .where("role", "=", target.role);
  // The floor, in the statement. The count read a moment ago is one another request is free to have
  // changed.
  for (const roles of floors) membership = membership.where(stillAdministered(organizationId, target.id, roles));

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
      ...(rules.spendOffersMade
        ? [
            prepared(
              d1,
              db
                .deleteFrom(OWNERSHIP_NOMINATIONS_TABLE)
                .where("organizationId", "=", organizationId)
                .where("nominatedByUserId", "=", target.userId)
                .where((eb) => eb.not(eb.exists(stillThereQuery))),
            ),
          ]
        : []),
    ]),
  );

  if ((written?.[0]?.meta.changes ?? 0) > 0) return "removed";
  const role = await currentRole(db, organizationId, target.id);
  if (role !== undefined) return role === target.role ? "floored" : "stale";
  // `undefined` is `withD1Retry`'s idempotency guard — a failure on a *retry*, which it reads as "my own
  // earlier attempt committed". Here that inference is checkable rather than assumed: the row it would
  // have written is this one, so a membership that is gone is a membership this call removed.
  return written === undefined ? "removed" : "gone";
}

/*
  ## The operator's doors (#624)

  Everything above is a member acting inside their own account, and every rule there is a rule about
  who may decide something about whom. Everything below is an operator acting through the control
  plane, inside somebody else's account, with a scope that already says they may — so the rules that
  were about standing (`organization:manage`, `members:manage`, *nobody takes their own administration
  away*, *an unassignable role does not change here*) do not apply, and the rules that are about the
  **account** still do:

  - **It keeps somebody who can administer it.** The same floor, the same predicate.
  - **It keeps an owner, where it has one.** The owner is the role a transfer confers, and an account
    with none is the unadministrable state this surface exists to get out of. Removing or demoting the
    last one is refused, and the refusal names the route that moves ownership instead.
  - **It holds no more members than its seat limit**, unless the operator says to, and that is recorded.
*/

/**
 * The owning role, as the operator surface holds the last-owner rule over it.
 *
 * Absent where a project wires no transfer of ownership — a catalog with nothing to own has no owner to
 * be the last of, and the administrator floor is the only one.
 */
export interface OwnerRule<Role extends string> {
  /** The role a transfer of ownership confers. */
  readonly role: Role;
  /** Where an operator moves ownership, named in the refusal so the next step is in it. */
  readonly transferRoute: string;
  /**
   * Whether this caller may put somebody into the owning role, or take somebody out of it, through a
   * roster write — an add at that role, a role change to or from it, or the removal of an owner.
   *
   * **The control-plane surface always sets it false.** A control-plane token exercises the one scope it
   * was minted for, whatever else its connection was granted, and a roster write's token is minted for
   * `organization:members:write` — so no roster call ever carries `organization:ownership:transfer`.
   * Reading the connection's grant instead would let a roster token add a second owner and remove the
   * first: an account handed over with no ownership-scoped call, no forced-ownership event and no notice
   * to the new owner. Ownership moves through {@link transferRoute}, under its own scope. True is for an
   * adopter's own code, which has already decided who may move it.
   */
  readonly mayConfer: boolean;
}

/** Refuse a roster write that moves the owning role, for a caller not granted ownership. */
function refuseUnlessMayConfer<Role extends string>(
  organizationId: string,
  owner: OwnerRule<Role>,
  subject: string,
): void {
  if (owner.mayConfer) return;
  throw new ControlPlaneInsufficientScopeError({
    message: `Moving the \`${owner.role}\` role is not a roster write.`,
    action: `Make the change through POST ${owner.transferRoute}, under organization:ownership:transfer.`,
    detail: `${subject} moves ${owner.role} in organization ${organizationId}, which only the ownership route may do`,
    params: { ownershipRoute: owner.transferRoute },
  });
}

/** Decode a role an operator named against every role the catalog declares, or refuse listing them. */
function declaredRole<Power extends string, Role extends string>(
  catalog: RoleCatalog<Power, Role>,
  role: string,
): Role {
  const decoded = catalog.Role.safeParse(role);
  if (decoded.success) return decoded.data;
  const roles = catalog.roles.join(", ");
  throw new ValidationError({
    message: `\`${role}\` is not a role this organization declares. Valid roles: ${roles}.`,
    action: `Pick one of: ${roles}.`,
    detail: `role ${JSON.stringify(role)} is not declared by this catalog`,
    params: { role, roles },
  });
}

/** How many memberships in one organization hold one role. */
async function countHolders(db: OrganizationDatabase, organizationId: string, role: string): Promise<number> {
  const row = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select((eb) => eb.fn.countAll<number>().as("holders"))
    .where("organizationId", "=", organizationId)
    .where("role", "=", role)
    .executeTakeFirstOrThrow();
  return Number(row.holders);
}

/** The refusal the last owner gets, with the route that moves ownership named for both audiences. */
function lastOwner<Role extends string>(
  organizationId: string,
  target: TargetMembership<Role>,
  owner: OwnerRule<Role>,
  act: "demote" | "remove",
): OrganizationLastOwnerError {
  return new OrganizationLastOwnerError({
    message: `This is the only owner of the organization. ${FLOOR_TAIL[act]} Force ownership onto somebody else first.`,
    action: `Force ownership onto somebody else first: POST ${owner.transferRoute}.`,
    detail: `membership ${target.id} is the last holder of ${owner.role} in organization ${organizationId}`,
    params: { ownershipRoute: owner.transferRoute },
  });
}

/** Refuse when this membership is the last one holding the owning role. The sentence; the predicate is the rule. */
async function refuseIfLastOwner<Role extends string>(
  db: OrganizationDatabase,
  organizationId: string,
  target: TargetMembership<Role>,
  owner: OwnerRule<Role>,
  act: "demote" | "remove",
): Promise<void> {
  if ((await countHolders(db, organizationId, owner.role)) > 1) return;
  throw lastOwner(organizationId, target, owner, act);
}

/**
 * Say which floor a conditional write lost to, having lost it.
 *
 * Asked again rather than guessed: the owner floor is the stricter sentence, because it names a route,
 * so it is checked first — and only when there is genuinely nobody else holding the role.
 */
async function operatorFloorRefusal<Role extends string>(
  db: OrganizationDatabase,
  organizationId: string,
  target: TargetMembership<Role>,
  owner: OwnerRule<Role> | undefined,
  act: "demote" | "remove",
): Promise<never> {
  if (owner && target.role === owner.role && (await countHolders(db, organizationId, owner.role)) <= 1) {
    throw lastOwner(organizationId, target, owner, act);
  }
  throw lastAdministrator(organizationId, target, act);
}

/** What an operator's add names. */
export interface AddMemberOptions<Role extends string = string> {
  /** The organization, from the path. Refused with the ordinary 404 when there is none. */
  readonly organizationId: string;
  /** The person, in `pithy_auth_users`. The caller has already proved the row exists. */
  readonly userId: string;
  /** The role they take. Any role the catalog declares. */
  readonly role: string;
  /** Whether to add past the seat limit. Recorded by the caller when it was needed. */
  readonly overrideSeatLimit: boolean;
  /** The clock. */
  readonly now: Date;
  /** The id source for the membership. A seam; production passes nothing. */
  readonly newId?: () => string;
  /** The owning role, where the project has one. An add at it needs {@link OwnerRule.mayConfer}. */
  readonly owner?: OwnerRule<Role>;
}

/** What an operator's add wrote, and what it cost against the seat limit. */
export interface AddedMember<Role extends string> {
  /** The membership that now exists. */
  readonly membership: Membership & { readonly role: Role };
  /** The account's seat limit when the add ran, or null for none. */
  readonly seatLimit: number | null;
  /** How many members the account held before this one. */
  readonly membersBefore: number;
  /** True only when the add went past the limit because the request said to. */
  readonly overrodeSeatLimit: boolean;
}

/**
 * Add an existing user to an account, at a named role. The operator's act; no invitation is sent.
 *
 * **A membership, not an offer**, because an operator adding somebody has already established that they
 * belong — an invitation would ask the person to prove an address the operator is vouching for.
 *
 * **The seat limit is carried in the statement when it binds**, the way the administrator floor is: the
 * count read in front is the sentence somebody acts on, and `insert … select … where (count) < limit`
 * is the rule, so two adds racing for the last seat cannot both land. Raw SQL for that one statement,
 * as `invite.ts` writes its own, because the shape is not one Kysely's insert builder expresses without
 * hiding the bound values; every value is still encoded through the table's own codec first.
 *
 * **One membership per person per organization is the table's unique index**, so an add that loses a
 * race to another add is told the role the winner gave them rather than given a second row.
 */
export async function addMember<Power extends string, Role extends string>(
  d1: D1Database,
  catalog: RoleCatalog<Power, Role>,
  options: AddMemberOptions<Role>,
): Promise<AddedMember<Role>> {
  const db = organizationDatabase(d1);
  const role = declaredRole(catalog, options.role);
  if (options.owner && role === options.owner.role) {
    refuseUnlessMayConfer(options.organizationId, options.owner, `adding user ${options.userId} as ${role}`);
  }

  const organization = await db
    .selectFrom(ORGANIZATIONS_TABLE)
    .select(["id", "seatLimit"])
    .where("id", "=", options.organizationId)
    .executeTakeFirst();
  if (!organization) {
    throw new OrganizationNotFoundError({
      detail: `operator add into organization ${options.organizationId}, which does not exist`,
    });
  }
  const seatLimit = organization.seatLimit ?? null;

  await refuseIfAlreadyMember(db, options.organizationId, options.userId);

  const membersBefore = await countMembers(db, options.organizationId);
  const full = seatLimit !== null && membersBefore >= seatLimit;
  if (full && !options.overrideSeatLimit) throw seatLimitReached(options.organizationId, seatLimit);

  const membership: Membership & { readonly role: Role } = {
    id: (options.newId ?? (() => crypto.randomUUID()))(),
    organizationId: options.organizationId,
    userId: options.userId,
    role,
    createdAt: options.now,
  };
  // Through the table's own codec, which is also where the id's shape and the role's bound are held.
  const row = Membership.encode(membership);

  // Whether this add went past the limit is what the insert found, not what the count said: a count
  // that saw room can be overtaken by another add before this one lands. So when the limit binds, the
  // seat-conditional insert always goes first, and only an override that it refuses writes past it.
  let overrodeSeatLimit = false;
  try {
    if (seatLimit === null) {
      await db.insertInto(MEMBERSHIPS_TABLE).values(row).executeTakeFirst();
    } else {
      const result = await sql`
        insert into pithy_organization_memberships (id, organization_id, user_id, role, created_at)
        select ${row.id}, ${row.organizationId}, ${row.userId}, ${row.role}, ${row.createdAt}
        where (select count(*) from pithy_organization_memberships where organization_id = ${row.organizationId}) < ${seatLimit}
      `.execute(db);
      if ((result.numAffectedRows ?? 0n) === 0n) {
        // The seat predicate matched nothing: the account was full, or the last seat went between the
        // count and the insert. Refused, unless the request said to go past it.
        if (!options.overrideSeatLimit) throw seatLimitReached(options.organizationId, seatLimit);
        await db.insertInto(MEMBERSHIPS_TABLE).values(row).executeTakeFirst();
        overrodeSeatLimit = true;
      }
    }
  } catch (cause) {
    if (cause instanceof OrganizationSeatLimitReachedError) throw cause;
    // The unique index on `(organizationId, userId)`: somebody added them between the read and the write.
    // Asked again, so the refusal names the role the winner gave them — and a genuine failure, with no
    // row behind it, is still a failure.
    await refuseIfAlreadyMember(db, options.organizationId, options.userId);
    throw cause;
  }

  return { membership, seatLimit, membersBefore, overrodeSeatLimit };
}

/** How many memberships one organization holds. */
async function countMembers(db: OrganizationDatabase, organizationId: string): Promise<number> {
  const row = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select((eb) => eb.fn.countAll<number>().as("members"))
    .where("organizationId", "=", organizationId)
    .executeTakeFirstOrThrow();
  return Number(row.members);
}

/** Refuse an add for somebody already in the account, naming the role they hold. */
async function refuseIfAlreadyMember(db: OrganizationDatabase, organizationId: string, userId: string): Promise<void> {
  const existing = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select(["id", "role"])
    .where("organizationId", "=", organizationId)
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (!existing) return;
  throw new OrganizationAlreadyMemberError({
    message: `That person is already a member, as \`${existing.role}\`.`,
    action: "Change their role instead.",
    detail: `user ${userId} already holds membership ${existing.id} in organization ${organizationId}`,
    params: { role: existing.role, membershipId: existing.id },
  });
}

/** The refusal a full account gives, naming its limit. */
function seatLimitReached(organizationId: string, seatLimit: number): OrganizationSeatLimitReachedError {
  return new OrganizationSeatLimitReachedError({
    message: `This organization is at its seat limit of ${seatLimit}.`,
    action: "Raise the seat limit, remove somebody, or add with `overrideSeatLimit: true`.",
    detail: `organization ${organizationId} holds ${seatLimit} or more memberships against a limit of ${seatLimit}`,
    params: { seatLimit },
  });
}

/** What an operator's role change names. */
export interface OperatorChangeRoleOptions<Role extends string> {
  /** The organization, from the path. */
  readonly organizationId: string;
  /** The membership changed. Resolved inside that organization or refused. */
  readonly membershipId: string;
  /**
   * The role it becomes. Any role the catalog declares; to or from the owning one only with
   * {@link OwnerRule.mayConfer}, which the control-plane route never grants.
   */
  readonly role: string;
  /** The owning role, where the project has one. */
  readonly owner?: OwnerRule<Role>;
}

/** What an operator's role change did. */
export interface OperatorRoleChange<Role extends string> {
  /** The membership, with its new role. */
  readonly membership: TargetMembership<Role>;
  /** The role it held before. */
  readonly previousRole: Role;
}

/**
 * Change a member's role, as an operator. Any role the catalog declares, `unassignable` ones included —
 * the catalog's `unassignable` closes the member surface's door, and this is not that door: it is behind
 * a control-plane scope, and its reason is recorded. **The owning role is the exception**: a change to or
 * from it needs {@link OwnerRule.mayConfer}, which the control-plane route never sets, so there ownership
 * moves only through {@link OwnerRule.transferRoute}.
 *
 * Demoting the last owner is refused, naming the route that moves ownership; demoting the last
 * administrator is refused on the member surface's own floor. Both are carried in the statement, and so is
 * the role every rule here was chosen from: a member made the owner in between is refused 409 rather than
 * changed with a member's rules. A demoted owner's standing offer of
 * ownership is spent in the same batch — it was theirs to make, and they no longer own the account.
 */
export async function changeRoleAsOperator<Power extends string, Role extends string>(
  d1: D1Database,
  catalog: RoleCatalog<Power, Role>,
  options: OperatorChangeRoleOptions<Role>,
): Promise<OperatorRoleChange<Role>> {
  const db = organizationDatabase(d1);
  const role = declaredRole(catalog, options.role);
  const target = await requireMembershipInOrganization(db, catalog, options.organizationId, options.membershipId);

  const owner = options.owner;
  const demotingOwner = owner !== undefined && target.role === owner.role && role !== owner.role;
  const demotingAdministrator = catalog.administers(target.role) && !catalog.administers(role);
  // The owner first: it is the stricter sentence, and it names a route. Then the grant, which also names
  // it — both refuse, so the order only decides which sentence the operator reads.
  if (demotingOwner && owner) await refuseIfLastOwner(db, options.organizationId, target, owner, "demote");
  if (owner && role !== target.role && (role === owner.role || target.role === owner.role)) {
    refuseUnlessMayConfer(
      options.organizationId,
      owner,
      `changing membership ${target.id} from ${target.role} to ${role}`,
    );
  }
  if (demotingAdministrator) await refuseIfLastAdministrator(db, catalog, options.organizationId, target, "demote");

  const update = db
    .updateTable(MEMBERSHIPS_TABLE)
    .set({ role })
    .where("id", "=", target.id)
    .where("organizationId", "=", options.organizationId)
    // The role every rule above was chosen from; see `staleRole`.
    .where("role", "=", target.role)
    .$if(demotingOwner && owner !== undefined, (query) =>
      query.where(stillAdministered(options.organizationId, target.id, [owner?.role ?? ""])),
    )
    .$if(demotingAdministrator, (query) =>
      query.where(stillAdministered(options.organizationId, target.id, administeringRoles(catalog))),
    );
  const statements = [prepared(d1, update)];
  if (demotingOwner && owner) {
    // The offers this owner made, spent only once they demonstrably no longer hold the owning role — the
    // update above carries the floor and can match nothing, and an owner who stays keeps their offer.
    statements.push(
      prepared(
        d1,
        db
          .deleteFrom(OWNERSHIP_NOMINATIONS_TABLE)
          .where("organizationId", "=", options.organizationId)
          .where("nominatedByUserId", "=", target.userId)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom(`${MEMBERSHIPS_TABLE} as holder`)
                  .select("holder.id")
                  .where("holder.id", "=", target.id)
                  .where("holder.role", "=", owner.role),
              ),
            ),
          ),
      ),
    );
  }
  const written = await withD1Retry<D1Result<unknown>[] | undefined>(() => d1.batch(statements));
  // `undefined` is `withD1Retry`'s idempotency guard; an update collides with no unique key, so the row is
  // asked instead of the change count.
  const landed =
    written === undefined
      ? (
          await db
            .selectFrom(MEMBERSHIPS_TABLE)
            .select("role")
            .where("id", "=", target.id)
            .where("organizationId", "=", options.organizationId)
            .executeTakeFirst()
        )?.role === role
      : (written[0]?.meta.changes ?? 0) === 1;
  if (!landed) {
    const now = await currentRole(db, options.organizationId, target.id);
    if (now === undefined) refuseUnwritten(false, options.organizationId, target, "demote");
    if (now !== target.role) throw staleRole(options.organizationId, target);
    await operatorFloorRefusal(db, options.organizationId, target, owner, "demote");
  }

  return { membership: { ...target, role }, previousRole: target.role };
}

/** What an operator's removal names. */
export interface OperatorRemoveMemberOptions<Role extends string> {
  /** The organization, from the path. */
  readonly organizationId: string;
  /** The membership ended. Resolved inside that organization or refused. */
  readonly membershipId: string;
  /** The owning role, where the project has one. */
  readonly owner?: OwnerRule<Role>;
}

/**
 * Remove a member, as an operator — the membership, their selection of the account, any offer of
 * ownership made to them and, for an owner, any offer they made, in one batch.
 *
 * **Any member, whatever they hold**, except the last owner and the last administrator. The last owner's
 * refusal names the route that moves ownership, which is the break-glass path this exists beside: an
 * owner who has left is replaced there, with their membership kept or removed as the operator says.
 * Removing any owner, last or not, needs {@link OwnerRule.mayConfer}: otherwise a roster-only caller
 * refused the demotion could make it anyway, as a removal and an add back at a lesser role.
 */
export async function removeMemberAsOperator<Power extends string, Role extends string>(
  d1: D1Database,
  catalog: RoleCatalog<Power, Role>,
  options: OperatorRemoveMemberOptions<Role>,
): Promise<TargetMembership<Role>> {
  const db = organizationDatabase(d1);
  const target = await requireMembershipInOrganization(db, catalog, options.organizationId, options.membershipId);

  const owner = options.owner;
  const ownerFloor = owner !== undefined && target.role === owner.role;
  const administratorFloor = catalog.administers(target.role);
  // Removing an owner takes them out of the owning role as surely as demoting them does, so it needs the
  // same grant — refused even where a second owner would let the floor through. The last-owner sentence
  // first, as for a demotion: both refuse, and that one is the stricter.
  if (ownerFloor && owner) await refuseIfLastOwner(db, options.organizationId, target, owner, "remove");
  if (ownerFloor && owner) refuseUnlessMayConfer(options.organizationId, owner, `removing owner ${target.id}`);
  if (administratorFloor) await refuseIfLastAdministrator(db, catalog, options.organizationId, target, "remove");

  const floors: (readonly string[])[] = [];
  if (ownerFloor && owner) floors.push([owner.role]);
  if (administratorFloor) floors.push(administeringRoles(catalog));

  // An owner removed by an operator takes their offers with them; see `spendOffersMade`.
  const outcome = await deleteMembership(d1, db, options.organizationId, target, {
    floors,
    spendOffersMade: ownerFloor,
  });
  if (outcome === "gone") refuseUnwritten(false, options.organizationId, target, "remove");
  if (outcome === "stale") throw staleRole(options.organizationId, target);
  if (outcome === "floored") await operatorFloorRefusal(db, options.organizationId, target, owner, "remove");
  return target;
}

/** Compile a Kysely query to a D1 statement, so it can join a `batch` transaction. */
function prepared(d1: D1Database, query: { compile(): CompiledQuery }): D1PreparedStatement {
  const compiled = query.compile();
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}
