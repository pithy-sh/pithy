// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { type CompiledQuery, sql } from "kysely";
import { Invitation } from "../data/invitation";
import { Membership } from "../data/membership";
import { INVITATIONS_TABLE, MEMBERSHIPS_TABLE, type OrganizationDatabase, organizationDatabase } from "../data/tables";
import { OrganizationForbiddenError, OrganizationInvitationInvalidError } from "../error/errors";
import type { RoleCatalog } from "../roles/roles";
import { invitationDigest, mintInvitationToken } from "./token";

/**
 * Inviting somebody, and what has to be true before they are inside.
 *
 * A membership is created here or by provisioning, and nowhere else. Those are the two ways into an
 * organization: found one, or accept an offer of one.
 *
 * ## What makes an invitation safe is not its token
 *
 * The token is 256 random bits and the table stores only its digest, so it cannot be guessed and the row
 * cannot be redeemed. That is table stakes, and it is less than it sounds — the mail that carries the
 * link is itself a row, and `@pithy-sh/email` writes every enqueued job's payload into D1 and never
 * deletes it. Read the digest for what it is: it keeps the token out of *this* table, not out of the
 * database. `../mail/invitation.ts` says the same thing at the send site.
 *
 * The property that actually carries the design is the second one:
 *
 * **acceptance requires a signed-in session whose own address equals the invited address.** A forwarded
 * link, a link in a shared inbox, a link in a screenshot — none of them grant anything to whoever holds
 * them. This is the difference between "we mailed a credential" and "we made an offer to a person", and
 * it is why the address is a column rather than something the mail merely happened to be sent to.
 *
 * ## Every refusal is one refusal
 *
 * No such token, expired, withdrawn, already accepted, offered a role the catalog no longer declares,
 * and presented by the wrong address all throw {@link OrganizationInvitationInvalidError} with its
 * default message. **A caller must not be able to tell "no such token" from "wrong address"**, because
 * telling somebody which it was tells whoever a link was forwarded to exactly the same thing — and the
 * address binding is the whole reason a forwarded link is useless. The difference is carried in
 * `detail`, which the HTTP codec strips and the log keeps.
 *
 * ## Single use is a property of the write
 *
 * Acceptance moves `status` under a condition and creates the membership under the *same* condition, in
 * one `d1.batch` — which D1 runs as a transaction. So of N concurrent redemptions of one link, exactly
 * one inserts a membership: the others find the row no longer `pending` and both of their statements
 * match nothing. A read-then-write would leave a window in which one offer becomes two memberships, and
 * the second would be invisible on every screen that shows a count.
 *
 * The `(organizationId, userId)` unique index on memberships is the backstop underneath that, and it is
 * what makes two *different* invitations to the same person collapse into one membership rather than
 * two rows nobody can tell apart.
 *
 * ## One live token per address, always
 *
 * Inviting an address that already holds a live offer **supersedes** it: the standing row is canceled in
 * the same call that mints the new one. Two live tokens for one address would make withdrawing one of
 * them a revoke that does not revoke — whichever copy the recipient kept would still work. Refusing
 * instead was the other option and it is the one a batch-shaped API wants, because it can report per
 * address; this one takes a single address and has nowhere to put that answer except an exception, and
 * an exception for "they already have one" reads as a failure when the caller's intent is satisfiable.
 */

/** Milliseconds in a day, for the one arithmetic this module does. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** What minting one invitation takes. */
export interface InviteOptions<Role extends string> {
  /** The organization being joined. From the gate, never from the request body. */
  readonly organizationId: string;
  /** The address invited, as it was typed. Normalized here — see {@link invite}. */
  readonly email: string;
  /** What is being offered. Checked against the catalog's assignable set before anything is written. */
  readonly role: Role;
  /** Who is making the offer. Named on the accept screen and in the audit trail. */
  readonly invitedByUserId: string;
  /** How many days the link stays redeemable. The project's `invitationTtlDays`. */
  readonly ttlDays: number;
  /** The clock. One instant for the row and its expiry, injected so tests are deterministic. */
  readonly now: Date;
  /** The id source. A seam: production passes nothing and gets `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** The token source. A seam, for the same reason — nothing in production passes it. */
  readonly mintToken?: () => string;
}

/** A new invitation, and the one copy of its token that will ever exist outside the mail. */
export interface MintedInvitation {
  /** The row, decoded — so a caller never re-reads what it just wrote. */
  readonly invitation: Invitation;
  /**
   * The plaintext token, for the link in the mail.
   *
   * Returned rather than stored, and it must not be logged, audited, or put in a response body that
   * anyone but the invitee can read. The row holds its digest and cannot produce it again.
   */
  readonly token: string;
}

/**
 * Mint an offer of membership, bound to an address.
 *
 * **The address is normalized and the shape is not checked here.** `normalizeAddress` is the one rule
 * the whole kit compares addresses by, and it is total: every string has a normal form. Whether a string
 * *is* an address is the question the route's own schema answers, at the boundary that accepted it — a
 * normalizer that also rejected would be a second opinion about a value the boundary already refused.
 * The column's bounds are the backstop.
 *
 * **The role is checked against the catalog's assignable set, and an unknown role and an excluded one
 * are the same refusal.** Assignability is derived by exclusion, so `owner` — a role that moves only by
 * a two-party transfer — is refused here for the same reason a typo is: neither is a role one member may
 * hand another.
 *
 * The power to invite at all is not checked here. That is the route's gate, and it is a fact about the
 * caller rather than about the offer; putting it here would mean every call site that wrote an
 * invitation had to be trusted to have an acting context to check.
 *
 * The mail is not sent here either. This mints the offer and hands back its token; the caller sends it
 * through the composed email capability. Keeping the send out is what lets the write be tested against
 * real D1 with no mail transport, and what stops a failed enqueue from being confused with a failed
 * insert.
 */
export async function invite<Power extends string, Role extends string>(
  d1: D1Database,
  catalog: RoleCatalog<Power, Role>,
  options: InviteOptions<Role>,
): Promise<MintedInvitation> {
  const db = organizationDatabase(d1);
  const email = normalizeAddress(options.email);

  const role = catalog.AssignableRole.safeParse(options.role);
  if (!role.success) {
    throw new OrganizationForbiddenError({
      message: `\`${options.role}\` is not a role anybody may be given.`,
      action: "Offer one of the roles this project declares as assignable.",
      detail: `role ${JSON.stringify(options.role)} is not in the catalog's assignable set (${catalog.assignableRoles.join(", ")})`,
    });
  }

  const token = (options.mintToken ?? mintInvitationToken)();
  const invitation: Invitation = {
    id: (options.newId ?? (() => crypto.randomUUID()))(),
    organizationId: options.organizationId,
    email,
    role: role.data,
    invitedByUserId: options.invitedByUserId,
    tokenDigest: await invitationDigest(token),
    status: "pending",
    expiresAt: new Date(options.now.getTime() + options.ttlDays * DAY_MS),
    acceptedAt: null,
    createdAt: options.now,
  };
  /*
    **Supersede and mint in one `d1.batch`, which D1 runs as a transaction.**

    These were two awaits, and two concurrent invitations to one mailbox — a double-clicked button, a
    retried POST — both found nothing to supersede and both inserted. The account then held two live
    tokens for one person, and withdrawing the one a pane happened to show was a revoke that did not
    revoke: whichever copy the recipient kept still worked for the rest of its TTL.

    One batch makes "replace the standing offer" a single act, which is the same shape and the same
    reason `acceptInvitation` below takes the binding rather than the database. Taking `D1Database` here
    is the second of the two asymmetries in this module, and the note on that function explains why a
    transaction cannot be got out of a Kysely instance that never had one.

    The cancel is unconditional on expiry: an expired pending row cannot be redeemed anyway, and moving
    it to `canceled` keeps "what is outstanding" answerable by status alone.
  */
  const supersede = db
    .updateTable(INVITATIONS_TABLE)
    .set({ status: "canceled" })
    .where("organizationId", "=", options.organizationId)
    .where("email", "=", email)
    .where("status", "=", "pending");
  const mint = db.insertInto(INVITATIONS_TABLE).values(Invitation.encode(invitation));

  /*
    **The partial unique index stays underneath this, and it is not redundant.**

    `pithy_organization_invitations_one_live_idx` is a property of the database, so it holds for a writer
    that never came through here — a bulk invite, an admin tool, a repair script. A transaction makes
    *this* path atomic; the index is what makes the invariant true of the table.

    A violation reaching here means such a writer exists and raced us, so it is reported as itself rather
    than swallowed: the caller learns the offer was not written, which is true, instead of being handed a
    token that is not the live one.
  */
  await withD1Retry(() => d1.batch([prepared(d1, supersede.compile()), prepared(d1, mint.compile())]));

  return { invitation, token };
}

/**
 * Every invitation outstanding in one organization, newest first.
 *
 * `pending` only, expired ones included. An expired offer is not a mistake to hide — it is the answer to
 * "why has that person not appeared", and the pane needs it in order to offer the resend that fixes it.
 * Accepted, rejected and withdrawn rows stay in the table as history and off this list, because the
 * list's job is "what is outstanding" rather than "what has ever been sent".
 */
export async function listInvitations(
  db: OrganizationDatabase,
  organizationId: string,
): Promise<readonly Invitation[]> {
  const rows = await db
    .selectFrom(INVITATIONS_TABLE)
    .selectAll()
    .where("organizationId", "=", organizationId)
    .where("status", "=", "pending")
    .orderBy("createdAt", "desc")
    .execute();
  return rows.map((row) => Invitation.parse(row));
}

/** What withdrawing or resending names: the organization in force, and which offer. */
export interface InvitationActOptions {
  /** The organization in force, from the gate. Half of the predicate that resolves the row. */
  readonly organizationId: string;
  /** The invitation being acted on. Resolved inside that organization or refused. */
  readonly invitationId: string;
  /** The clock. Injected so tests are deterministic. */
  readonly now: Date;
}

/**
 * Withdraw an outstanding invitation.
 *
 * A conditional update rather than a delete, and rather than a read-then-write. Conditional, so an
 * invitation accepted a moment ago is not quietly canceled *after* the membership exists — the write
 * matches nothing and the caller is told the offer is no longer open. A cancellation is history worth
 * keeping: "we invited them and thought better of it" is a different account of a fortnight from "we
 * never invited them".
 */
export async function withdrawInvitation(db: OrganizationDatabase, options: InvitationActOptions): Promise<Invitation> {
  const invitation = await requireInvitationInOrganization(db, options.organizationId, options.invitationId);

  const canceled = await db
    .updateTable(INVITATIONS_TABLE)
    .set({ status: "canceled" })
    .where("id", "=", invitation.id)
    .where("organizationId", "=", options.organizationId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (canceled.numUpdatedRows !== 1n) {
    throw invitationInvalid(`invitation ${invitation.id} was not pending when a withdrawal was attempted`);
  }

  return { ...invitation, status: "canceled" };
}

/** What resending one invitation takes: the act, plus how long the new link should live. */
export interface ResendInvitationOptions extends InvitationActOptions {
  /** How many days the replacement link stays redeemable. The project's `invitationTtlDays`. */
  readonly ttlDays: number;
  /** The token source. A seam; nothing in production passes it. */
  readonly mintToken?: () => string;
}

/**
 * Send an invitation again.
 *
 * **A resend mints a new token and kills the old one.** The alternative — mailing the same token again —
 * would mean an address that received two mails holds two working links, so withdrawing the invitation
 * later leaves whichever copy somebody kept still functioning. One live token per offer, always, and the
 * digest column is where that is enforced: writing a new digest is what makes the old one match nothing.
 *
 * The expiry restarts with it, because the reason to resend is that the first one is about to die or
 * already has. Reviving an expired offer this way is deliberate and is the same act as making a new one,
 * minus the row — which is why the caller's power to assign the offered role has to be checked again at
 * the route. An offer of an administering role made by somebody who has since gone is an administrator
 * waiting to be minted, and a resend is what would mint it.
 */
export async function resendInvitation(
  db: OrganizationDatabase,
  options: ResendInvitationOptions,
): Promise<MintedInvitation> {
  const invitation = await requireInvitationInOrganization(db, options.organizationId, options.invitationId);

  const token = (options.mintToken ?? mintInvitationToken)();
  const refreshed: Invitation = {
    ...invitation,
    tokenDigest: await invitationDigest(token),
    expiresAt: new Date(options.now.getTime() + options.ttlDays * DAY_MS),
    createdAt: options.now,
  };
  const encoded = Invitation.encode(refreshed);

  const resent = await db
    .updateTable(INVITATIONS_TABLE)
    .set({ tokenDigest: encoded.tokenDigest, expiresAt: encoded.expiresAt, createdAt: encoded.createdAt })
    .where("id", "=", invitation.id)
    .where("organizationId", "=", options.organizationId)
    // Conditional on the same status every other act here is: an accepted invitation is not resendable,
    // and resending a withdrawn one would be a revoke undone by a button labeled "send again".
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (resent.numUpdatedRows !== 1n) {
    throw invitationInvalid(`invitation ${invitation.id} was not pending when a resend was attempted`);
  }

  return { invitation: refreshed, token };
}

/** The session redeeming an invitation. Both halves from the signed-in session, never from a body. */
export interface AcceptingSession {
  /** Who is signed in. */
  readonly userId: string;
  /** The address they are signed in as. Compared against the invited one — this is the authorization. */
  readonly email: string;
}

/** What accepting takes: the token from the link, and the session redeeming it. */
export interface AcceptInvitationOptions {
  /** The plaintext token from the link. Hashed here; never compared as it arrived. */
  readonly token: string;
  /** The signed-in session. */
  readonly session: AcceptingSession;
  /** The clock. Injected so tests are deterministic. */
  readonly now: Date;
  /** The id source for the new membership. A seam; production passes nothing. */
  readonly newId?: () => string;
}

/** What acceptance produced. */
export interface AcceptedInvitation<Role extends string> {
  /** The invitation, as it now stands. */
  readonly invitation: Invitation;
  /** The membership that exists as a result — created by this call, or already there. */
  readonly membershipId: string;
  /** The role granted, decoded through the catalog rather than taken off the row as text. */
  readonly role: Role;
  /**
   * Whether this call is what created the membership.
   *
   * False when the person was already inside — a second invitation, or a link clicked twice. The offer
   * is still consumed, because leaving it pending would leave a live token for somebody who is already a
   * member, and the caller is told plainly rather than being shown a welcome for the second time.
   */
  readonly joined: boolean;
}

/**
 * Accept an invitation, and become a member.
 *
 * **The address is the authorization.** The session's own address has to equal the invited one. Holding
 * the token is necessary and is not sufficient, which is the entire difference between an invitation and
 * a bearer credential.
 *
 * **Takes the D1 binding rather than the Kysely database, and that is the one asymmetry in this
 * module.** The membership and the claim are one transaction and both carry the same condition — D1 runs
 * a `batch` as a transaction, and `batch` is on the binding. Every other function here is a single
 * statement and takes the database. Building the database from the binding is a line; getting a
 * transaction out of a Kysely instance that never had one is not.
 *
 * The insert is written as `insert … select … from invitations where status = 'pending'` for exactly
 * that reason — a plain insert would land even when the claim above it matched nothing, which is how a
 * withdrawn invitation becomes a membership in the window between two requests.
 *
 * Raw SQL, because that shape is not expressible in Kysely's insert builder without an expression whose
 * bound values would be harder to read than the statement itself. Every value is encoded through the
 * table's own codec first and then bound, so the conversion rule is still the codec's — and the
 * identifiers are literal snake_case, because raw SQL bypasses `CamelCasePlugin`.
 */
export async function acceptInvitation<Power extends string, Role extends string>(
  d1: D1Database,
  catalog: RoleCatalog<Power, Role>,
  options: AcceptInvitationOptions,
): Promise<AcceptedInvitation<Role>> {
  const db = organizationDatabase(d1);

  // Matched by digest, never by the token as it arrived.
  const row = await db
    .selectFrom(INVITATIONS_TABLE)
    .selectAll()
    .where("tokenDigest", "=", await invitationDigest(options.token))
    .executeTakeFirst();
  if (!row) throw invitationInvalid("no invitation matches the presented token digest");

  const invitation = Invitation.parse(row);
  if (invitation.status !== "pending") {
    throw invitationInvalid(`invitation ${invitation.id} is ${invitation.status}`);
  }
  // Expiry is checked here rather than trusted to a sweep, so an unswept row past its date is refused by
  // every path that could redeem it.
  if (invitation.expiresAt <= options.now) {
    throw invitationInvalid(`invitation ${invitation.id} expired at ${invitation.expiresAt.toISOString()}`);
  }
  if (normalizeAddress(options.session.email) !== invitation.email) {
    // The refusal a forwarded link earns, and it says nothing a forwarded link's holder could act on.
    throw invitationInvalid(
      `invitation ${invitation.id} is bound to another address than the session of user ${options.session.userId}`,
    );
  }

  /*
    Decoded against the **assignable** set, never merely the declared one, and never asserted.

    Two failures are closed by the same line, and only one of them is obvious.

    A catalog that *dropped* the role since the offer was made would otherwise write a membership
    holding a name no matrix has a branch for — which denies everything today and, one refactor later,
    allows it.

    **And a role the catalog has since made unassignable would otherwise be conferred by a link.** That
    is the sharper one, because nothing about the row looks wrong: `invite()` checked the assignable set
    at the moment the offer was written, and an offer lives for days. A project that ships `owner` as an
    ordinary role, invites somebody to it, and then adds the two-party ownership transfer — which is
    exactly what `ownership.ts` tells adopters to do, and what `unassignable` means — would have a live
    link that mints an owner nobody nominated and nobody accepted. Every other path that puts a role on
    a membership parses the assignable set: `invite` above, `changeRole`, and `requireTransferableRoles`
    for the one role that is deliberately excluded. Acceptance was the exception, and an exception is a
    second door.

    The refusal is the ordinary one, so a holder cannot tell a withdrawn offer from a role the project
    has since reserved.
  */
  const role = catalog.AssignableRole.safeParse(invitation.role);
  if (!role.success) {
    throw invitationInvalid(
      `invitation ${invitation.id} offers role ${JSON.stringify(invitation.role)}, which this catalog no longer assigns`,
    );
  }

  const existing = await db
    .selectFrom(MEMBERSHIPS_TABLE)
    .select(["id"])
    .where("organizationId", "=", invitation.organizationId)
    .where("userId", "=", options.session.userId)
    .executeTakeFirst();
  if (existing) {
    // Already inside — a second offer, or a link clicked twice. Consume the offer anyway, so no live
    // token is left pointing at an account this person is already in.
    await db
      .updateTable(INVITATIONS_TABLE)
      .set({ status: "accepted", acceptedAt: SQLiteDate.encode(options.now) })
      .where("id", "=", invitation.id)
      .where("status", "=", "pending")
      .execute();
    return {
      invitation: accepted(invitation, options.now),
      membershipId: existing.id,
      role: role.data,
      joined: false,
    };
  }

  const membership = Membership.encode({
    id: (options.newId ?? (() => crypto.randomUUID()))(),
    organizationId: invitation.organizationId,
    userId: options.session.userId,
    role: role.data,
    createdAt: options.now,
  });
  const acceptedAt = SQLiteDate.encode(options.now);

  const join = sql`
    insert into pithy_organization_memberships (id, organization_id, user_id, role, created_at)
    select ${membership.id}, ${membership.organizationId}, ${membership.userId}, ${membership.role}, ${membership.createdAt}
    from pithy_organization_invitations
    where pithy_organization_invitations.id = ${invitation.id}
      and pithy_organization_invitations.status = 'pending'
  `;
  const claim = sql`
    update pithy_organization_invitations set status = 'accepted', accepted_at = ${acceptedAt}
    where id = ${invitation.id} and status = 'pending'
  `;

  let written: D1Result<unknown>[] | undefined;
  try {
    written = await withD1Retry<D1Result<unknown>[] | undefined>(() =>
      d1.batch([prepared(d1, join.compile(db)), prepared(d1, claim.compile(db))]),
    );
  } catch (cause) {
    // The unique index on `(organizationId, userId)` is the backstop under the condition above: two
    // different invitations to one person, redeemed at once, collapse here rather than becoming two
    // rows. Re-read before deciding, so a genuine failure is not reported as a success.
    const settled = await db
      .selectFrom(MEMBERSHIPS_TABLE)
      .select(["id"])
      .where("organizationId", "=", invitation.organizationId)
      .where("userId", "=", options.session.userId)
      .executeTakeFirst();
    if (!settled) {
      throw new InternalError(
        {
          message: "That invitation could not be accepted.",
          detail: `accepting invitation ${invitation.id} failed`,
        },
        { cause },
      );
    }
    return {
      invitation: accepted(invitation, options.now),
      membershipId: settled.id,
      role: role.data,
      joined: false,
    };
  }

  // `undefined` is `withD1Retry`'s idempotency guard — a constraint failure on a *retry*, which it reads
  // as "my own earlier attempt committed". Here that inference is sound: the key it would have collided
  // on is the membership this call is creating, and nobody else can create that row.
  if (written !== undefined && written[1]?.meta.changes !== 1) {
    // The claim matched nothing, so the insert's identical condition matched nothing either and the
    // transaction wrote no membership. Somebody else redeemed, or the offer moved under us.
    throw invitationInvalid(`invitation ${invitation.id} was no longer pending when the batch ran`);
  }

  return {
    invitation: accepted(invitation, options.now),
    membershipId: membership.id,
    role: role.data,
    joined: true,
  };
}

/** The invitation as it stands once accepted, without a re-read of the row we just wrote. */
function accepted(invitation: Invitation, at: Date): Invitation {
  return { ...invitation, status: "accepted", acceptedAt: at };
}

/** Bind a compiled statement to D1, so it can join a `batch` — which D1 runs as a transaction. */
function prepared(d1: D1Database, compiled: CompiledQuery): D1PreparedStatement {
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}

/**
 * Resolve an invitation id inside one organization, or refuse.
 *
 * **Both halves in one predicate.** An invitation found by id alone is another organization's row handed
 * to a handler that checked the caller's power in theirs — and since ids are UUIDs and the refusal is
 * the same one a spent offer gets, a member of one account learns nothing about another's by guessing.
 *
 * Exported for the resend route, which has to read the **offered** role before it decides whether the
 * caller may re-offer it. Reading the request's idea of the role instead would let a caller widen an
 * offer by resending it, which is the one thing a resend must not be able to do.
 */
export async function requireInvitationInOrganization(
  db: OrganizationDatabase,
  organizationId: string,
  invitationId: string,
): Promise<Invitation> {
  const row = await db
    .selectFrom(INVITATIONS_TABLE)
    .selectAll()
    .where("id", "=", invitationId)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();
  if (!row) throw invitationInvalid(`invitation ${invitationId} is not in organization ${organizationId}`);
  return Invitation.parse(row);
}

/**
 * The one refusal, with the throw-site context in `detail`.
 *
 * The message is the error class's default, everywhere, deliberately: passing one here would be the
 * first step towards two, and two is an oracle that tells a forwarded link's holder whether the address
 * was the thing that stopped them.
 */
function invitationInvalid(detail: string): OrganizationInvitationInvalidError {
  return new OrganizationInvitationInvalidError({ detail });
}
