// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import { changeRole, countAdministrators, leaveOrganization, listMembers, removeMember } from "../members/members";
import { ORGANIZATION_MIGRATION_ORDER, organization_0001_init } from "../migrations/0001_init";
import { defineRoles } from "../roles/roles";
import {
  acceptNomination,
  holdersOf,
  nominate,
  type OwnershipRoles,
  requireTransferableRoles,
  standingNomination,
  withdrawNomination,
} from "./ownership";

/**
 * Ownership, against real D1.
 *
 * **The property is that one act never moves the account.** Every path through this file is two acts by
 * two people, and the cases that matter are the ones where the second person is the wrong one: somebody
 * accepting an offer made to another member, an offer accepted after the nominee was removed, an offer
 * accepted after it expired.
 *
 * **The second property is the one a reviewer should check first**, because it is what makes the rest
 * more than convention: `requireTransferableRoles` refuses to run a transfer whose conferred role is
 * assignable. `every route, every role` below is the same claim driven from the other side — every
 * function this lane exports, called by every role there is, with nobody ending up holding the account.
 */

const ADA = "user_ada";
const BOB = "user_bob";
const CAT = "user_cat";
const OLIVE = "user_olive";
const NOW = new Date("2026-09-05T12:00:00.000Z");
const DAY = 86_400_000;

const TABLES = [
  "pithy_organization_acting",
  "pithy_organization_ownership_nominations",
  "pithy_organization_invitations",
  "pithy_organization_memberships",
  "pithy_organization_organizations",
  "pithy_migrations",
  "pithy_migrations_lock",
];

/** Three roles that nest, with the owning one excluded from assignment — the shape a transfer needs. */
const OWNED = defineRoles({
  powers: ["connections:read", "connections:manage"],
  roles: {
    member: ["organization:read", "connections:read"],
    admin: ["organization:read", "connections:read", "connections:manage", "organization:manage"],
    owner: [
      "organization:read",
      "connections:read",
      "connections:manage",
      "organization:manage",
      "members:manage",
      "billing:manage",
      "organization:delete",
    ],
  },
  administrativePower: "organization:manage",
  nests: ["member", "admin", "owner"],
  unassignable: ["owner"],
});

/** The academy's: four roles, two of them parallel, and **nothing excluded from assignment**. */
const ACADEMY = defineRoles({
  powers: ["sessions:read", "sessions:accept", "sessions:request", "students:block", "coaches:block"],
  roles: {
    owner: [
      "organization:read",
      "organization:manage",
      "members:manage",
      "billing:manage",
      "organization:delete",
      "sessions:read",
    ],
    admin: ["organization:read", "organization:manage", "members:manage", "sessions:read"],
    coach: ["organization:read", "sessions:read", "sessions:accept", "students:block"],
    student: ["organization:read", "sessions:request", "coaches:block"],
  },
  administrativePower: "organization:manage",
});

/** The pair every transfer in this file moves. Read from one place, exactly as a route would. */
const TRANSFER: OwnershipRoles<"member" | "admin" | "owner"> = { confers: "owner", demotesTo: "admin" };

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "organization",
      order: ORGANIZATION_MIGRATION_ORDER,
      migrations: { "0001_init": organization_0001_init },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

let acme: string;

async function makeOrganization(slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await organizationDatabase(env.DB)
    .insertInto(ORGANIZATIONS_TABLE)
    .values(Organization.encode({ id, name: slug, slug, logo: null, createdAt: NOW, updatedAt: NOW }))
    .execute();
  return id;
}

async function join(userId: string, role: string, organizationId = acme): Promise<string> {
  const id = crypto.randomUUID();
  await organizationDatabase(env.DB)
    .insertInto(MEMBERSHIPS_TABLE)
    .values(Membership.encode({ id, organizationId, userId, role, createdAt: NOW }))
    .execute();
  return id;
}

/** Everybody's role in Acme, by user. The state every assertion below is about. */
async function roles(): Promise<Record<string, string>> {
  const rows = await env.DB.prepare(
    "select user_id, role from pithy_organization_memberships where organization_id = ?",
  )
    .bind(acme)
    .all<{ user_id: string; role: string }>();
  return Object.fromEntries(rows.results.map((row) => [row.user_id, row.role]));
}

/** An offer standing until tomorrow, made by whoever. Fixture, not a route. */
async function offer(membershipId: string, by = OLIVE): Promise<void> {
  await nominate(organizationDatabase(env.DB), OWNED, {
    organizationId: acme,
    membershipId,
    nominatedByUserId: by,
    expiresAt: new Date(NOW.getTime() + DAY),
    roles: TRANSFER,
    now: NOW,
  });
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  await runMigrations(env.DB, provider());
  acme = await makeOrganization("acme");
});

describe("the roles a transfer moves", () => {
  test("**a conferred role that administers nothing is refused**, because a transfer is the fourth door onto the floor", () => {
    /*
      `changeRole`, `removeMember` and `leaveOrganization` all count administrators before they write.
      A transfer rewrites roles too and cannot take that count — it is two writes in one batch, and a
      count taken before them says nothing about the state after — so the invariant is held at the
      wiring instead.

      The catalog below is not contrived: separating "signs for the account" from "runs it" is an
      ordinary thing to want. Under it, accepting a transfer would demote the only administrator into a
      role that administers nothing, and leave an account nobody can invite into, rename or repair. No
      route in the capability could put an administrator back.
    */
    const separated = defineRoles({
      roles: {
        member: ["organization:read"],
        admin: ["organization:read", "organization:manage", "members:manage"],
        owner: ["organization:read", "billing:manage", "organization:delete"],
      },
      administrativePower: "organization:manage",
      unassignable: ["owner"],
    });
    expect(() => requireTransferableRoles(separated, { confers: "owner", demotesTo: "member" })).toThrow(
      /does not hold `organization:manage`/,
    );
    // And the same catalog with an owner who also administers is fine — the account gains an
    // administrator in the same batch in which one is demoted.
    const administering = defineRoles({
      roles: {
        member: ["organization:read"],
        admin: ["organization:read", "organization:manage", "members:manage"],
        owner: ["organization:read", "organization:manage", "members:manage", "billing:manage", "organization:delete"],
      },
      administrativePower: "organization:manage",
      unassignable: ["owner"],
    });
    expect(() => requireTransferableRoles(administering, { confers: "owner", demotesTo: "member" })).not.toThrow();
  });

  test("**a conferred role anybody could be given is refused**, which is the whole property", async () => {
    // If this passed, `changeRole` could hand `owner` out in one call and every offer and acceptance
    // below would be theater. The academy declares nothing unassignable, so its `owner` is exactly that.
    expect(() => requireTransferableRoles(ACADEMY, { confers: "owner", demotesTo: "admin" })).toThrow(
      /can be given out by a role change/,
    );
  });

  test("a role the catalog does not declare is refused, naming it", () => {
    expect(() => requireTransferableRoles(OWNED, { confers: "owner", demotesTo: "director" as "admin" })).toThrow(
      /`director` is not a role this catalog declares/,
    );
  });

  test("and a transfer to and from the same role is not a transfer", () => {
    expect(() => requireTransferableRoles(OWNED, { confers: "owner", demotesTo: "owner" })).toThrow(
      /give the previous holder a different one/,
    );
  });

  test("the dashboard's pair passes", () => {
    expect(() => requireTransferableRoles(OWNED, TRANSFER)).not.toThrow();
  });

  test("**and every entry point checks it**, so a miswired route cannot write a transfer", async () => {
    const bob = await join(BOB, "coach");
    const bad: OwnershipRoles<"owner" | "admin" | "coach" | "student"> = { confers: "owner", demotesTo: "admin" };
    await expect(
      nominate(organizationDatabase(env.DB), ACADEMY, {
        organizationId: acme,
        membershipId: bob,
        nominatedByUserId: ADA,
        expiresAt: new Date(NOW.getTime() + DAY),
        roles: bad,
        now: NOW,
      }),
    ).rejects.toThrow(/can be given out by a role change/);
    await expect(
      acceptNomination(env.DB, ACADEMY, { organizationId: acme, userId: BOB, now: NOW, roles: bad }),
    ).rejects.toThrow(/can be given out by a role change/);
  });
});

describe("offering", () => {
  test("**while somebody holds the account, only they hand it on**", async () => {
    // Not an administrator, and not somebody holding `members:manage`. Handing on the obligation is the
    // holder's to hand: two administrators who could do it could pass an account between themselves over
    // the head of the person who signed for it.
    await join(OLIVE, "owner");
    await join(ADA, "admin");
    const bob = await join(BOB, "member");
    await expect(offer(bob, ADA)).rejects.toThrow(/Only somebody who already holds this organization/);
    expect(await standingNomination(organizationDatabase(env.DB), acme, NOW)).toBeNull();
  });

  test("**while nobody holds it, you may volunteer**", async () => {
    // The consent the two-party rule exists to require, and the acceptance is still a separate act.
    const ada = await join(ADA, "admin");
    const nomination = await nominate(organizationDatabase(env.DB), OWNED, {
      organizationId: acme,
      membershipId: ada,
      nominatedByUserId: ADA,
      expiresAt: new Date(NOW.getTime() + DAY),
      roles: TRANSFER,
      now: NOW,
    });
    expect(nomination.membershipId).toBe(ada);
    expect((await roles())[ADA]).toBe("admin");
  });

  test("**and may not appoint anybody else.** That is the escalation the rule closes", async () => {
    // An administrator who could nominate a colleague could invite a fourth party and install them as
    // the holder of an account that belongs to neither of them.
    await join(ADA, "admin");
    const bob = await join(BOB, "member");
    await expect(offer(bob, ADA)).rejects.toThrow(/cannot hand this organization to somebody else/);
    expect(await standingNomination(organizationDatabase(env.DB), acme, NOW)).toBeNull();
  });

  test("names a membership inside the organization, or refuses", async () => {
    const other = await makeOrganization("other");
    const elsewhere = await join(BOB, "member", other);
    await expect(offer(elsewhere)).rejects.toThrow(/No such member/);
    expect(await standingNomination(organizationDatabase(env.DB), acme, NOW)).toBeNull();
  });

  test("refuses the person who already holds it", async () => {
    const olive = await join(OLIVE, "owner");
    await expect(offer(olive)).rejects.toThrow(/already holds this organization/);
  });

  test("refuses an offer that would already have expired", async () => {
    const bob = await join(BOB, "member");
    await expect(
      nominate(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: bob,
        nominatedByUserId: OLIVE,
        expiresAt: NOW,
        roles: TRANSFER,
        now: NOW,
      }),
    ).rejects.toThrow(/already have expired/);
  });

  test("**offering again replaces**, so an account offers itself to one person at a time", async () => {
    // Keyed by the organization, so changing your mind is one act rather than a withdrawal and a
    // re-offer with a window between them in which two people could both accept.
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    const cat = await join(CAT, "member");
    await offer(bob);
    await offer(cat);
    const standing = await standingNomination(organizationDatabase(env.DB), acme, NOW);
    expect(standing?.membershipId).toBe(cat);
    const rows = await env.DB.prepare("select count(*) as n from pithy_organization_ownership_nominations").first<{
      n: number;
    }>();
    expect(Number(rows?.n)).toBe(1);
  });

  test("an expired offer reads as none, and the row is left where it is", async () => {
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await offer(bob);
    expect(await standingNomination(organizationDatabase(env.DB), acme, new Date(NOW.getTime() + 2 * DAY))).toBeNull();
    const rows = await env.DB.prepare("select count(*) as n from pithy_organization_ownership_nominations").first<{
      n: number;
    }>();
    expect(Number(rows?.n)).toBe(1);
  });

  test("withdrawing says whether there was anything to withdraw", async () => {
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    expect(
      await withdrawNomination(organizationDatabase(env.DB), { organizationId: acme, userId: OLIVE, roles: TRANSFER }),
    ).toBe(false);
    await offer(bob);
    expect(
      await withdrawNomination(organizationDatabase(env.DB), { organizationId: acme, userId: OLIVE, roles: TRANSFER }),
    ).toBe(true);
    expect(await standingNomination(organizationDatabase(env.DB), acme, NOW)).toBeNull();
  });
});

describe("accepting", () => {
  test("**the nominee alone.** Nobody accepts on somebody else's behalf", async () => {
    // The whole of the two-party rule, and the act this design exists to make impossible.
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await join(ADA, "admin");
    await offer(bob);

    await expect(
      acceptNomination(env.DB, OWNED, { organizationId: acme, userId: ADA, now: NOW, roles: TRANSFER }),
    ).rejects.toThrow(/no offer of ownership/i);
    expect((await roles())[BOB]).toBe("member");
    expect((await roles())[OLIVE]).toBe("owner");
  });

  test("the previous holder is demoted in the same write", async () => {
    const olive = await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await offer(bob);

    const transferred = await acceptNomination(env.DB, OWNED, {
      organizationId: acme,
      userId: BOB,
      now: NOW,
      roles: TRANSFER,
    });

    expect(await roles()).toEqual({ [OLIVE]: "admin", [BOB]: "owner" });
    expect(transferred.newHolderMembershipId).toBe(bob);
    expect(transferred.previousHolderMembershipIds).toEqual([olive]);
  });

  test("the account never holds two owners, even through a transfer", async () => {
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await offer(bob);
    await acceptNomination(env.DB, OWNED, { organizationId: acme, userId: BOB, now: NOW, roles: TRANSFER });
    expect(await holdersOf(organizationDatabase(env.DB), acme, "owner")).toHaveLength(1);
  });

  test("**an ownerless account transfers with nobody to demote**", async () => {
    // The ordinary state of a young account: founding it made Ada an administrator and nobody has agreed
    // to pay for anything. Somebody volunteering is the first owner the account ever had.
    const ada = await join(ADA, "admin");
    await offer(ada, ADA);
    const transferred = await acceptNomination(env.DB, OWNED, {
      organizationId: acme,
      userId: ADA,
      now: NOW,
      roles: TRANSFER,
    });
    expect(transferred.previousHolderMembershipIds).toEqual([]);
    expect(await roles()).toEqual({ [ADA]: "owner" });
  });

  test("the offer is spent by the transaction that honors it", async () => {
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await offer(bob);
    await acceptNomination(env.DB, OWNED, { organizationId: acme, userId: BOB, now: NOW, roles: TRANSFER });
    expect(await standingNomination(organizationDatabase(env.DB), acme, NOW)).toBeNull();
    await expect(
      acceptNomination(env.DB, OWNED, { organizationId: acme, userId: BOB, now: NOW, roles: TRANSFER }),
    ).rejects.toThrow(/no offer of ownership/i);
  });

  test("**an expired offer is refused**, and the row is not the authority on that", async () => {
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await offer(bob);
    await expect(
      acceptNomination(env.DB, OWNED, {
        organizationId: acme,
        userId: BOB,
        now: new Date(NOW.getTime() + 20 * DAY),
        roles: TRANSFER,
      }),
    ).rejects.toThrow(/no offer of ownership/i);
    expect((await roles())[BOB]).toBe("member");
  });

  test("**an offer whose membership is gone is refused**, because D1 cascades nothing", async () => {
    // The row goes because `removeMember` takes it, not because a foreign key does. Either way there is
    // no offer for somebody who is no longer in the account to accept.
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await offer(bob);
    await removeMember(env.DB, OWNED, {
      organizationId: acme,
      membershipId: bob,
      actor: { userId: OLIVE, role: "owner" },
    });
    expect(await standingNomination(organizationDatabase(env.DB), acme, NOW)).toBeNull();
    await expect(
      acceptNomination(env.DB, OWNED, { organizationId: acme, userId: BOB, now: NOW, roles: TRANSFER }),
    ).rejects.toThrow(/no offer of ownership/i);
    expect((await roles())[OLIVE]).toBe("owner");
  });

  test("**and a membership deleted behind the capability's back is the same refusal**", async () => {
    // The offer row survives, so the acceptance path has to answer for it on its own rather than trusting
    // that the removal cleaned up.
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await offer(bob);
    await env.DB.prepare("delete from pithy_organization_memberships where id = ?").bind(bob).run();
    await expect(
      acceptNomination(env.DB, OWNED, { organizationId: acme, userId: BOB, now: NOW, roles: TRANSFER }),
    ).rejects.toThrow(/no offer of ownership/i);
    expect((await roles())[OLIVE]).toBe("owner");
  });

  test("**all four refusals say the same thing**, so the answer is not an oracle", async () => {
    // No offer, an expired one, one whose membership is gone, one made to somebody else. A caller who
    // could tell them apart could read out whether an offer is standing in an account and to whom.
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await join(ADA, "admin");

    const said: string[] = [];
    const capture = async (promise: Promise<unknown>): Promise<void> => {
      await promise.catch((error: unknown) => {
        said.push(error instanceof Error ? error.message : String(error));
      });
    };

    await capture(acceptNomination(env.DB, OWNED, { organizationId: acme, userId: ADA, now: NOW, roles: TRANSFER }));
    await offer(bob);
    await capture(
      acceptNomination(env.DB, OWNED, {
        organizationId: acme,
        userId: BOB,
        now: new Date(NOW.getTime() + 20 * DAY),
        roles: TRANSFER,
      }),
    );
    await capture(acceptNomination(env.DB, OWNED, { organizationId: acme, userId: ADA, now: NOW, roles: TRANSFER }));
    await env.DB.prepare("delete from pithy_organization_memberships where id = ?").bind(bob).run();
    await capture(acceptNomination(env.DB, OWNED, { organizationId: acme, userId: BOB, now: NOW, roles: TRANSFER }));

    expect(said).toHaveLength(4);
    expect(new Set(said).size).toBe(1);
  });
});

/**
 * The claim, driven from the outside.
 *
 * Every function this lane exports, called by every role the catalog has, against an account Olive owns.
 * None of them may leave somebody else holding `owner`. A route surface is only as good as the widest
 * thing behind it, and this is that thing.
 */
describe("an offer that stopped standing", () => {
  /*
    **Acceptance is a read, then three more reads, then a batch** — and the account can change hands in
    that window. A withdrawal and a re-nomination are each one statement on the same row, and each
    returns to *its* caller saying the offer is gone.

    Two layers answer that, and the tests below are deliberately split across them rather than all
    claiming the same thing.

    The **read** catches the ordinary case: by the time somebody's browser posts, the offer is already
    gone, and `standingNomination` says so. The first two tests are that, and they would pass without
    any of the work below.

    The **write** catches the window the read cannot see, and it is the last statement of the batch: a
    conditional delete naming the nominee, with the transfer refused unless it removed exactly one row.
    D1 runs a batch as a transaction, so the refusal rolls back the two role writes before it — which is
    what lets the condition come last rather than first, where it would be the read-then-write it
    replaces. **The third test is the one that goes red without it**, and it is the only one that does.
  */

  test("a withdrawn offer is refused on the read, before anything is prepared", async () => {
    const olive = await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await offer(bob);

    // The holder withdraws while the nominee is mid-accept. Serialized here rather than raced, because
    // what is under test is the condition and not the scheduler.
    await withdrawNomination(organizationDatabase(env.DB), { organizationId: acme, userId: OLIVE, roles: TRANSFER });

    await expect(
      acceptNomination(env.DB, OWNED, { organizationId: acme, userId: BOB, now: NOW, roles: TRANSFER }),
    ).rejects.toThrow(/no offer of ownership/i);
    const after = await roles();
    expect(after[OLIVE]).toBe("owner");
    expect(after[BOB]).toBe("member");
    expect(olive).toBeTruthy();
  });

  test("a replaced offer is refused, and the replacement survives", async () => {
    // The sharper case. Without the condition, Bob is promoted **and** Carol's standing offer is deleted
    // by the same unconditional statement — so the account changes hands to somebody who was no longer
    // the nominee, and the person who was is left with nothing and no record of it.
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    const carol = await join(CAT, "member");
    await offer(bob);
    await offer(carol);

    await expect(
      acceptNomination(env.DB, OWNED, { organizationId: acme, userId: BOB, now: NOW, roles: TRANSFER }),
    ).rejects.toThrow(/no offer of ownership/i);

    const after = await roles();
    expect(after[BOB]).toBe("member");
    expect(after[OLIVE]).toBe("owner");
    // Carol's offer is still there, and still hers to accept.
    const standing = await standingNomination(organizationDatabase(env.DB), acme, NOW);
    expect(standing?.membershipId).toBe(carol);

    const transferred = await acceptNomination(env.DB, OWNED, {
      organizationId: acme,
      userId: CAT,
      now: NOW,
      roles: TRANSFER,
    });
    expect(transferred.newHolderMembershipId).toBe(carol);
    expect((await roles())[CAT]).toBe("owner");
  });

  test("**of two concurrent acceptances of one offer, exactly one wins** — the condition, not the read", async () => {
    // Both calls read the same standing offer and both reach the batch. Without the conditional delete
    // both commit: the second demotes the new holder it just promoted, because `role = confers` now
    // matches them. This is the case the read cannot answer, and removing the condition reddens exactly
    // this test and no other.
    const olive = await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await offer(bob);

    const settled = await Promise.allSettled([
      acceptNomination(env.DB, OWNED, { organizationId: acme, userId: BOB, now: NOW, roles: TRANSFER }),
      acceptNomination(env.DB, OWNED, { organizationId: acme, userId: BOB, now: NOW, roles: TRANSFER }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    const after = await roles();
    expect(after[BOB]).toBe("owner");
    expect(after[OLIVE]).toBe("admin");
    expect(await standingNomination(organizationDatabase(env.DB), acme, NOW)).toBeNull();
    expect(olive).toBeTruthy();
  });
});

describe("every route, every role", () => {
  /** The account each probe gets: Olive owns it, Ada administers, Bob reads. */
  interface Room {
    readonly olive: string;
    readonly ada: string;
    readonly bob: string;
  }

  /**
   * A fresh account for every probe.
   *
   * **Not one account carried through the loop**, because the first allowed removal would leave every
   * later probe hitting a 404 and passing for the wrong reason. Each route gets an intact room.
   */
  async function reseed(): Promise<Room> {
    await env.DB.prepare("delete from pithy_organization_memberships").run();
    await env.DB.prepare("delete from pithy_organization_ownership_nominations").run();
    return { olive: await join(OLIVE, "owner"), ada: await join(ADA, "admin"), bob: await join(BOB, "member") };
  }

  /** Every function this lane exports, as a call somebody could make. */
  const PROBES: Record<
    string,
    (actor: { userId: string; role: "owner" | "admin" | "member" }, room: Room) => Promise<unknown>
  > = {
    listMembers: () => listMembers(organizationDatabase(env.DB), acme),
    countAdministrators: () => countAdministrators(organizationDatabase(env.DB), OWNED, acme),
    // The role-change door, aimed straight at the role being guarded.
    "changeRole → owner": (actor, room) =>
      changeRole(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: room.bob,
        role: "owner",
        actor,
      }),
    "changeRole → owner (on the admin)": (actor, room) =>
      changeRole(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: room.ada,
        role: "owner",
        actor,
      }),
    // Demoting the owner out of the way, then taking the role, is two calls — so neither may work.
    "changeRole → admin (on the owner)": (actor, room) =>
      changeRole(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: room.olive,
        role: "admin",
        actor,
      }),
    nominate: (actor, room) =>
      nominate(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: room.bob,
        nominatedByUserId: actor.userId,
        expiresAt: new Date(NOW.getTime() + DAY),
        roles: TRANSFER,
        now: NOW,
      }),
    // Offering it and then accepting on the nominee's behalf — the click the design exists to prevent.
    "nominate then accept for them": async (actor, room) => {
      await nominate(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: room.bob,
        nominatedByUserId: actor.userId,
        expiresAt: new Date(NOW.getTime() + DAY),
        roles: TRANSFER,
        now: NOW,
      });
      return acceptNomination(env.DB, OWNED, {
        organizationId: acme,
        userId: actor.userId,
        now: NOW,
        roles: TRANSFER,
      });
    },
    standingNomination: () => standingNomination(organizationDatabase(env.DB), acme, NOW),
    withdrawNomination: () =>
      withdrawNomination(organizationDatabase(env.DB), { organizationId: acme, userId: OLIVE, roles: TRANSFER }),
    "removeMember (the owner)": (actor, room) =>
      removeMember(env.DB, OWNED, { organizationId: acme, membershipId: room.olive, actor }),
    "removeMember (the admin)": (actor, room) =>
      removeMember(env.DB, OWNED, { organizationId: acme, membershipId: room.ada, actor }),
    leaveOrganization: (actor) => leaveOrganization(env.DB, OWNED, { organizationId: acme, actor }),
  };

  test("**no single call by any role makes another person the owner**", async () => {
    const actors = [
      { userId: OLIVE, role: "owner" },
      { userId: ADA, role: "admin" },
      { userId: BOB, role: "member" },
    ] as const;

    for (const actor of actors) {
      for (const [name, probe] of Object.entries(PROBES)) {
        const room = await reseed();
        await probe(actor, room).catch(() => undefined);

        // One owner, and it is still the person who signed. Named in the assertion so a failure says
        // which call by which role moved it.
        const owners = await holdersOf(organizationDatabase(env.DB), acme, "owner");
        expect({ probe: name, by: actor.role, owners: owners.map((holder) => holder.userId) }).toEqual({
          probe: name,
          by: actor.role,
          owners: [OLIVE],
        });
      }
    }
  });

  test("and the loop is not passing because everything refuses", async () => {
    // The anti-vacuity. Two of the probes above are supposed to land, and they do.
    const room = await reseed();
    const owner = { userId: OLIVE, role: "owner" } as const;

    expect(await PROBES.listMembers?.(owner, room)).toHaveLength(3);
    await PROBES["removeMember (the admin)"]?.(owner, room);
    expect(
      await env.DB.prepare("select role from pithy_organization_memberships where id = ?").bind(room.ada).first(),
    ).toBeNull();
  });
});

/**
 * An account nobody owns, from founding to the day somebody signs for it.
 *
 * **Everything works except billing**, which is the model saying out loud that nobody has agreed to pay.
 * The steps below are the whole ordinary life of a young tenant, and none of them needs an owner.
 */
describe("an unowned account, end to end", () => {
  test("runs its roster, its roles and its removals, then acquires an owner", async () => {
    const ada = await join(ADA, "admin");
    const db = organizationDatabase(env.DB);
    const founder = { userId: ADA, role: "admin" } as const;

    // Nobody holds the account, and nobody holds the power to bill for it.
    expect(await holdersOf(db, acme, "owner")).toEqual([]);
    expect(OWNED.roleAllows("admin", "billing:manage")).toBe(false);
    expect(await countAdministrators(db, OWNED, acme)).toBe(1);

    // The roster, a role change and a removal — every one of them an administrator's act.
    const bob = await join(BOB, "member");
    const cat = await join(CAT, "member");
    expect([...(await listMembers(db, acme))].map((row) => row.userId).sort()).toEqual([ADA, BOB, CAT]);

    await changeRole(db, OWNED, { organizationId: acme, membershipId: bob, role: "member", actor: founder });
    await removeMember(env.DB, OWNED, { organizationId: acme, membershipId: cat, actor: founder });
    expect(await roles()).toEqual({ [ADA]: "admin", [BOB]: "member" });

    // Somebody volunteers. Nominating is one act and accepting is another, even when they are the same
    // person: that is consent, not a hole in the two-party rule.
    await offer(ada, ADA);
    expect((await roles())[ADA]).toBe("admin");
    const transferred = await acceptNomination(env.DB, OWNED, {
      organizationId: acme,
      userId: ADA,
      now: NOW,
      roles: TRANSFER,
    });

    expect(transferred.previousHolderMembershipIds).toEqual([]);
    expect(await roles()).toEqual({ [ADA]: "owner", [BOB]: "member" });
    expect(OWNED.roleAllows("owner", "billing:manage")).toBe(true);

    // And the ordinary rules now apply to them like anybody else: the owner has no exit but a transfer.
    await expect(
      leaveOrganization(env.DB, OWNED, { organizationId: acme, actor: { userId: ADA, role: "owner" } }),
    ).rejects.toThrow(/cannot leave while you hold `owner`/);
  });
});
