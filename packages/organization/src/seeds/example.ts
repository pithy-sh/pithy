// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { Invitation } from "../data/invitation";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { OwnershipNomination } from "../data/ownershipNomination";
import { INVITATIONS_TABLE, MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, OWNERSHIP_NOMINATIONS_TABLE } from "../data/tables";
import { OrganizationInvalidRoleCatalogError } from "../error/errors";
import type { RoleCatalog } from "../roles/roles";

/**
 * A worked example: two accounts, three people, one of them in both, one offer outstanding and one
 * hand-over waiting to be accepted.
 *
 * The interesting demo is the shape a single-tenant fixture cannot show. Ada administers Acme and is in
 * nothing else, so she goes straight through with no chooser. Grace administers Ferranti *and* belongs
 * to Acme, so she is the only person here for whom the chooser means anything — and she is also Acme's
 * standing nominee, which is what an unowned account looks like partway through fixing itself. Alan
 * belongs to Ferranti and has been invited to Acme, so the pending list has a row in it and the roster
 * and the invitation list are visibly two different things.
 *
 * **Neither account has an owner**, and that is the fixture stating a property rather than an oversight.
 * A new organization is founded with an administering role and ownership is accepted, never conferred —
 * so an account works, can be read, administered and invited into, and cannot be billed until somebody
 * has agreed to pay for it. A fixture that seeded an owner would quietly teach the opposite.
 *
 * ## The roles come from the project's own catalog, and this is why it is a function
 *
 * Every other capability's example seed is a constant. This one cannot be: a membership's role is a name
 * from the adopter's `defineRoles` catalog, and a fixture holding `"admin"` in a project whose roles are
 * `coach` and `student` writes rows every gate correctly refuses — a demo that looks seeded and behaves
 * as though nobody is a member of anything. So the catalog in force picks the two names, by the same
 * rules the capability's own code uses: the administering role is the one a founder gets, and the
 * ordinary one is the first assignable role that does not administer.
 *
 * ## Nothing here is a live credential
 *
 * Fixed ids and a fixed anchor throughout: seeding is `INSERT OR IGNORE`, so a generated id would insert
 * a second copy on every run and a generated date would move the demo every time it loaded.
 *
 * The invitation's `tokenDigest` is deliberately **not** the digest of any token — it is a legible
 * placeholder of the right shape. A real digest would mean shipping the token that produces it, and a
 * fixture carrying a redeemable invitation is a working credential in every dev database that ever seeds
 * it. So the seeded offer can be listed, withdrawn and resent — a resend mints a real token and mails it,
 * which is the path that works — and it can never be accepted, because nobody can present its preimage.
 *
 * There is no acting selection either. A selection belongs to a session, a session id is minted by
 * `@pithy-sh/auth` at sign-in, and a fixture that guessed one would write a row pointing at nobody.
 * Signing in as Grace writes it for real, which is the thing worth demonstrating.
 */

/** Where this set sorts in the project's seed registry. After auth (100), which owns these three users. */
const ORGANIZATION_EXAMPLE_SEED_ORDER = 270;

/** Acme — Ada's account, with a mark set, one guest, and an offer of ownership standing. */
const ACME_ID = "5a1f7c02-9d84-4b6e-a3f1-0c27e5b8d946";
/** Ferranti — Grace's account, with no mark, so a chooser has to draw initials for one of the two. */
const FERRANTI_ID = "c6b0932e-4a77-4d18-9e53-7f21a0c4b8d5";

/** Ada administers Acme. Founded it, so she holds the founder's role and belongs to nothing else. */
const ADA_AT_ACME_ID = "1d37b5a9-6e02-4c81-bf94-8a5c0d2e7361";
/** Grace, a member of Acme and the person Ada has offered it to. */
const GRACE_AT_ACME_ID = "7e42c8d1-30b5-49f6-8c07-b1d93a6e2540";
/** Grace administers Ferranti. The second membership is what makes her the chooser's case. */
const GRACE_AT_FERRANTI_ID = "9f18a604-c25d-4e73-ab86-2d40f7c95e13";
/** Alan, a member of Ferranti — and, separately, invited to Acme. */
const ALAN_AT_FERRANTI_ID = "b3052d7f-8146-4a09-95ec-6f27d1b48c0a";

/** The offer to Alan, outstanding and visible in Acme's pending list. */
const ACME_INVITATION_ID = "42c7e9b3-15a8-4d60-8f92-3ab06e5c7d18";

/**
 * Acme's mark: a 1×1 PNG of one flat colour, which a chooser draws as a filled square.
 *
 * Obviously a placeholder, and deliberately: a fixture mark that looked like a real logo is a fixture
 * nobody notices is still there. One account has it and the other does not, so a screen that renders a
 * stored mark and a screen that falls back to initials are both exercised by one `pithy seed`.
 */
const ACME_MARK =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOQ13IBAAD5AI55KdetAAAAAElFTkSuQmCC";

/**
 * The invitation's stored digest — a legible placeholder, not the digest of anything.
 *
 * Forty-three base64url characters, which is the shape a real SHA-256 digest has, so a row inspected in
 * a dev database reads like the rows beside it. Nothing hashes to it, which is the property that keeps
 * the seeded offer un-redeemable. See the module note.
 */
const ACME_INVITATION_DIGEST = "seed-invitation-digest-no-token-produces-it-";

/**
 * The fixture's timeline, anchored to the day it is seeded rather than to a fixed calendar date.
 *
 * An invitation and a nomination both expire, so a fixed absolute date makes the demo correct for a week
 * and then seeds two dead rows forever — the pending list empty, the nomination unacceptable, and
 * nothing saying why. The offsets are fixed, so the state is deterministic; the anchor is today, so it
 * is deterministic *and* live. Read once at module load, so every row in one run shares one anchor, and
 * re-seeding cannot shift them either: seeding is `INSERT OR IGNORE`.
 */
const SEED_ANCHOR = new Date();

/** Days before the anchor, as a date. */
function daysAgo(days: number): Date {
  return new Date(SEED_ANCHOR.getTime() - days * 86_400_000);
}

/** Days after the anchor, as a date. */
function daysFromNow(days: number): Date {
  return new Date(SEED_ANCHOR.getTime() + days * 86_400_000);
}

/** When the two accounts were founded, and when each membership began. */
const ACME_FOUNDED = daysAgo(90);
const FERRANTI_FOUNDED = daysAgo(40);
const GRACE_JOINED_ACME = daysAgo(30);
const ALAN_JOINED_FERRANTI = daysAgo(12);
/** When Alan was invited to Acme, and when Ada offered Grace the account. Both still live. */
const INVITED_AT = daysAgo(2);
const NOMINATED_AT = daysAgo(1);

/** The two role names this fixture writes, picked out of the catalog in force. */
interface FixtureRoles<Role extends string> {
  /** What a founder holds: the first assignable role that administers. `provision.ts`'s own rule. */
  readonly administering: Role;
  /** An ordinary membership: the first assignable role that does not administer. */
  readonly ordinary: Role;
}

/**
 * The two roles the fixture hangs its four memberships off.
 *
 * `administering` is `founderRole`'s rule restated rather than imported, because this needs the answer
 * for a *fixture* and that function's refusal is about founding a real account. `ordinary` falls back to
 * the administering role where a catalog has no non-administering assignable one — a small catalog is
 * not a broken one, and a fixture where both members administer is still a working demonstration.
 */
function fixtureRoles<Power extends string, Role extends string>(
  catalog: RoleCatalog<Power, Role>,
): FixtureRoles<Role> {
  const administering = catalog.assignableRoles.find((role) => catalog.administers(role));
  if (administering === undefined) {
    // Unreachable through `defineRoles`, which refuses a catalog with no assignable role and one where
    // nobody holds the administrative power. Stated rather than asserted, because the alternative is a
    // non-null assertion on the one value every row below is keyed to.
    throw new OrganizationInvalidRoleCatalogError({
      message: "This project's roles leave nobody who could found an organization, so there is nothing to seed.",
      action: `Leave at least one role holding \`${catalog.administrativePower}\` out of \`unassignable\`.`,
      detail: `the example seed found no assignable role holding ${catalog.administrativePower}; assignable roles are ${catalog.assignableRoles.join(", ") || "(none)"}`,
    });
  }
  const ordinary = catalog.assignableRoles.find((role) => !catalog.administers(role)) ?? administering;
  return { administering, ordinary };
}

/**
 * The tenancy example fixture, built against the catalog this Worker composed.
 *
 * `dev` and `staging` only, and `example: true`, so it is composed only where a project asked for
 * examples. Production is never in the list: these are four memberships granting access to two accounts,
 * and a fixture that could reach a real environment is a fixture that eventually does.
 */
export function organizationExampleSeed<Power extends string, Role extends string>(
  catalog: RoleCatalog<Power, Role>,
): SeedSet {
  const roles = fixtureRoles(catalog);

  return defineSeed({
    name: "example",
    order: ORGANIZATION_EXAMPLE_SEED_ORDER,
    environments: ["dev", "staging"],
    example: true,
    d1: [
      d1SeedGroup("app", ORGANIZATIONS_TABLE, Organization, [
        {
          id: ACME_ID,
          name: "Acme",
          slug: "acme",
          logo: ACME_MARK,
          createdAt: ACME_FOUNDED,
          updatedAt: NOMINATED_AT,
        },
        {
          id: FERRANTI_ID,
          name: "Ferranti",
          slug: "ferranti",
          // No mark, so the chooser draws initials for this one. Both branches, one fixture.
          logo: null,
          createdAt: FERRANTI_FOUNDED,
          updatedAt: FERRANTI_FOUNDED,
        },
      ]),
      d1SeedGroup("app", MEMBERSHIPS_TABLE, Membership, [
        {
          id: ADA_AT_ACME_ID,
          organizationId: ACME_ID,
          userId: EXAMPLE_ADA.id,
          role: roles.administering,
          createdAt: ACME_FOUNDED,
        },
        {
          id: GRACE_AT_ACME_ID,
          organizationId: ACME_ID,
          userId: EXAMPLE_GRACE.id,
          role: roles.ordinary,
          createdAt: GRACE_JOINED_ACME,
        },
        {
          id: GRACE_AT_FERRANTI_ID,
          organizationId: FERRANTI_ID,
          userId: EXAMPLE_GRACE.id,
          role: roles.administering,
          createdAt: FERRANTI_FOUNDED,
        },
        {
          id: ALAN_AT_FERRANTI_ID,
          organizationId: FERRANTI_ID,
          userId: EXAMPLE_ALAN.id,
          role: roles.ordinary,
          createdAt: ALAN_JOINED_FERRANTI,
        },
      ]),
      d1SeedGroup("app", INVITATIONS_TABLE, Invitation, [
        {
          id: ACME_INVITATION_ID,
          organizationId: ACME_ID,
          // Already a member of Ferranti, and invited to Acme. The two are unrelated facts about one
          // person, which is the whole of what a tenancy model claims.
          email: EXAMPLE_ALAN.email,
          role: roles.ordinary,
          invitedByUserId: EXAMPLE_ADA.id,
          tokenDigest: ACME_INVITATION_DIGEST,
          status: "pending",
          expiresAt: daysFromNow(12),
          acceptedAt: null,
          createdAt: INVITED_AT,
        },
      ]),
      d1SeedGroup("app", OWNERSHIP_NOMINATIONS_TABLE, OwnershipNomination, [
        {
          organizationId: ACME_ID,
          // The membership, not the user. An offer dies with the membership it was made to, which is
          // what stops somebody who has left accepting an account they are no longer inside.
          membershipId: GRACE_AT_ACME_ID,
          nominatedByUserId: EXAMPLE_ADA.id,
          expiresAt: daysFromNow(5),
          createdAt: NOMINATED_AT,
        },
      ]),
    ],
  });
}
