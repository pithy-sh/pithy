// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { ActingOrganization } from "../data/actingOrganization";
import { MAX_ROLE_LENGTH } from "../data/membership";
import { ACTING_TABLE, MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, type OrganizationDatabase } from "../data/tables";
import { OrganizationNotFoundError } from "../error/errors";
import type { RoleCatalog } from "../roles/roles";

/**
 * Turning a signed-in session into *what this caller is entitled to do here*.
 *
 * Every tenanted route depends on this one answer. If this step can be talked into answering for an
 * organization the caller does not belong to, every gate downstream is decoration — so the rules below
 * are not conventions, they are the security model.
 *
 * **The answer comes from the session, never from the path.** A slug in the URL means a member of two
 * accounts addresses either by typing a different address, and the screen can no longer be trusted to
 * say what is in force. A URL that cannot name another tenant cannot be pointed at one. Where a route
 * *does* name one — an admin surface addressed by id — {@link resolveActingIn} answers it, and it
 * proves membership in the same statement rather than after it.
 *
 * **One query, and it names both halves.** The user and the organization are matched in the same
 * `where`, so there is no window in which one has been established and the other has not, and no shape
 * of the code where a caller passes the membership check for one organization and acts on another. The
 * two obvious bugs are a filter on the selection that forgets the user and a filter on the user that
 * forgets the selection; both produce a real row attached to the wrong organization.
 *
 * **The stored selection is a preference; the membership is the authority.** Nothing about a role is
 * cached and nothing rides on the session but the id of the choice, so removing a membership row is the
 * whole of revocation — it takes effect on the next request, with no sign-out and no cache to expire. A
 * role carried in a session claim would keep working for exactly the interval during which somebody
 * decided it should not.
 *
 * **A selection whose membership is gone is no selection, not a refusal.** The person is still signed
 * in and may still belong elsewhere; being removed from one account is not being removed from the
 * product. The rejoin is what makes that automatic rather than a cleanup job somebody has to run.
 *
 * **A role is decoded, never asserted.** The column is text — the catalog belongs to the adopter and is
 * not known when the schema compiles — so a repair script, a rolled-back deploy, or a bug can put
 * anything in it. A role matching no entry in the matrix would deny everything today and, one refactor
 * later, allow it; decoding through `catalog.Role` makes an unrecognized value a refusal while there is
 * still a request to refuse.
 *
 * **Refusals are {@link OrganizationNotFoundError}, always, and identical.** "Not a member" and "no such
 * organization" are one answer to a client, because a distinguishable one is an existence oracle and
 * iterating it produces the tenant list. The distinction is real and lives in `detail`, which the HTTP
 * codec strips and the log keeps.
 */

const ActingMembershipShape = z
  .object({
    organizationId: z
      .uuid()
      .describe(
        "The organization this request acts for. Every tenanted query filters on it — the boundary is a column, not a convention.",
      ),
    slug: z
      .string()
      .min(1)
      .describe("The organization's URL-safe short name. For display and for logs; never for addressing."),
    name: z.string().min(1).describe("The organization's display name, for a header or a chooser. Never authorizes."),
    userId: z
      .string()
      .min(1)
      .describe(
        "The signed-in person acting, from `c.var.auth.userId`. References `pithy_auth_users(id)` and becomes the actor on any audit event this request writes.",
      ),
    role: z
      .string()
      .min(1)
      .max(MAX_ROLE_LENGTH)
      .describe(
        "What this person may do here, read from the membership row on this request and decoded through `catalog.Role`. Text at this object because the catalog is the adopter's; narrowed to the declared union by the generic type of the same name. Never from a session claim, so a demotion takes effect on the next request rather than on the next sign-in.",
      ),
    chosen: z
      .boolean()
      .describe(
        "Whether somebody picked this, as against arriving at it some other way — the only account they have, or an organization a route named. False is what a chooser exists to turn into true; nothing authorizes on it.",
      ),
  })
  .describe(
    "The organization a request is acting for and the membership that entitles it. Produced only by a resolver in this module, each of which proves the membership in the same statement that reads the organization.",
  );

/**
 * The resolved membership — what `c.var.acting` carries.
 *
 * The Zod object is the documentation and the boundary parse; the type is generic so the declared role
 * union flows through to a handler and `acting.role` narrows to the names `defineRoles` was given.
 */
export const ActingMembership = ActingMembershipShape;
export type ActingMembership<Role extends string = string> = Omit<z.output<typeof ActingMembershipShape>, "role"> & {
  /** What this person may do here — one of the declared roles, decoded off the membership row. */
  readonly role: Role;
};

/** Who is asking, and through which session. Both from `c.var.auth`, never from a body or a header. */
export interface ActingLookup {
  /** The signed-in person, from `c.var.auth.userId`. */
  readonly userId: string;
  /** The session, from `c.var.auth.sessionId`. What the selection is keyed by. */
  readonly sessionId: string;
}

/** Who is asking, and which organization a route named. The pair is matched in one predicate. */
export interface ActingInLookup {
  /** The signed-in person, from `c.var.auth.userId`. */
  readonly userId: string;
  /** The organization the route named. Proved against a membership of this person, never trusted. */
  readonly organizationId: string;
}

/** What choosing takes. The membership is proved here before anything is written. */
export interface ChooseActingOptions extends ActingLookup {
  /** The organization to act in. Refused unless this person holds a membership in it. */
  readonly organizationId: string;
  /**
   * Whether this was a decision. Defaults to true, because every door in the chooser is one — including
   * the one somebody with a single membership is put through without being asked, which is still a
   * selection and still writes a row. False is for a product that seats somebody on their behalf.
   */
  readonly chosen?: boolean;
  /** The clock. Injected so tests are deterministic. */
  readonly now?: Date;
}

/** What clearing takes. Sign-out, and nothing else, so it is keyed by the session alone. */
export interface ClearActingOptions {
  /** The session whose selection ends. */
  readonly sessionId: string;
}

/** One row of the join every read here makes: a membership, with the organization it is in. */
interface ActingRow {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly role: string;
}

/**
 * The base join: a membership of this person, with the organization it grants access to.
 *
 * **Never one without the other.** Reading memberships alone answers "which organizations" with ids and
 * no names; reading organizations alone answers with every tenant in the database. The join is the
 * question, and every resolver below narrows it rather than replacing it.
 */
function memberOrganizations(db: OrganizationDatabase, userId: string) {
  return db
    .selectFrom(MEMBERSHIPS_TABLE)
    .innerJoin(ORGANIZATIONS_TABLE, `${ORGANIZATIONS_TABLE}.id`, `${MEMBERSHIPS_TABLE}.organizationId`)
    .select([
      `${ORGANIZATIONS_TABLE}.id as organizationId`,
      `${ORGANIZATIONS_TABLE}.name as name`,
      `${ORGANIZATIONS_TABLE}.slug as slug`,
      `${MEMBERSHIPS_TABLE}.role as role`,
    ])
    .where(`${MEMBERSHIPS_TABLE}.userId`, "=", userId);
}

/**
 * The one refusal for "no such organization" and "not one of yours".
 *
 * A factory rather than seven throw sites, because the property only holds if every producer says the
 * same thing. The default message is the whole client answer; `why` is the operator's half and reaches
 * the log alone.
 */
export function noSuchOrganization(why: string): OrganizationNotFoundError {
  return new OrganizationNotFoundError({ detail: why });
}

/**
 * The organization a session is acting in, or null.
 *
 * Null is a real state, not a failure: nobody has chosen yet, or the selection they had is no longer
 * backed by a membership. A caller that needs a refusal — a gate — decides what to say about that;
 * this decides the fact.
 *
 * **The selection and the membership in one query.** A join to the acting table on the session alone
 * would answer out of whatever row that session holds; a join on the membership alone would answer out
 * of any organization this person belongs to. Neither is the question, and both are rows that exist.
 */
export async function resolveActing<Power extends string, Role extends string>(
  db: OrganizationDatabase,
  catalog: RoleCatalog<Power, Role>,
  lookup: ActingLookup,
): Promise<ActingMembership<Role> | null> {
  const row = await memberOrganizations(db, lookup.userId)
    .innerJoin(ACTING_TABLE, `${ACTING_TABLE}.organizationId`, `${MEMBERSHIPS_TABLE}.organizationId`)
    .select(`${ACTING_TABLE}.chosen as chosen`)
    .where(`${ACTING_TABLE}.sessionId`, "=", lookup.sessionId)
    // The user, a second time and on the other table. A session id is not a secret to this row, so a
    // selection written under one person must not answer for another who reuses the id.
    .where(`${ACTING_TABLE}.userId`, "=", lookup.userId)
    .executeTakeFirst();
  if (!row) return null;
  // **Read off the row, not assumed true.** The column is the half a single `activeOrganizationId`
  // cannot express, and a resolver that hardcoded it would make the chooser unable to tell somebody who
  // picked from somebody who was put there. A value SQLite holds that is neither 0 nor 1 lands as *not
  // chosen*, which is the safe direction because nothing authorizes on it — at worst a chooser offers a
  // choice that had already been made.
  const chosen = SQLiteBoolean.safeParse(row.chosen);
  return decode(catalog, row, lookup.userId, chosen.success && chosen.data);
}

/**
 * The membership a named organization entitles this caller to, or null.
 *
 * What a route that addresses an organization by id resolves through. **The predicate matches the user
 * and the organization in the same `where`** — there is no shape of this in which a caller passes the
 * membership check for one organization and acts on another, because there is only one check and it
 * names both.
 *
 * `chosen` is false here and that is the honest answer rather than a default: nobody picked this, a
 * route named it. What a chooser keys on is the session's own selection, which this path does not read
 * and does not write.
 */
export async function resolveActingIn<Power extends string, Role extends string>(
  db: OrganizationDatabase,
  catalog: RoleCatalog<Power, Role>,
  lookup: ActingInLookup,
): Promise<ActingMembership<Role> | null> {
  const row = await memberOrganizations(db, lookup.userId)
    .where(`${ORGANIZATIONS_TABLE}.id`, "=", lookup.organizationId)
    .executeTakeFirst();
  if (!row) return null;
  return decode(catalog, row, lookup.userId, false);
}

/**
 * Choose the organization this session acts in, or refuse.
 *
 * **This is the whole boundary on the write side.** Everything downstream reads a session and trusts
 * the row, so this is the one place an organization a caller named becomes the one they act in — and it
 * proves the membership before a row is written, in the predicate that names both halves. The refusal
 * is the same 404 a non-member gets anywhere else, for the same reason: a distinguishable answer is an
 * oracle for which organizations exist.
 *
 * **Proved, then written, and the gap between the two is covered by the read.** A membership revoked
 * between the proof and the insert would leave a selection nothing backs — which grants nothing,
 * because {@link resolveActing} rejoins memberships on every request. That is why this does not need a
 * transaction it could not have on D1.
 *
 * The write is a conflict-update on the session id, so choosing twice is one row and there is no moment
 * at which a session holds two answers. It replaces the whole value, the user id included, so a session
 * id reused after a sign-out cannot inherit the previous person's selection.
 */
export async function chooseActing(db: OrganizationDatabase, options: ChooseActingOptions): Promise<void> {
  const membership = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select("id")
    // Both halves, in one predicate. Neither is meaningful without the other.
    .where("userId", "=", options.userId)
    .where("organizationId", "=", options.organizationId)
    .executeTakeFirst();
  if (!membership) {
    throw noSuchOrganization(`user ${options.userId} has no membership in organization ${options.organizationId}`);
  }

  const values = ActingOrganization.encode({
    sessionId: options.sessionId,
    userId: options.userId,
    organizationId: options.organizationId,
    chosen: options.chosen ?? true,
    chosenAt: options.now ?? new Date(),
  });
  await db
    .insertInto(ACTING_TABLE)
    .values(values)
    .onConflict((conflict) => conflict.column("sessionId").doUpdateSet(values))
    .execute();
}

/**
 * Every organization this person may act in, for the chooser.
 *
 * Ordered by name, which is the order the chooser lists them in — so a product that picks the first row
 * for somebody who has not chosen picks the same one the list would have shown first, rather than
 * whatever D1 returned.
 *
 * **A role the catalog does not know refuses the whole list**, rather than being skipped. Skipping would
 * hide an organization from the one screen that exists to say which ones there are, and it would hide
 * the deployment mistake that put the value there. A catalog that cannot name a role somebody holds is
 * loud on purpose.
 */
export async function listActable<Power extends string, Role extends string>(
  db: OrganizationDatabase,
  catalog: RoleCatalog<Power, Role>,
  userId: string,
): Promise<ActingMembership<Role>[]> {
  const rows = await memberOrganizations(db, userId).orderBy(`${ORGANIZATIONS_TABLE}.name`, "asc").execute();
  return rows.map((row) => decode(catalog, row, userId, false));
}

/**
 * Whether this person holds a membership anywhere.
 *
 * The one question that separates *has not chosen yet* from *belongs to nothing*, and they deserve
 * different sentences: one is answered by a chooser, the other by an invitation. No role is decoded —
 * this counts rows and nothing else, so a catalog that cannot name one role does not turn "you belong
 * somewhere" into an error on the path that was about to say so.
 */
export async function hasAnyMembership(db: OrganizationDatabase, userId: string): Promise<boolean> {
  const row = await db.selectFrom(MEMBERSHIPS_TABLE).select("id").where("userId", "=", userId).executeTakeFirst();
  return row !== undefined;
}

/**
 * End this session's selection.
 *
 * Keyed by the session alone, because the act it serves is a sign-out and a sign-out knows one session.
 * Nothing else in this module is; everything that grants is matched on the user as well.
 */
export async function clearActing(db: OrganizationDatabase, options: ClearActingOptions): Promise<void> {
  await db.deleteFrom(ACTING_TABLE).where("sessionId", "=", options.sessionId).execute();
}

/**
 * A row into a resolved membership, refusing an unrecognized role.
 *
 * The refusal is the same 404 as every other one here, and deliberately: a caller must not be able to
 * tell "the row holds a role nobody declared" from "there is no such organization". Whatever is in that
 * column, the answer to *may this person act* has to be no rather than undefined.
 */
function decode<Power extends string, Role extends string>(
  catalog: RoleCatalog<Power, Role>,
  row: ActingRow,
  userId: string,
  chosen: boolean,
): ActingMembership<Role> {
  const role = catalog.Role.safeParse(row.role);
  if (!role.success) {
    throw noSuchOrganization(
      `membership of user ${userId} in organization ${row.organizationId} holds a role this catalog does not declare`,
    );
  }
  const acting: ActingMembership<Role> = {
    organizationId: row.organizationId,
    slug: row.slug,
    name: row.name,
    userId,
    role: role.data,
    chosen,
  };
  // Validated rather than trusted. The row crossed a boundary — a text column with a pattern nobody
  // checked on the way in would otherwise become an organization id every tenanted query filters on.
  ActingMembership.parse(acting);
  return acting;
}
