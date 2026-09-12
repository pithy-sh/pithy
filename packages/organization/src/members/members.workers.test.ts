// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { ActingOrganization } from "../data/actingOrganization";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { OwnershipNomination } from "../data/ownershipNomination";
import {
  ACTING_TABLE,
  MEMBERSHIPS_TABLE,
  ORGANIZATIONS_TABLE,
  OWNERSHIP_NOMINATIONS_TABLE,
  organizationDatabase,
} from "../data/tables";
import { ORGANIZATION_MIGRATION_ORDER, organization_0001_init } from "../migrations/0001_init";
import { defineRoles } from "../roles/roles";
import { changeRole, countAdministrators, leaveOrganization, listMembers, removeMember } from "./members";

/**
 * The roster's two writes, against real D1.
 *
 * **The invariant this file exists for is the administrator floor**, and the reason it is planted three
 * times is that it has three doors. An organization where nobody holds the administrative power cannot
 * invite, cannot change a role and cannot repair itself; the operator becomes the only way back in. So
 * every route to that state is driven here — demote the last holder, remove the last holder, walk out as
 * the last holder — and each has to be refused with the account intact afterwards.
 *
 * **The second property is that the floor counts a power, not a word.** {@link OWNED} gives the owning
 * role the administrative power as well, which is the case a count of members whose role is spelled
 * `admin` gets wrong: an account with one owner and one admin does not become unadministrable when the
 * admin goes, and refusing that removal would be a rule enforcing its own wording rather than its own
 * reason.
 */

const ADA = "user_ada";
const BOB = "user_bob";
const CAT = "user_cat";
const OLIVE = "user_olive";
const DAN = "user_dan";
const NOW = new Date("2026-09-05T12:00:00.000Z");

const TABLES = [
  "pithy_organization_acting",
  "pithy_organization_ownership_nominations",
  "pithy_organization_invitations",
  "pithy_organization_memberships",
  "pithy_organization_organizations",
  "pithy_migrations",
  "pithy_migrations_lock",
];

/**
 * The dashboard's shape: three roles that nest, the owning one excluded from assignment, and the owning
 * role holding the administrative power alongside the admin.
 */
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

/**
 * A catalog where **running the roster and administering the account are two different roles.**
 *
 * Contrived, and deliberately so: it is the only shape in which all three doors onto the floor are
 * reachable by three different acts, because in a nesting catalog anybody entitled to demote somebody
 * else already administers and the count cannot fall below one. It is also the catalog that proves
 * `administrativePower` is read rather than guessed — nothing here is spelled `admin`, and `manager`,
 * which holds every kit power there is, is not what the floor counts.
 */
const STEWARDED = defineRoles({
  powers: ["account:steward"],
  roles: {
    member: ["organization:read"],
    steward: ["organization:read", "account:steward"],
    manager: ["organization:read", "organization:manage", "members:manage", "billing:manage", "organization:delete"],
  },
  administrativePower: "account:steward",
});

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

/** Acme, and the id every fixture below writes into. */
let acme: string;

/** Put an organization in the database. Fixture setup, not a path the product has. */
async function makeOrganization(slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await organizationDatabase(env.DB)
    .insertInto(ORGANIZATIONS_TABLE)
    .values(Organization.encode({ id, name: slug, slug, logo: null, createdAt: NOW, updatedAt: NOW }))
    .execute();
  return id;
}

/** Put somebody in an organization, in whatever role — including one no catalog declares. */
async function join(userId: string, role: string, organizationId = acme): Promise<string> {
  const id = crypto.randomUUID();
  await organizationDatabase(env.DB)
    .insertInto(MEMBERSHIPS_TABLE)
    .values(Membership.encode({ id, organizationId, userId, role, createdAt: NOW }))
    .execute();
  return id;
}

async function roleOf(membershipId: string): Promise<string | undefined> {
  const row = await env.DB.prepare("select role from pithy_organization_memberships where id = ?")
    .bind(membershipId)
    .first<{ role: string }>();
  return row?.role;
}

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  await runMigrations(env.DB, provider());
  acme = await makeOrganization("acme");
});

describe("the roster", () => {
  test("comes back oldest first, and every row parses", async () => {
    const first = await join(ADA, "admin");
    await organizationDatabase(env.DB)
      .insertInto(MEMBERSHIPS_TABLE)
      .values(
        Membership.encode({
          id: crypto.randomUUID(),
          organizationId: acme,
          userId: BOB,
          role: "member",
          createdAt: new Date(NOW.getTime() + 1000),
        }),
      )
      .execute();

    const roster = await listMembers(organizationDatabase(env.DB), acme);
    expect(roster.map((row) => row.userId)).toEqual([ADA, BOB]);
    expect(roster[0]?.id).toBe(first);
    expect(roster[0]?.createdAt).toBeInstanceOf(Date);
  });

  test("names one organization, and never another's members", async () => {
    const other = await makeOrganization("other");
    await join(ADA, "admin");
    await join(BOB, "admin", other);
    expect((await listMembers(organizationDatabase(env.DB), acme)).map((row) => row.userId)).toEqual([ADA]);
  });

  test("**a role this build does not know does not hide the rest of the list**", async () => {
    // The roster is not a gate. Every gate below refuses an undecodable role; refusing the whole list
    // would hide every good row behind one bad one, on the screen somebody would use to find and fix it.
    await join(ADA, "admin");
    await join(BOB, "wizard");
    const roster = await listMembers(organizationDatabase(env.DB), acme);
    expect([...roster].map((row) => row.role).sort()).toEqual(["admin", "wizard"]);
  });
});

describe("counting administrators", () => {
  test("**counts the power, not the word `admin`**", async () => {
    // The case a name count gets wrong. `owner` holds `organization:manage` too, so this account has two
    // people who can administer it and not one.
    await join(ADA, "admin");
    await join(OLIVE, "owner");
    await join(BOB, "member");
    expect(await countAdministrators(organizationDatabase(env.DB), OWNED, acme)).toBe(2);
  });

  test("and reads the catalog it is given, not the last one", async () => {
    // The same rows, a catalog whose administrative power nobody here holds.
    await join(ADA, "admin");
    await join(OLIVE, "owner");
    expect(await countAdministrators(organizationDatabase(env.DB), STEWARDED, acme)).toBe(0);
  });
});

describe("changing a role", () => {
  test("an admin demotes an admin", async () => {
    await join(ADA, "admin");
    const bob = await join(BOB, "admin");
    await changeRole(organizationDatabase(env.DB), OWNED, {
      organizationId: acme,
      membershipId: bob,
      role: "member",
      actor: { userId: ADA, role: "admin" },
    });
    expect(await roleOf(bob)).toBe("member");
  });

  test("a member may not, and is told which power is short", async () => {
    const bob = await join(BOB, "member");
    await expect(
      changeRole(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: bob,
        role: "admin",
        actor: { userId: CAT, role: "member" },
      }),
    ).rejects.toThrow(/organization:manage/);
    expect(await roleOf(bob)).toBe("member");
  });

  test("**an admin may not mint another administrator.** That takes `members:manage`", async () => {
    // The planted escalation, and the reason `requireMayAssign` is a second check rather than a wider
    // first one. An admin who could mint a second admin could install a fourth party at their own level,
    // and the two of them could then hand the account on between themselves.
    const bob = await join(BOB, "member");
    await expect(
      changeRole(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: bob,
        role: "admin",
        actor: { userId: ADA, role: "admin" },
      }),
    ).rejects.toThrow(/members:manage/);
    expect(await roleOf(bob)).toBe("member");
  });

  test("and somebody holding it may — the gate is a gate, not a wall", async () => {
    const bob = await join(BOB, "member");
    await changeRole(organizationDatabase(env.DB), OWNED, {
      organizationId: acme,
      membershipId: bob,
      role: "admin",
      actor: { userId: OLIVE, role: "owner" },
    });
    expect(await roleOf(bob)).toBe("admin");
  });

  test("**an unassignable role cannot be conferred by any caller holding any power**", async () => {
    // The single line between this surface and the two-party transfer. If this landed, ownership would
    // move in one call and `ownership.ts` would be decoration.
    const bob = await join(BOB, "member");
    await expect(
      changeRole(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: bob,
        role: "owner",
        actor: { userId: OLIVE, role: "owner" },
      }),
    ).rejects.toThrow(/not a role that can be given/);
    expect(await roleOf(bob)).toBe("member");
  });

  test("**and a member holding one does not change from here either**", async () => {
    const olive = await join(OLIVE, "owner");
    await join(ADA, "admin");
    await expect(
      changeRole(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: olive,
        role: "admin",
        actor: { userId: ADA, role: "admin" },
      }),
    ).rejects.toThrow(/`owner` role does not change here/);
    expect(await roleOf(olive)).toBe("owner");
  });

  test("**nobody takes away their own administration, whoever else is administering**", async () => {
    // Not the floor wearing a new sentence: Bob administers too, so the account keeps an administrator
    // either way and the count refuses nothing. This is refused for being her own row.
    const ada = await join(ADA, "admin");
    await join(BOB, "admin");
    await expect(
      changeRole(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: ada,
        role: "member",
        actor: { userId: ADA, role: "admin" },
      }),
    ).rejects.toThrow(/your own administration/);
    expect(await roleOf(ada)).toBe("admin");
  });

  test("and the reason names being yourself, not being the last", async () => {
    // The order in `changeRole`, and it is what a reader gets. Ada alone hits both rules; the floor's
    // sentence would send her looking for a colleague to promote, and no colleague makes this allowed.
    const ada = await join(ADA, "admin");
    await expect(
      changeRole(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: ada,
        role: "member",
        actor: { userId: ADA, role: "admin" },
      }),
    ).rejects.toThrow(/your own administration/);
    expect(await countAdministrators(organizationDatabase(env.DB), OWNED, acme)).toBe(1);
  });

  test("a no-op change writes rather than refusing", async () => {
    // Refusing it would make the caller responsible for knowing whether a change is a change, and the
    // answer it holds is one read out of date.
    await join(ADA, "admin");
    const bob = await join(BOB, "member");
    const changed = await changeRole(organizationDatabase(env.DB), OWNED, {
      organizationId: acme,
      membershipId: bob,
      role: "member",
      actor: { userId: ADA, role: "admin" },
    });
    expect(changed.role).toBe("member");
  });

  test("a membership of another organization is a 404, not a write", async () => {
    const other = await makeOrganization("other");
    const bob = await join(BOB, "member", other);
    await expect(
      changeRole(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: bob,
        role: "admin",
        actor: { userId: OLIVE, role: "owner" },
      }),
    ).rejects.toThrow(/No such member/);
    expect(await roleOf(bob)).toBe("member");
  });

  test("**a role the catalog does not declare refuses rather than resolving**", async () => {
    // Planted straight into D1, which is the only way it happens: an older build, a repair script, a
    // migration. A role matching no branch of the matrix would deny everything today and, one refactor
    // later, allow it.
    const bob = await join(BOB, "wizard");
    await expect(
      changeRole(organizationDatabase(env.DB), OWNED, {
        organizationId: acme,
        membershipId: bob,
        role: "member",
        actor: { userId: OLIVE, role: "owner" },
      }),
    ).rejects.toThrow(/No such member/);
    expect(await roleOf(bob)).toBe("wizard");
  });
});

/**
 * The invariant, three times, through one catalog.
 *
 * {@link STEWARDED} separates running the roster from administering the account, which is what makes all
 * three doors reachable by three different acts. The rule is checked in one function and every door
 * below reaches it.
 */
describe("the last administrator", () => {
  test("cannot be demoted", async () => {
    const steward = await join(ADA, "steward");
    await join(BOB, "manager");
    await expect(
      changeRole(organizationDatabase(env.DB), STEWARDED, {
        organizationId: acme,
        membershipId: steward,
        role: "member",
        actor: { userId: BOB, role: "manager" },
      }),
    ).rejects.toThrow(/only person who can administer/);
    expect(await roleOf(steward)).toBe("steward");
    expect(await countAdministrators(organizationDatabase(env.DB), STEWARDED, acme)).toBe(1);
  });

  test("cannot be removed", async () => {
    const steward = await join(ADA, "steward");
    await join(BOB, "manager");
    await expect(
      removeMember(env.DB, STEWARDED, {
        organizationId: acme,
        membershipId: steward,
        actor: { userId: BOB, role: "manager" },
      }),
    ).rejects.toThrow(/only person who can administer/);
    expect(await roleOf(steward)).toBe("steward");
  });

  test("cannot leave", async () => {
    const steward = await join(ADA, "steward");
    await join(BOB, "manager");
    await expect(
      leaveOrganization(env.DB, STEWARDED, { organizationId: acme, actor: { userId: ADA, role: "steward" } }),
    ).rejects.toThrow(/only person who can administer/);
    expect(await roleOf(steward)).toBe("steward");
  });

  test("and all three doors are open the moment somebody else is administering", async () => {
    // The anti-vacuity for all three. Nothing above is refused by a rule that refuses everything: the
    // same three acts, the same catalog, one more steward in the room each time.
    const ada = await join(ADA, "steward");
    const cat = await join(CAT, "steward");
    const olive = await join(OLIVE, "steward");
    await join(DAN, "steward");
    await join(BOB, "manager");

    await changeRole(organizationDatabase(env.DB), STEWARDED, {
      organizationId: acme,
      membershipId: ada,
      role: "member",
      actor: { userId: BOB, role: "manager" },
    });
    expect(await roleOf(ada)).toBe("member");

    await removeMember(env.DB, STEWARDED, {
      organizationId: acme,
      membershipId: olive,
      actor: { userId: BOB, role: "manager" },
    });
    expect(await roleOf(olive)).toBeUndefined();

    await leaveOrganization(env.DB, STEWARDED, { organizationId: acme, actor: { userId: CAT, role: "steward" } });
    expect(await roleOf(cat)).toBeUndefined();
    expect(await countAdministrators(organizationDatabase(env.DB), STEWARDED, acme)).toBe(1);
  });

  test("**an owner-plus-admin account allows the admin's removal**", async () => {
    // The case a role-name count gets wrong, and the reason the floor is stated over a power. Olive owns
    // the account and holds `organization:manage` with it, so removing the one person whose role is
    // spelled `admin` leaves somebody who can still administer it.
    await join(OLIVE, "owner");
    const ada = await join(ADA, "admin");
    expect(await countAdministrators(organizationDatabase(env.DB), OWNED, acme)).toBe(2);

    const removed = await removeMember(env.DB, OWNED, {
      organizationId: acme,
      membershipId: ada,
      actor: { userId: OLIVE, role: "owner" },
    });
    expect(removed.left).toBe(false);
    expect(await roleOf(ada)).toBeUndefined();
    expect(await countAdministrators(organizationDatabase(env.DB), OWNED, acme)).toBe(1);
  });

  test("**two removals at once cannot both land**", async () => {
    // The floor as a predicate rather than as a check in front. Two administrators, each removing the
    // other, each having read a count of two.
    const ada = await join(ADA, "admin");
    const bob = await join(BOB, "admin");

    const settled = await Promise.allSettled([
      removeMember(env.DB, OWNED, {
        organizationId: acme,
        membershipId: bob,
        actor: { userId: ADA, role: "admin" },
      }),
      removeMember(env.DB, OWNED, {
        organizationId: acme,
        membershipId: ada,
        actor: { userId: BOB, role: "admin" },
      }),
    ]);

    expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await countAdministrators(organizationDatabase(env.DB), OWNED, acme)).toBe(1);
  });
});

describe("removing and leaving", () => {
  test("an administrator removes somebody else", async () => {
    await join(ADA, "admin");
    const bob = await join(BOB, "member");
    const { left } = await removeMember(env.DB, OWNED, {
      organizationId: acme,
      membershipId: bob,
      actor: { userId: ADA, role: "admin" },
    });
    expect(left).toBe(false);
    expect(await roleOf(bob)).toBeUndefined();
  });

  test("a member cannot remove anybody else", async () => {
    await join(BOB, "member");
    const cat = await join(CAT, "member");
    await expect(
      removeMember(env.DB, OWNED, {
        organizationId: acme,
        membershipId: cat,
        actor: { userId: BOB, role: "member" },
      }),
    ).rejects.toThrow(/organization:manage/);
    expect(await roleOf(cat)).toBe("member");
  });

  test("**leaving needs no power** — a person may always stop holding an organization's access", async () => {
    await join(ADA, "admin");
    const bob = await join(BOB, "member");
    const { left, membership } = await leaveOrganization(env.DB, OWNED, {
      organizationId: acme,
      actor: { userId: BOB, role: "member" },
    });
    expect(left).toBe(true);
    expect(membership.id).toBe(bob);
    expect(await roleOf(bob)).toBeUndefined();
  });

  test("and naming your own membership through the other door is the same write", async () => {
    await join(ADA, "admin");
    const bob = await join(BOB, "member");
    const { left } = await removeMember(env.DB, OWNED, {
      organizationId: acme,
      membershipId: bob,
      actor: { userId: BOB, role: "member" },
    });
    expect(left).toBe(true);
    expect(await roleOf(bob)).toBeUndefined();
  });

  test("**somebody holding an unassignable role has no exit that is not a transfer**", async () => {
    const olive = await join(OLIVE, "owner");
    await join(ADA, "admin");
    await expect(
      removeMember(env.DB, OWNED, {
        organizationId: acme,
        membershipId: olive,
        actor: { userId: ADA, role: "admin" },
      }),
    ).rejects.toThrow(/holding `owner` cannot be removed/);
    await expect(
      leaveOrganization(env.DB, OWNED, { organizationId: acme, actor: { userId: OLIVE, role: "owner" } }),
    ).rejects.toThrow(/cannot leave while you hold `owner`/);
    expect(await roleOf(olive)).toBe("owner");
  });

  test("leaving an organization you are not in is a 404", async () => {
    await join(ADA, "admin");
    await expect(
      leaveOrganization(env.DB, OWNED, { organizationId: acme, actor: { userId: CAT, role: "member" } }),
    ).rejects.toThrow(/No such member/);
  });

  test("a membership of another organization is a 404, not a delete", async () => {
    const other = await makeOrganization("other");
    const bob = await join(BOB, "member", other);
    await expect(
      removeMember(env.DB, OWNED, {
        organizationId: acme,
        membershipId: bob,
        actor: { userId: OLIVE, role: "owner" },
      }),
    ).rejects.toThrow(/No such member/);
    expect(await roleOf(bob)).toBe("member");
  });
});

describe("what a removal takes with it", () => {
  /** A session of somebody's, pointed at Acme. */
  async function select(sessionId: string, userId: string, organizationId = acme): Promise<void> {
    await organizationDatabase(env.DB)
      .insertInto(ACTING_TABLE)
      .values(ActingOrganization.encode({ sessionId, userId, organizationId, chosen: true, chosenAt: NOW }))
      .execute();
  }

  test("**the acting selection**, or the session lands on another organization's screen mid-task", async () => {
    await join(ADA, "admin");
    const bob = await join(BOB, "member");
    await select("session-bob", BOB);

    await removeMember(env.DB, OWNED, {
      organizationId: acme,
      membershipId: bob,
      actor: { userId: ADA, role: "admin" },
    });
    expect(await countRows("pithy_organization_acting")).toBe(0);
  });

  test("**and a standing offer of ownership**, because D1 cascades nothing", async () => {
    // There are no foreign keys, so the row goes because this statement takes it, not because the
    // database does. An offer left behind is an offer accepted by somebody no longer in the account.
    await join(OLIVE, "owner");
    const bob = await join(BOB, "member");
    await organizationDatabase(env.DB)
      .insertInto(OWNERSHIP_NOMINATIONS_TABLE)
      .values(
        OwnershipNomination.encode({
          organizationId: acme,
          membershipId: bob,
          nominatedByUserId: OLIVE,
          expiresAt: new Date(NOW.getTime() + 86_400_000),
          createdAt: NOW,
        }),
      )
      .execute();

    await removeMember(env.DB, OWNED, {
      organizationId: acme,
      membershipId: bob,
      actor: { userId: OLIVE, role: "owner" },
    });
    expect(await countRows("pithy_organization_ownership_nominations")).toBe(0);
  });

  test("**a removal the floor refuses takes nothing**", async () => {
    // Both cleanups are conditional on the membership having actually gone. A selection cleared for
    // somebody who is still a member causes the exact failure the cleanup exists to prevent.
    const steward = await join(ADA, "steward");
    await join(BOB, "manager");
    await select("session-ada", ADA);

    await expect(
      removeMember(env.DB, STEWARDED, {
        organizationId: acme,
        membershipId: steward,
        actor: { userId: BOB, role: "manager" },
      }),
    ).rejects.toThrow(/only person who can administer/);
    expect(await countRows("pithy_organization_acting")).toBe(1);
    expect(await roleOf(steward)).toBe("steward");
  });

  test("and never another organization's selection for the same person", async () => {
    const other = await makeOrganization("other");
    await join(ADA, "admin");
    const bob = await join(BOB, "member");
    await join(BOB, "member", other);
    await select("session-bob-elsewhere", BOB, other);

    await removeMember(env.DB, OWNED, {
      organizationId: acme,
      membershipId: bob,
      actor: { userId: ADA, role: "admin" },
    });
    expect(await countRows("pithy_organization_acting")).toBe(1);
  });
});
