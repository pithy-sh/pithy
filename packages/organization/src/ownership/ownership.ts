// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import type { CompiledQuery } from "kysely";
import { OwnershipNomination } from "../data/ownershipNomination";
import {
  MEMBERSHIPS_TABLE,
  type OrganizationDatabase,
  OWNERSHIP_NOMINATIONS_TABLE,
  organizationDatabase,
} from "../data/tables";
import {
  OrganizationForbiddenError,
  OrganizationInvalidRoleCatalogError,
  OrganizationNominationInvalidError,
} from "../error/errors";
import type { RoleCatalog } from "../roles/roles";

/**
 * Ownership, and the two acts it takes to move it.
 *
 * **Nobody is made responsible for an account by somebody else's click.** That is the whole design.
 * Whoever holds the owning role signs for the account: they are who gets invoiced, who agrees to the
 * terms, and who cannot be removed. Handing that to a colleague with one button would be handing them an
 * obligation they did not agree to, and doing it in a product where the same button sits next to "change
 * role" is how it would happen by accident.
 *
 * So a transfer is an offer and an acceptance, and this module is both halves.
 *
 * ## Where the owning role comes from, and why it is a parameter
 *
 * `defineRoles` has no notion of ownership, deliberately: ownership is a *product* idea, and a catalog
 * that had to name an owner would refuse the academy, where `coach` and `student` are parallel and
 * nobody signs for anything. So a transfer names the two roles it moves — {@link OwnershipRoles}: the
 * role the nominee takes, and the role the previous holder falls back to — and the capability's routes
 * read that pair from one place (config, or the single unassignable role the catalog declares) rather
 * than from a request.
 *
 * **Two alternatives were considered and are worse.**
 *
 * *A column on the nomination row.* It would let the offer carry the role, which sounds tidier until you
 * notice what it becomes: a second way to assign an arbitrary role, written by whoever may nominate,
 * redeemed by whoever was named, and routed around {@link RoleCatalog.AssignableRole} entirely. The
 * nomination table would stop being "an offer of the account" and start being "a grant of any role at
 * all, on a delay". A pair of constants read from one place at both ends cannot do that.
 *
 * *Inferring it — the single unassignable role.* Convenient for the dashboard and wrong for anyone else:
 * a catalog may exclude two roles from assignment for reasons that have nothing to do with who pays, and
 * a capability that guessed would silently transfer the wrong one. The routes may make that inference,
 * where an operator can read it; the store does not.
 *
 * ## The rule that makes the two-party property true rather than intended
 *
 * {@link requireTransferableRoles} refuses a transfer whose conferred role is **assignable**. If it were,
 * `changeRole` could hand it to somebody in a single call and the whole apparatus below would be
 * decoration. So the property is not "we were careful not to expose a route that does it" — it is a
 * precondition the transfer itself checks, against the same catalog the role-change path parses through.
 *
 * ## Who may offer, and why two of those rules are here rather than in a route
 *
 * {@link nominate} takes no role, and it does not need one. Both rules that matter are facts about the
 * account and the person offering, and both are checked here rather than left to route wiring — because
 * a rule a route has to remember is a rule with a door somebody will forget to close:
 *
 * **While somebody holds the account, only they may hand it on.** Not an administrator, not somebody
 * holding `members:manage`. Handing on the obligation is the holder's to hand and nobody else's, and a
 * capability that let a power-holder do it would let two administrators pass an account between
 * themselves over the head of the person who signed for it.
 *
 * **While nobody holds it, anybody in the account may volunteer — themselves, and nobody else.** That is
 * not a hole in the two-party rule: it is a person taking on an obligation, which is exactly the consent
 * the rule exists to require. What it refuses is somebody *else* volunteering them, and the refusal is
 * load-bearing rather than decorative: an administrator who could nominate a colleague could invite a
 * fourth party and install them as the holder of an account that belongs to neither of them.
 *
 * The acceptance is still a separate act either way, so a volunteer confirms their own offer.
 *
 * **What is left to the routes is how narrow to make it**, over `billing:manage` and
 * `organization:manage` — a product may require a power to reach this at all. It may not widen it.
 *
 * An account whose holder has vanished is therefore stuck, and that is deliberate: it is repaired by an
 * operator writing the row, which leaves a trace, rather than by a route that could be reached by
 * anybody the day somebody mis-scopes it.
 *
 * ## An organization may have no owner at all
 *
 * That is the ordinary state of a young account, not an edge case: founding one makes you an
 * administrator, and nobody has agreed to pay for anything yet. Everything works — the roster, role
 * changes, removals, invitations — except billing, which is the model saying out loud that nobody has
 * signed. {@link acceptNomination} handles the no-previous-holder case by demoting nobody.
 *
 * ## The transfer is one write, in one order
 *
 * Demote the previous holders, promote the nominee, spend the offer — one `d1.batch`, which D1 runs as a
 * transaction, so there is no instant at which the account has two owners or none. **Demotion first**,
 * because a deployment that does add a partial unique index over the owning role would have SQLite check
 * it per statement rather than at commit, and a promotion that ran first would fail inside the
 * transaction. The order costs nothing without the index and is correct with it.
 */

/**
 * The two roles a transfer moves.
 *
 * A pair rather than a single "owner role", because a transfer is not a promotion: somebody stops
 * holding the role in the same write as somebody else starts, and what they become has to be said. Read
 * from one place at both ends — see the module note.
 */
export interface OwnershipRoles<Role extends string> {
  /**
   * The role the nominee takes.
   *
   * Must be **unassignable** in the catalog. A role anybody can hand out is not a role that needs a
   * two-party transfer, and offering one here would be a second, weaker door onto the same act.
   */
  readonly confers: Role;
  /**
   * The role the previous holder falls back to.
   *
   * Not removal. Handing on the account is not leaving the company, and a product whose former owner
   * lost their access in the same click would be punishing the person who did the responsible thing.
   */
  readonly demotesTo: Role;
}

/** Refuse a transfer's roles, naming what is wrong with them. */
function refuseRoles(message: string, action: string, detail: string): never {
  throw new OrganizationInvalidRoleCatalogError({ message, action, detail });
}

/**
 * Check the pair a transfer moves, before anything is written.
 *
 * Raised as an **invalid catalog**, not as a bad request, because these are facts about the wiring
 * rather than about the caller: a route that passes a role its catalog does not declare, or a conferred
 * role anybody could have been given by a form field, is a mistake made once at build time and made in
 * every request afterwards.
 */
export function requireTransferableRoles<Power extends string, Role extends string>(
  catalog: RoleCatalog<Power, Role>,
  roles: OwnershipRoles<Role>,
): void {
  for (const [field, role] of [
    ["confers", roles.confers],
    ["demotesTo", roles.demotesTo],
  ] as const) {
    if (!catalog.roles.includes(role)) {
      refuseRoles(
        `\`${role}\` is not a role this catalog declares.`,
        `Name one of: ${catalog.roles.join(", ")}.`,
        `ownership ${field} ${JSON.stringify(role)} is not a declared role`,
      );
    }
  }
  if (roles.confers === roles.demotesTo) {
    refuseRoles(
      "A transfer has to hand the role to somebody and give the previous holder a different one.",
      "Name the role the previous holder falls back to.",
      `ownership confers and demotesTo are both ${JSON.stringify(roles.confers)}`,
    );
  }
  // The line the whole module rests on. If the conferred role were assignable, one role change would
  // make somebody the owner and every offer-and-acceptance below would be theater.
  if (catalog.assignableRoles.includes(roles.confers)) {
    refuseRoles(
      `\`${roles.confers}\` can be given out by a role change, so it is not a role a transfer can hand over.`,
      `Add \`${roles.confers}\` to \`unassignable\` in the catalog.`,
      `ownership confers ${JSON.stringify(roles.confers)}, which is in this catalog's assignable set`,
    );
  }
  /*
    **The conferred role has to administer, and this is the fourth door onto the last-administrator
    invariant.**

    `changeRole`, `removeMember` and `leaveOrganization` all count administrators before they write, and
    the docs say so in as many words: the last holder of `administrativePower` cannot be demoted,
    removed, or leave. A transfer rewrites roles too — the nominee is promoted and every previous holder
    demoted — and it reaches neither half of that count.

    It cannot, sensibly. The transfer is two writes in one batch, and a count taken before them says
    nothing about the state after. So the invariant is held **here** instead, at the wiring, by refusing
    a pair that could ever reduce the administrator count: a `confers` that administers means the
    account gains an administrator in the same batch in which one is demoted, so the count cannot reach
    zero however many previous holders there were.

    The catalog that breaks it is not contrived. `owner: [billing:manage, organization:delete]` with a
    separate `admin` holding `organization:manage` is a perfectly reasonable separation of "signs for
    the account" from "runs it" — and under it, accepting a transfer would demote the only administrator
    into a role that administers nothing, leaving an account nobody can invite into, rename, or repair.
    A compose-time refusal is the only place that can be caught, because by the time a request arrives
    the catalog is already what it is.
  */
  if (!catalog.administers(roles.confers)) {
    refuseRoles(
      `\`${roles.confers}\` does not hold \`${catalog.administrativePower}\`, so accepting a transfer could leave this account with nobody who can administer it.`,
      `Give \`${roles.confers}\` the administrative power, or name a different role for the transfer to confer.`,
      `ownership confers ${JSON.stringify(roles.confers)}, which does not hold ${catalog.administrativePower}`,
    );
  }
}

/** Every membership in one organization holding one role. Zero rows is an ownerless account. */
export async function holdersOf(
  db: OrganizationDatabase,
  organizationId: string,
  role: string,
): Promise<readonly { id: string; userId: string }[]> {
  return await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select(["id", "userId"])
    .where("organizationId", "=", organizationId)
    .where("role", "=", role)
    .orderBy("id", "asc")
    .execute();
}

/** What an offer names: where, to whom, from whom, and until when. */
export interface NominateOptions<Role extends string> {
  /** The organization being offered, from the gate. Never from the request body. */
  readonly organizationId: string;
  /** The nominee's membership. Resolved inside that organization or refused. */
  readonly membershipId: string;
  /** Who made the offer, in `pithy_auth_users`. Kept because the transfer is audited against it. */
  readonly nominatedByUserId: string;
  /** When the offer stops being acceptable. Must be in the future. */
  readonly expiresAt: Date;
  /** The roles this transfer moves. */
  readonly roles: OwnershipRoles<Role>;
  /** The clock. Injected so a caller decides what "now" is and tests are deterministic. */
  readonly now: Date;
}

/**
 * Offer the account to a member.
 *
 * **Nominating again replaces**, because the table is keyed by organization — one account offers itself
 * to at most one person at a time. Changing your mind is therefore one act rather than a withdrawal and
 * a re-offer with a window between them in which two people could both accept.
 *
 * The nominee is named by **membership**, not by user, so removing them takes the offer with them.
 */
export async function nominate<Power extends string, Role extends string>(
  db: OrganizationDatabase,
  catalog: RoleCatalog<Power, Role>,
  options: NominateOptions<Role>,
): Promise<OwnershipNomination> {
  requireTransferableRoles(catalog, options.roles);

  if (options.expiresAt.getTime() <= options.now.getTime()) {
    // Refused where it is made rather than where it is read. An offer that is already dead is a row
    // somebody's screen would show as standing, and a withdrawal they would have to make for nothing.
    throw new OrganizationNominationInvalidError({
      message: "That offer would already have expired.",
      action: "Give it a date in the future.",
      detail: `nomination for organization ${options.organizationId} expires at ${options.expiresAt.toISOString()}, at or before now`,
    });
  }

  const holders = await holdersOf(db, options.organizationId, options.roles.confers);
  // **While somebody holds the account, only they hand it on.** Checked before the membership is even
  // resolved, so a caller with no standing learns nothing about which membership ids are in the account.
  if (holders.length > 0 && !holders.some((holder) => holder.userId === options.nominatedByUserId)) {
    throw new OrganizationForbiddenError({
      message: "Only somebody who already holds this organization can hand it on.",
      action: "Ask the current holder.",
      detail: `user ${options.nominatedByUserId} does not hold ${options.roles.confers} in organization ${options.organizationId}`,
    });
  }

  const nominee = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select(["id", "userId", "role"])
    // Both halves in one predicate. A lookup by id alone would offer another organization's account to
    // somebody who is not in this one.
    .where("id", "=", options.membershipId)
    .where("organizationId", "=", options.organizationId)
    .executeTakeFirst();
  if (!nominee) {
    throw new OrganizationNominationInvalidError({
      message: "No such member.",
      action: "Offer it to somebody who is in the organization.",
      detail: `membership ${options.membershipId} is not in organization ${options.organizationId}`,
    });
  }
  // **While nobody holds it, you may volunteer and may not appoint.** Reachable only in an unheld
  // account — the rule above refused a non-holder otherwise.
  if (holders.length === 0 && nominee.userId !== options.nominatedByUserId) {
    throw new OrganizationForbiddenError({
      message: "You cannot hand this organization to somebody else.",
      action: "Take it on yourself, or wait until somebody holds it and ask them.",
      detail: `user ${options.nominatedByUserId} may nominate only themselves while organization ${options.organizationId} has no holder of ${options.roles.confers}`,
    });
  }
  if (nominee.role === options.roles.confers) {
    throw new OrganizationNominationInvalidError({
      message: "That person already holds this organization.",
      detail: `membership ${nominee.id} already holds ${options.roles.confers}`,
    });
  }

  const nomination: OwnershipNomination = {
    organizationId: options.organizationId,
    membershipId: nominee.id,
    nominatedByUserId: options.nominatedByUserId,
    expiresAt: options.expiresAt,
    createdAt: options.now,
  };
  const values = OwnershipNomination.encode(nomination);
  await db
    .insertInto(OWNERSHIP_NOMINATIONS_TABLE)
    .values(values)
    .onConflict((conflict) => conflict.column("organizationId").doUpdateSet(values))
    .execute();

  return nomination;
}

/**
 * The offer standing in this organization, or null.
 *
 * **Expired offers read as none**, and the row is left in place rather than swept: nothing can accept
 * it, the next nomination replaces it, and a sweep is a schedule to maintain for one DELETE that changes
 * no answer.
 */
export async function standingNomination(
  db: OrganizationDatabase,
  organizationId: string,
  now: Date,
): Promise<OwnershipNomination | null> {
  const row = await db
    .selectFrom(OWNERSHIP_NOMINATIONS_TABLE)
    .selectAll()
    .where("organizationId", "=", organizationId)
    .where("expiresAt", ">", SQLiteDate.encode(now))
    .executeTakeFirst();
  return row ? OwnershipNomination.parse(row) : null;
}

/**
 * Withdraw the standing offer. Returns whether there was one.
 *
 * No catalog and no roles, because withdrawing grants nobody anything — which is also why the route in
 * front of it may be wider than the one in front of {@link nominate}.
 */
export async function withdrawNomination(db: OrganizationDatabase, organizationId: string): Promise<boolean> {
  const deleted = await db
    .deleteFrom(OWNERSHIP_NOMINATIONS_TABLE)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();
  return (deleted.numDeletedRows ?? 0n) > 0n;
}

/** What a transfer moved, once it has. */
export interface TransferredOwnership {
  /** The membership that now holds the conferred role. */
  readonly newHolderMembershipId: string;
  /**
   * The memberships that held it and now hold {@link OwnershipRoles.demotesTo}.
   *
   * Empty is the ordinary case for a young account: nobody had agreed to pay, and now somebody has. A
   * list rather than one id because nothing in the kit's schema holds the account to a single holder —
   * the dashboard had a partial unique index and this capability does not, so the write demotes whoever
   * it finds instead of assuming it finds one.
   */
  readonly previousHolderMembershipIds: readonly string[];
}

/** What an acceptance names: where, by whom, when, and which roles move. */
export interface AcceptNominationOptions<Role extends string> {
  /** The organization in force, from the gate. */
  readonly organizationId: string;
  /** The accepting person, as the gate proved them. Compared against the offer's nominee. */
  readonly userId: string;
  /** The clock. An offer past its expiry is not acceptable. */
  readonly now: Date;
  /** The roles this transfer moves. The same pair the offer was made under. */
  readonly roles: OwnershipRoles<Role>;
}

/**
 * Accept the account. **The nominee alone**, and it is the acceptance that makes the transfer.
 *
 * **Four facts, one refusal, deliberately.** No offer, an expired one, an offer whose membership is
 * gone, and an offer made to somebody else all answer
 * {@link OrganizationNominationInvalidError} with the same sentence. A caller who could tell them apart
 * could ask "is there an offer standing in this account, and is it mine" and read out an answer about
 * somebody else's arrangement; the difference lives in `detail`, which the HTTP codec strips and the log
 * keeps.
 *
 * The previous holders are demoted in the same write — not removed, and not left holding the role
 * alongside the new one.
 */
export async function acceptNomination<Power extends string, Role extends string>(
  d1: D1Database,
  catalog: RoleCatalog<Power, Role>,
  options: AcceptNominationOptions<Role>,
): Promise<TransferredOwnership> {
  requireTransferableRoles(catalog, options.roles);
  const db = organizationDatabase(d1);

  const nomination = await standingNomination(db, options.organizationId, options.now);
  if (nomination === null) throw noOffer(options, "no live nomination");

  const nominee = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select(["id", "userId"])
    .where("id", "=", nomination.membershipId)
    .where("organizationId", "=", options.organizationId)
    .executeTakeFirst();
  // The membership is gone and nothing cascaded it away, because D1 has no foreign keys. An offer whose
  // nominee has left is an offer nobody can accept, which is the same answer as no offer at all.
  if (!nominee) throw noOffer(options, `nominated membership ${nomination.membershipId} is no longer in the account`);
  // The whole of the two-party rule, in one comparison. Somebody else accepting on the nominee's behalf
  // is exactly the click this design exists to make impossible.
  if (nominee.userId !== options.userId) throw noOffer(options, `user ${options.userId} is not the nominee`);

  const previous = (await holdersOf(db, options.organizationId, options.roles.confers)).filter(
    (holder) => holder.id !== nominee.id,
  );

  const statements: D1PreparedStatement[] = [];
  if (previous.length > 0) {
    // One statement for however many hold it, and first — see the module note on ordering. Excluding the
    // nominee by id is belt and braces: `nominate` refuses an offer to somebody who already holds the
    // role, and a demotion that also matched the nominee would undo the promotion two statements later.
    statements.push(
      prepared(
        d1,
        db
          .updateTable(MEMBERSHIPS_TABLE)
          .set({ role: options.roles.demotesTo })
          .where("organizationId", "=", options.organizationId)
          .where("role", "=", options.roles.confers)
          .where("id", "!=", nominee.id),
      ),
    );
  }
  statements.push(
    prepared(
      d1,
      db
        .updateTable(MEMBERSHIPS_TABLE)
        .set({ role: options.roles.confers })
        .where("id", "=", nominee.id)
        // The organization again, in the write. The read above proved it; this makes the statement unable
        // to touch another organization's row whatever a later refactor does to the order above.
        .where("organizationId", "=", options.organizationId),
    ),
    /*
      **The offer is spent by a conditional delete, and that condition is what makes the transfer safe.**

      Everything above is a read, and three awaits separate the read of the nomination from this batch.
      In that window the holder can withdraw the offer, or replace it by nominating somebody else — both
      are single statements on the same row, and both return to their caller saying the offer is gone.
      An unconditional `delete … where organization_id = ?` honours an offer that no longer stands, and
      in the replaced case deletes the *replacement* while promoting the person it superseded.

      So the delete names the membership as well as the organization, and the batch is refused unless it
      removed exactly one row. This is the same shape `invite.ts` uses for redemption, for the same
      reason: of N interleavings exactly one may win, and the one that loses must change nothing.

      **The order matters and is the reverse of the obvious one.** D1's `batch` is a transaction, so a
      failure anywhere rolls the whole thing back — which is what lets the two role writes go first and
      the condition last. Checking first and writing after would be the read-then-write this replaces.
    */
    prepared(
      d1,
      db
        .deleteFrom(OWNERSHIP_NOMINATIONS_TABLE)
        .where("organizationId", "=", options.organizationId)
        .where("membershipId", "=", nominee.id),
    ),
  );

  const written = await withD1Retry(() => d1.batch(statements));
  const spent = written.at(-1);
  if (spent?.meta?.changes !== 1) {
    // Withdrawn, or replaced with somebody else, between the read and the write. The batch rolled back,
    // so nothing moved — and the caller is told the offer is not theirs to accept, which is now true.
    throw noOffer(options, `the nomination naming membership ${nominee.id} was gone by the time it was accepted`);
  }

  return { newHolderMembershipId: nominee.id, previousHolderMembershipIds: previous.map((holder) => holder.id) };
}

/** The one refusal every unacceptable offer gets, with the fact that distinguishes it in `detail`. */
function noOffer<Role extends string>(
  options: AcceptNominationOptions<Role>,
  detail: string,
): OrganizationNominationInvalidError {
  return new OrganizationNominationInvalidError({
    detail: `organization ${options.organizationId}: ${detail}`,
  });
}

/** Compile a Kysely query to a D1 statement, so it can join a `batch` transaction. */
function prepared(d1: D1Database, query: { compile(): CompiledQuery }): D1PreparedStatement {
  const compiled = query.compile();
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}
