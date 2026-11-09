// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { D1Dialect } from "kysely-d1";
import { beforeEach, describe, expect, test } from "vitest";
import { Organization } from "../data/organization";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import { defineRoles } from "../roles/roles";
import {
  createOrganization,
  deleteOrganization,
  founderRole,
  type MembershipJoined,
  type OrganizationCreated,
  type OrganizationCreateStatements,
  renameOrganization,
  setLogo,
  updateOrganizationAsOperator,
} from "./provision";

/**
 * Founding, changing and ending an account, against real D1.
 *
 * One property carries the first half of this file: **an organization and its founder's membership land
 * together or not at all.** An organization with no membership is an account nobody can administer and
 * nobody can delete — it is unreachable through every route, because every route starts from a
 * membership. So the interesting cases are the failures, and what they left behind. None of them is
 * visible against a mocked database, which would return whatever the code asked it to.
 *
 * The second half is the same argument about deletion. A partial delete leaves a membership answering
 * *yes* to "is this person a member of `X`" for an `X` that is gone, and an acting row pointing a live
 * session at it.
 */

const FOUNDER = "user_11111111";
const STRANGER = "user_22222222";

/**
 * A nesting catalog whose strongest role may not be handed to anybody — the dashboard's shape.
 *
 * `owner` is excluded from assignment because ownership is accepted rather than conferred, so the
 * founder is `admin`. That is the rule doing its work rather than a coincidence, which is why the
 * academy catalog below is here too.
 */
const NESTING = defineRoles({
  powers: ["connections:read", "connections:manage"],
  roles: {
    owner: [
      "organization:read",
      "organization:manage",
      "organization:delete",
      "members:manage",
      "billing:manage",
      "connections:read",
      "connections:manage",
    ],
    admin: ["organization:read", "organization:manage", "members:manage", "connections:read", "connections:manage"],
    member: ["organization:read", "connections:read"],
  },
  administrativePower: "organization:manage",
  nests: ["member", "admin", "owner"],
  unassignable: ["owner"],
});

/** The academy's parallel set, with nothing excluded — so the same rule reaches `owner`. */
const PARALLEL = defineRoles({
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

const TABLES = [
  "pithy_organization_foundings",
  "pithy_organization_lifecycle",
  "pithy_organization_acting",
  "pithy_organization_ownership_nominations",
  "pithy_organization_invitations",
  "pithy_organization_memberships",
  "pithy_organization_organizations",
  "pithy_migrations",
  "pithy_migrations_lock",
];

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "organization",
      order: ORGANIZATION_MIGRATION_ORDER,
      migrations: ORGANIZATION_MIGRATIONS,
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

/**
 * The real `DB`, with `batch` handed to `intercept` first.
 *
 * The seam for the retry cases. `createOrganization` takes the binding, so a wrapper is how a test stands
 * inside the window between two attempts — the only place `withD1Retry`'s idempotency guard is reachable.
 * Returning runs the statements for real; throwing is the attempt that failed.
 */
function wrapping(real: D1Database, intercept: (statements: D1PreparedStatement[]) => Promise<void>): D1Database {
  return {
    prepare: (query: string) => real.prepare(query),
    exec: (query: string) => real.exec(query),
    dump: () => real.dump(),
    withSession: (anchor?: string) => real.withSession(anchor),
    batch: async (statements: D1PreparedStatement[]) => {
      await intercept(statements);
      return real.batch(statements);
    },
  } as unknown as D1Database;
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(PithyError);
  return (error as PithyError).payload.code;
}

beforeEach(async () => {
  for (const table of TABLES) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await runMigrations(env.DB, provider());
});

describe("founderRole", () => {
  test("is the first assignable role that administers", () => {
    // Two catalogs, one rule, two answers. The dashboard's `owner` is excluded from assignment, so the
    // founder is `admin`; the academy excludes nothing, so it is `owner`. A rule that read "the first
    // role" or "the role called admin" would get one of these two wrong.
    expect(founderRole(NESTING)).toBe("admin");
    expect(founderRole(PARALLEL)).toBe("owner");
  });

  test("a catalog whose only administering role is unassignable is refused, naming the power", () => {
    const unfoundable = defineRoles({
      roles: {
        owner: ["organization:read", "organization:manage", "organization:delete", "members:manage", "billing:manage"],
        member: ["organization:read"],
      },
      administrativePower: "organization:manage",
      unassignable: ["owner"],
    });
    const failure = (() => {
      try {
        founderRole(unfoundable);
        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();
    expect(codeOf(failure)).toBe("organization/invalid_role_catalog");
    expect((failure as PithyError).payload.detail).toContain("organization:manage");
  });
});

describe("createOrganization", () => {
  test("the founder administers, and nobody owns the account", async () => {
    const { organization, membership } = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      slug: "acme-games",
      founderUserId: FOUNDER,
    });

    expect(organization.name).toBe("Acme Games");
    expect(organization.slug).toBe("acme-games");
    expect(organization.logo).toBeNull();
    expect(membership.organizationId).toBe(organization.id);
    expect(membership.userId).toBe(FOUNDER);
    expect(membership.role).toBe("admin");
    // And nobody owns it. That is the state a new account is in until somebody accepts a nomination, and
    // it is the difference between "who made this" and "who is paying for it".
    const owners = await env.DB.prepare(
      "select count(*) as n from pithy_organization_memberships where role = 'owner'",
    ).first<{ n: number }>();
    expect(owners?.n).toBe(0);
  });

  test("the same call under the academy's catalog founds an owner", async () => {
    const { membership } = await createOrganization(env.DB, PARALLEL, {
      name: "Northside Academy",
      slug: "northside",
      founderUserId: FOUNDER,
    });
    expect(membership.role).toBe("owner");
  });

  test("both rows are actually in D1, not just in the return value", async () => {
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      slug: "acme-games",
      founderUserId: FOUNDER,
    });
    const row = await env.DB.prepare(
      "select organization_id, user_id, role from pithy_organization_memberships",
    ).first();
    expect(row).toEqual({ organization_id: organization.id, user_id: FOUNDER, role: "admin" });
  });

  test("ids are opaque and unrelated between the two rows", async () => {
    // The membership id is what a removal names, and what a member's mark is served under. Deriving it
    // from the organization id would make a membership guessable from a segment already on screen.
    const first = await createOrganization(env.DB, NESTING, { name: "A", slug: "a", founderUserId: FOUNDER });
    const second = await createOrganization(env.DB, NESTING, { name: "B", slug: "b", founderUserId: FOUNDER });
    const ids = [first.organization.id, first.membership.id, second.organization.id, second.membership.id];
    expect(new Set(ids).size).toBe(4);
  });

  test("a taken slug refuses with `slug_taken`, and writes nothing", async () => {
    await createOrganization(env.DB, NESTING, { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER });

    const failure = await createOrganization(env.DB, NESTING, {
      name: "Acme Games Again",
      slug: "acme-games",
      founderUserId: STRANGER,
    }).catch((error: unknown) => error);

    expect(codeOf(failure)).toBe("organization/slug_taken");
    expect((failure as PithyError).payload.status).toBe(409);
    // The second attempt must not have left a membership pointing at the first organization, which is what
    // a non-atomic write produces: a stranger silently joined to somebody else's account.
    expect(await count("pithy_organization_organizations")).toBe(1);
    expect(await count("pithy_organization_memberships")).toBe(1);
  });

  test("a membership that cannot be written takes the organization with it", async () => {
    // The failure that matters, forced from the one seam this function has.
    //
    // `newId` is called twice per call — organization first, membership second — so this one hands out a
    // fresh organization id and a *colliding* membership id. That is what makes the SECOND statement the
    // one that fails: the organization insert succeeds, and the membership insert violates the primary
    // key. Colliding both ids would fail on the first statement instead, and the case would pass against a
    // non-atomic implementation.
    //
    // Without one batch, this is exactly how an ownerless, adminless organization is born — and one is
    // unreachable by every route, because every route starts at a membership.
    const membershipId = "88888888-8888-4888-8888-888888888888";
    let call = 0;
    const newId = () => (call++ % 2 === 0 ? crypto.randomUUID() : membershipId);

    await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      slug: "acme-games",
      founderUserId: FOUNDER,
      newId,
    });

    const failure = await createOrganization(env.DB, NESTING, {
      name: "Beta",
      slug: "beta",
      founderUserId: STRANGER,
      newId,
    }).catch((error: unknown) => error);

    // Not `slug_taken` — the slug was free. This is the other branch, and it must not claim the slug was
    // taken just because something went wrong near a slug.
    expect(codeOf(failure)).toBe("core/internal");
    expect(await count("pithy_organization_organizations")).toBe(1);
    expect(await count("pithy_organization_memberships")).toBe(1);
    const orphan = await env.DB.prepare("select id from pithy_organization_organizations where slug = ?")
      .bind("beta")
      .first();
    expect(orphan).toBeNull();
  });

  test("the failure's detail never quotes the statement", async () => {
    // `detail` reaches logs and the audit trail verbatim, and a D1 error message can carry the statement —
    // which carries the account's name and the founder's user id. The refusal says the shape of the
    // failure and never its content.
    const membershipId = "77777777-7777-4777-8777-777777777777";
    let call = 0;
    const newId = () => (call++ % 2 === 0 ? crypto.randomUUID() : membershipId);
    await createOrganization(env.DB, NESTING, { name: "First", slug: "first", founderUserId: FOUNDER, newId });

    const failure = await createOrganization(env.DB, NESTING, {
      name: "Confidential Holdings",
      slug: "beta",
      founderUserId: STRANGER,
      newId,
    }).catch((error: unknown) => error);

    const detail = (failure as PithyError).payload.detail ?? "";
    expect(detail).not.toContain("Confidential Holdings");
    expect(detail).not.toContain(STRANGER);
    expect(detail).not.toContain("insert into");
  });

  test("a slug that is not URL-safe never reaches the database", async () => {
    // The column's own pattern, enforced on the write path rather than only at a form. A slug is a path
    // segment before it is a label.
    for (const slug of ["Acme Games", "acme_games", "acme--games", "", "a".repeat(65)]) {
      const failure = await createOrganization(env.DB, NESTING, {
        name: "Acme",
        slug,
        founderUserId: FOUNDER,
      }).catch((error: unknown) => error);
      expect(codeOf(failure), slug).toBe("validation/invalid_input");
    }
    expect(await count("pithy_organization_organizations")).toBe(0);
  });

  test("the clock is a seam, so both rows share one instant", async () => {
    // Two `new Date()` calls straddling a write produce an organization created a millisecond before its
    // own administrator joined it. Harmless until somebody sorts by it.
    const now = new Date("2026-08-05T12:00:00.000Z");
    const { organization, membership } = await createOrganization(env.DB, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
      now,
    });
    expect(organization.createdAt.getTime()).toBe(now.getTime());
    expect(organization.updatedAt.getTime()).toBe(now.getTime());
    expect(membership.createdAt.getTime()).toBe(now.getTime());
  });

  test("a slug taken during a retry refuses, rather than answering for rows that were never written", async () => {
    // `withD1Retry`'s idempotency guard answers *success* for a unique-constraint failure on any attempt
    // after the first — it assumes the conflict is with this caller's own committed row. Our unique key is
    // a slug anybody may hold, so that assumption is not ours to make. This is the window: attempt 0 dies
    // in transport, a stranger commits `acme` during the backoff, attempt 1 hits the index.
    let batches = 0;
    const racing = wrapping(env.DB, async () => {
      batches += 1;
      if (batches > 1) return;
      await createOrganization(env.DB, NESTING, { name: "Rival", slug: "acme", founderUserId: "user_rival" });
      throw new Error("D1_ERROR: Network connection lost");
    });

    const failure = await createOrganization(racing, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    }).catch((error: unknown) => error);

    expect(codeOf(failure)).toBe("organization/slug_taken");
    // The stranger's rows, and only those. Ours rolled back with the batch.
    expect(await count("pithy_organization_organizations")).toBe(1);
    expect(await count("pithy_organization_memberships")).toBe(1);
    const holder = await env.DB.prepare("select user_id from pithy_organization_memberships").first<{
      user_id: string;
    }>();
    expect(holder?.user_id).toBe("user_rival");
  });

  test("the retry still succeeds when the row the constraint names is our own", async () => {
    // The other side of the same guard, and the reason it is not simply switched off: attempt 0 commits and
    // *then* loses its connection, so attempt 1 collides with the caller's own rows. That is a completed
    // founding, and it must answer as one.
    let batches = 0;
    const flaky = wrapping(env.DB, async (statements) => {
      batches += 1;
      if (batches > 1) return;
      await env.DB.batch(statements);
      throw new Error("D1_ERROR: Network connection lost");
    });

    const { organization, membership } = await createOrganization(flaky, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    });

    expect(await count("pithy_organization_organizations")).toBe(1);
    const row = await env.DB.prepare("select id from pithy_organization_organizations").first<{ id: string }>();
    expect(row?.id).toBe(organization.id);
    expect(membership.organizationId).toBe(organization.id);
  });

  test("a commit whose fault D1 has not been taught to name still answers as the founding it was", async () => {
    // The third way a batch can end, and the one neither case above covers: it *commits*, and then the
    // call throws a fault matching none of `withD1Retry`'s transient signatures — that list is only "the
    // signatures Cloudflare is known to surface", so an unrecognized envelope reaches the catch directly,
    // with no retry and no idempotency guard. The rows are there. Asking "does anybody hold this slug"
    // answers yes about *our own* committed row, and calling that a clash refuses a founding that
    // happened. The question is whose row it is, which is why `organizationIdWithSlug` returns an id.
    let batches = 0;
    const unnamedFault = wrapping(env.DB, async (statements) => {
      batches += 1;
      if (batches > 1) return;
      await env.DB.batch(statements);
      throw new Error("D1_ERROR: something D1 has not been taught to say");
    });

    const { organization, membership } = await createOrganization(unnamedFault, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    });

    // One founding, one batch: nothing retried, and the rows returned are the rows that landed.
    expect(batches).toBe(1);
    expect(await count("pithy_organization_organizations")).toBe(1);
    expect(await count("pithy_organization_memberships")).toBe(1);
    const row = await env.DB.prepare("select id, slug from pithy_organization_organizations").first<{
      id: string;
      slug: string;
    }>();
    expect(row?.id).toBe(organization.id);
    expect(row?.slug).toBe("acme");
    expect(membership.organizationId).toBe(organization.id);
  });

  test("a stranger's row under the same fault is still a refusal", async () => {
    // The other half, so the fix above cannot be "call every unnamed fault a success". Here the batch
    // rolls back and somebody else holds the slug: a different id, and the caller must be told.
    let batches = 0;
    const unnamedFault = wrapping(env.DB, async () => {
      batches += 1;
      if (batches > 1) return;
      await createOrganization(env.DB, NESTING, { name: "Rival", slug: "acme", founderUserId: "user_rival" });
      throw new Error("D1_ERROR: something D1 has not been taught to say");
    });

    const failure = await createOrganization(unnamedFault, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    }).catch((error: unknown) => error);

    expect(codeOf(failure)).toBe("organization/slug_taken");
    expect(await count("pithy_organization_organizations")).toBe(1);
    const holder = await env.DB.prepare("select user_id from pithy_organization_memberships").first<{
      user_id: string;
    }>();
    expect(holder?.user_id).toBe("user_rival");
  });

  test("one person may found several organizations", async () => {
    // Membership uniqueness is per (organization, user), not per user. An agency running two customers'
    // accounts is the ordinary case, not an edge one.
    await createOrganization(env.DB, NESTING, { name: "One", slug: "one", founderUserId: FOUNDER });
    await createOrganization(env.DB, NESTING, { name: "Two", slug: "two", founderUserId: FOUNDER });
    expect(await count("pithy_organization_memberships")).toBe(2);
  });
});

/**
 * Founding without naming a short name — and the constraint, not a query, deciding who gets it.
 *
 * **A check-then-write would be a window, and the migration says so at the column.** So the derived
 * path writes, reads the failure, and tries again with a suffix. Everything here is against real D1 for
 * that one reason: the property is the unique index, and a mock would answer whatever it was told to.
 */
describe("createOrganization, with no slug supplied", () => {
  test("the short name comes from the display name", async () => {
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      founderUserId: FOUNDER,
    });
    expect(organization.slug).toBe("acme-games");
    const row = await env.DB.prepare("select slug from pithy_organization_organizations").first<{ slug: string }>();
    expect(row?.slug).toBe("acme-games");
  });

  test("a name that reduces to nothing still founds an account", async () => {
    // The refusal nobody can act on — *that short name is invalid*, to somebody who never typed one.
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "株式会社",
      founderUserId: FOUNDER,
    });
    expect(Organization.shape.slug.safeParse(organization.slug).success).toBe(true);
    expect(await count("pithy_organization_organizations")).toBe(1);
  });

  test("two accounts with one name both land, on different short names", async () => {
    const first = await createOrganization(env.DB, NESTING, { name: "Acme Games", founderUserId: FOUNDER });
    const second = await createOrganization(env.DB, NESTING, { name: "Acme Games", founderUserId: STRANGER });

    expect(first.organization.slug).toBe("acme-games");
    expect(second.organization.slug).not.toBe(first.organization.slug);
    expect(second.organization.slug.startsWith("acme-games-")).toBe(true);
    expect(await count("pithy_organization_organizations")).toBe(2);
  });

  test("eight foundings of one name at once leave eight accounts, and eight short names", async () => {
    // The unique constraint as the arbiter, exercised rather than asserted. Every one of these derives
    // the same base; seven of them lose that race and take a suffix.
    const founded = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        createOrganization(env.DB, NESTING, { name: "Acme Games", founderUserId: `user_${index}` }),
      ),
    );
    const slugs = founded.map((created) => created.organization.slug);
    expect(new Set(slugs).size).toBe(8);
    expect(slugs.every((slug) => Organization.shape.slug.safeParse(slug).success)).toBe(true);
    expect(await count("pithy_organization_organizations")).toBe(8);
    expect(await count("pithy_organization_memberships")).toBe(8);
  });

  test("a derived slug that keeps colliding refuses on the name, not on a short name nobody chose", async () => {
    // With the suffix pinned, every attempt is predictable — so the whole ladder can be taken first and
    // the exhausted case actually reached. The refusal must not say "pick another short name" to a
    // caller who never supplied one.
    const newSuffix = (length: number) => "z".repeat(length);
    const taken = ["acme-games", "acme-games-zzzz", "acme-games-zzzzz", "acme-games-zzzzzz", "acme-games-zzzzzzz"];
    for (const slug of taken) {
      await createOrganization(env.DB, NESTING, { name: "Acme Games", slug, founderUserId: FOUNDER });
    }

    const failure = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      founderUserId: STRANGER,
      newSuffix,
    }).catch((error: unknown) => error);

    expect(codeOf(failure)).toBe("organization/slug_taken");
    expect((failure as PithyError).payload.message).toBe("That name is already taken.");
    expect(await count("pithy_organization_organizations")).toBe(taken.length);
  });

  test("a supplied slug never retries — a collision is still the caller's to resolve", async () => {
    // The additive half of this. Someone who picked `acme-games` and got a 409 must not silently be
    // given `acme-games-7f3a` instead; they chose an address, and a rename is not an answer to a
    // collision.
    await createOrganization(env.DB, NESTING, { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER });

    const failure = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      slug: "acme-games",
      founderUserId: STRANGER,
      newSuffix: () => "zzzz",
    }).catch((error: unknown) => error);

    expect(codeOf(failure)).toBe("organization/slug_taken");
    expect(await count("pithy_organization_organizations")).toBe(1);
  });
});

/**
 * Founding with an idempotency key: a client that lost the answer sends the same request again and gets the
 * organization the key founded, rather than a second one. The record's primary key decides every race.
 */
describe("createOrganization, with an idempotency key", () => {
  const KEY = "founding-7f3a";

  async function foundingRows(): Promise<{ founder_user_id: string; organization_id: string; slug: string | null }[]> {
    const { results } = await env.DB.prepare(
      "select founder_user_id, organization_id, slug from pithy_organization_foundings order by created_at",
    ).all<{ founder_user_id: string; organization_id: string; slug: string | null }>();
    return results;
  }

  test("the first use founds the organization and records what the key founded", async () => {
    const created = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      founderUserId: FOUNDER,
      idempotencyKey: KEY,
    });

    expect(created.replayed).toBe(false);
    expect(await foundingRows()).toEqual([
      { founder_user_id: FOUNDER, organization_id: created.organization.id, slug: null },
    ]);
  });

  test("a repeat by the same founder answers the same organization, and writes nothing", async () => {
    let built = 0;
    const statements = {
      onCreate: () => {
        built += 1;
        return [];
      },
      onJoin: () => {
        built += 1;
        return [];
      },
    };
    const input = { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER, idempotencyKey: KEY };
    const first = await createOrganization(env.DB, NESTING, input, statements);
    const again = await createOrganization(env.DB, NESTING, input, statements);

    expect(again.replayed).toBe(true);
    expect(again.organization).toEqual(first.organization);
    expect(again.membership).toEqual(first.membership);
    expect(built).toBe(2);
    expect(await count("pithy_organization_organizations")).toBe(1);
    expect(await count("pithy_organization_memberships")).toBe(1);
    expect(await count("pithy_organization_foundings")).toBe(1);
  });

  test("a repeat answers the organization as it is now, the founder's role included", async () => {
    const input = { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY };
    const first = await createOrganization(env.DB, NESTING, input);
    await env.DB.prepare("update pithy_organization_memberships set role = 'owner' where id = ?")
      .bind(first.membership.id)
      .run();

    const again = await createOrganization(env.DB, NESTING, input);

    expect(again.membership.role).toBe("owner");
  });

  test("the same key with a different name or slug refuses with `idempotency_key_reused`, and founds nothing", async () => {
    await createOrganization(env.DB, NESTING, { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY });

    for (const changed of [{ name: "Acme Studios" }, { name: "Acme Games", slug: "acme-games" }]) {
      const failure = await createOrganization(env.DB, NESTING, {
        ...changed,
        founderUserId: FOUNDER,
        idempotencyKey: KEY,
      }).catch((error: unknown) => error);
      expect(codeOf(failure)).toBe("organization/idempotency_key_reused");
      expect((failure as PithyError).payload.status).toBe(409);
    }
    expect(await count("pithy_organization_organizations")).toBe(1);
    expect(await count("pithy_organization_memberships")).toBe(1);
  });

  test("the refusal's detail never quotes the name either request asked for", async () => {
    await createOrganization(env.DB, NESTING, { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY });
    const failure = await createOrganization(env.DB, NESTING, {
      name: "Acme Studios",
      founderUserId: FOUNDER,
      idempotencyKey: KEY,
    }).catch((error: unknown) => error);
    const detail = (failure as PithyError).payload.detail ?? "";
    expect(detail).not.toContain("Acme Games");
    expect(detail).not.toContain("Acme Studios");
  });

  test("another founder sending the same key founds their own organization", async () => {
    const theirs = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      founderUserId: STRANGER,
      idempotencyKey: KEY,
    });
    const ours = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      founderUserId: FOUNDER,
      idempotencyKey: KEY,
    });

    expect(ours.replayed).toBe(false);
    expect(ours.organization.id).not.toBe(theirs.organization.id);
    expect(ours.membership.userId).toBe(FOUNDER);
    expect(await count("pithy_organization_organizations")).toBe(2);
  });

  test("two concurrent foundings with one key found one organization, and the loser answers it", async () => {
    const input = { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY };
    const both = await Promise.all([
      createOrganization(env.DB, NESTING, input),
      createOrganization(env.DB, NESTING, input),
    ]);

    expect(both.map((created) => created.replayed).sort()).toEqual([false, true]);
    expect(both[0].organization.id).toBe(both[1].organization.id);
    expect(await count("pithy_organization_organizations")).toBe(1);
    expect(await count("pithy_organization_memberships")).toBe(1);
  });

  for (const slug of [undefined, "acme-games"]) {
    test(`a founding that loses the race inside its batch answers the winner's organization (slug ${slug ?? "derived"})`, async () => {
      // The winner commits between the loser's read of the record and the loser's batch, so the loser's batch is
      // the one the primary key or the slug refuses.
      let winner: string | undefined;
      const racing = wrapping(env.DB, async () => {
        if (winner !== undefined) return;
        const created = await createOrganization(env.DB, NESTING, {
          name: "Acme Games",
          slug,
          founderUserId: FOUNDER,
          idempotencyKey: KEY,
        });
        winner = created.organization.id;
      });

      const loser = await createOrganization(racing, NESTING, {
        name: "Acme Games",
        slug,
        founderUserId: FOUNDER,
        idempotencyKey: KEY,
      });

      expect(loser.replayed).toBe(true);
      expect(loser.organization.id).toBe(winner);
      expect(await count("pithy_organization_organizations")).toBe(1);
      expect(await count("pithy_organization_memberships")).toBe(1);
    });
  }

  test("a loser that asked for a different name is refused, not answered", async () => {
    let raced = false;
    const racing = wrapping(env.DB, async () => {
      if (raced) return;
      raced = true;
      await createOrganization(env.DB, NESTING, { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY });
    });

    const failure = await createOrganization(racing, NESTING, {
      name: "Acme Studios",
      founderUserId: FOUNDER,
      idempotencyKey: KEY,
    }).catch((error: unknown) => error);

    expect(codeOf(failure)).toBe("organization/idempotency_key_reused");
    expect(await count("pithy_organization_organizations")).toBe(1);
  });

  test("a founding without a key writes no record, and two of them found two organizations", async () => {
    const input = { name: "Acme Games", founderUserId: FOUNDER };
    const first = await createOrganization(env.DB, NESTING, input);
    const second = await createOrganization(env.DB, NESTING, input);

    expect([first.replayed, second.replayed]).toEqual([false, false]);
    expect(await count("pithy_organization_organizations")).toBe(2);
    expect(await count("pithy_organization_foundings")).toBe(0);
  });

  test("a derived slug that retried on a taken one is answered as committed when the founding is repeated", async () => {
    await createOrganization(env.DB, NESTING, { name: "Acme Games", slug: "acme-games", founderUserId: STRANGER });
    const input = {
      name: "Acme Games",
      founderUserId: FOUNDER,
      idempotencyKey: KEY,
      newSuffix: (length: number) => "q".repeat(length),
    };

    const first = await createOrganization(env.DB, NESTING, input);
    const again = await createOrganization(env.DB, NESTING, input);

    expect(first.organization.slug).toBe("acme-games-qqqq");
    expect(again.replayed).toBe(true);
    expect(again.organization.slug).toBe("acme-games-qqqq");
    expect(await count("pithy_organization_organizations")).toBe(2);
  });

  test("a commit that loses its connection answers the founding once, and a repeat answers it again", async () => {
    let batches = 0;
    const flaky = wrapping(env.DB, async (statements) => {
      batches += 1;
      if (batches > 1) return;
      await env.DB.batch(statements);
      throw new Error("D1_ERROR: Network connection lost");
    });
    const input = { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY };

    const first = await createOrganization(flaky, NESTING, input);
    const again = await createOrganization(env.DB, NESTING, input);

    expect(first.replayed).toBe(false);
    expect(again.organization.id).toBe(first.organization.id);
    expect(await count("pithy_organization_organizations")).toBe(1);
  });

  test("deleting the organization deletes its record, and the key founds a new organization afterwards", async () => {
    const input = { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY };
    const first = await createOrganization(env.DB, NESTING, input);
    const spared = await createOrganization(env.DB, NESTING, { ...input, idempotencyKey: "another-key" });

    await deleteOrganization(env.DB, first.organization.id);
    expect(await foundingRows()).toEqual([
      { founder_user_id: FOUNDER, organization_id: spared.organization.id, slug: null },
    ]);

    const again = await createOrganization(env.DB, NESTING, input);
    expect(again.replayed).toBe(false);
    expect(again.organization.id).not.toBe(first.organization.id);
  });

  test("a repeat after the founder left the organization is the same 404 as everywhere else", async () => {
    const input = { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY };
    const first = await createOrganization(env.DB, NESTING, input);
    await env.DB.prepare("delete from pithy_organization_memberships where id = ?").bind(first.membership.id).run();

    const failure = await createOrganization(env.DB, NESTING, input).catch((error: unknown) => error);

    expect(codeOf(failure)).toBe("organization/not_found");
    expect(await count("pithy_organization_organizations")).toBe(1);
  });

  test("a repeat for a soft-deleted organization is the 404 every door answers, and the key stays spent until the purge", async () => {
    const input = { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY };
    const first = await createOrganization(env.DB, NESTING, input);
    await env.DB.prepare("update pithy_organization_organizations set deleted_at = ?, purge_after = ? where id = ?")
      .bind(Date.now(), Date.now() + 30 * 86_400_000, first.organization.id)
      .run();

    const failure = await createOrganization(env.DB, NESTING, input).catch((error: unknown) => error);

    expect(codeOf(failure)).toBe("organization/not_found");
    expect((failure as PithyError).payload.status).toBe(404);
    expect(await count("pithy_organization_organizations")).toBe(1);
    expect(await count("pithy_organization_foundings")).toBe(1);
  });

  test("a repeat for a restored organization answers it again", async () => {
    const input = { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY };
    const first = await createOrganization(env.DB, NESTING, input);
    await env.DB.prepare("update pithy_organization_organizations set deleted_at = ?, purge_after = ? where id = ?")
      .bind(Date.now(), Date.now() + 30 * 86_400_000, first.organization.id)
      .run();
    await env.DB.prepare(
      "update pithy_organization_organizations set deleted_at = null, purge_after = null where id = ?",
    )
      .bind(first.organization.id)
      .run();

    const again = await createOrganization(env.DB, NESTING, input);

    expect(again.replayed).toBe(true);
    expect(again.organization.id).toBe(first.organization.id);
  });

  test("a repeat for a restored organization whose suspension is still in force is the 403 its members get", async () => {
    const now = new Date("2026-11-08T12:00:00.000Z");
    const until = new Date(now.getTime() + 86_400_000);
    const input = { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY };
    const first = await createOrganization(env.DB, NESTING, { ...input, now });
    await env.DB.prepare(
      "update pithy_organization_organizations set suspended_at = ?, suspended_until = ?, deleted_at = ?, purge_after = ? where id = ?",
    )
      .bind(now.getTime(), until.getTime(), now.getTime(), now.getTime() + 30 * 86_400_000, first.organization.id)
      .run();
    await env.DB.prepare(
      "update pithy_organization_organizations set deleted_at = null, purge_after = null where id = ?",
    )
      .bind(first.organization.id)
      .run();

    const failure = await createOrganization(env.DB, NESTING, { ...input, now }).catch((error: unknown) => error);

    expect(codeOf(failure)).toBe("organization/organization_suspended");
    expect((failure as PithyError).payload.status).toBe(403);
    expect(await count("pithy_organization_organizations")).toBe(1);
  });

  test("a repeat for a suspended organization is the 403 its members get, and answers it once the suspension ends", async () => {
    const now = new Date("2026-11-08T12:00:00.000Z");
    const until = new Date(now.getTime() + 86_400_000);
    const input = { name: "Acme Games", founderUserId: FOUNDER, idempotencyKey: KEY };
    const first = await createOrganization(env.DB, NESTING, { ...input, now });
    await env.DB.prepare(
      "update pithy_organization_organizations set suspended_at = ?, suspended_until = ? where id = ?",
    )
      .bind(now.getTime(), until.getTime(), first.organization.id)
      .run();

    const failure = await createOrganization(env.DB, NESTING, { ...input, now }).catch((error: unknown) => error);
    expect(codeOf(failure)).toBe("organization/organization_suspended");
    expect((failure as PithyError).payload.status).toBe(403);
    expect((failure as PithyError).payload.params).toEqual({ suspendedUntil: until.toISOString() });

    const after = await createOrganization(env.DB, NESTING, { ...input, now: until });
    expect(after.replayed).toBe(true);
    expect(after.organization.id).toBe(first.organization.id);
    expect(await count("pithy_organization_organizations")).toBe(1);
  });

  test("a key the column would not hold never reaches the database", async () => {
    for (const idempotencyKey of ["", "k".repeat(201)]) {
      const failure = await createOrganization(env.DB, NESTING, {
        name: "Acme Games",
        founderUserId: FOUNDER,
        idempotencyKey,
      }).catch((error: unknown) => error);
      expect(codeOf(failure)).toBe("validation/invalid_input");
    }
    expect(await count("pithy_organization_organizations")).toBe(0);
  });
});

describe("renameOrganization", () => {
  test("changes the name and the version, and never the slug", async () => {
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const later = new Date("2026-02-02T00:00:00.000Z");
    await renameOrganization(env.DB, { organizationId: organization.id, name: "Acme Games", now: later });

    const row = await env.DB.prepare(
      "select name, slug, created_at, updated_at from pithy_organization_organizations where id = ?",
    )
      .bind(organization.id)
      .first<{ name: string; slug: string; created_at: number; updated_at: number }>();
    expect(row?.name).toBe("Acme Games");
    // The slug addresses the account in every link, bookmark and audit entry ever written down.
    expect(row?.slug).toBe("acme");
    expect(row?.created_at).toBe(organization.createdAt.getTime());
    expect(row?.updated_at).toBe(later.getTime());
  });

  test("refuses a name the column would not hold, and writes nothing", async () => {
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    });
    for (const name of ["", "n".repeat(129)]) {
      const failure = await renameOrganization(env.DB, { organizationId: organization.id, name }).catch(
        (error: unknown) => error,
      );
      expect(codeOf(failure), JSON.stringify(name)).toBe("validation/invalid_input");
    }
    const row = await env.DB.prepare("select name from pithy_organization_organizations where id = ?")
      .bind(organization.id)
      .first<{ name: string }>();
    expect(row?.name).toBe("Acme");
  });

  test("an organization that is not there is the same 404 as everywhere else", async () => {
    const failure = await renameOrganization(env.DB, {
      organizationId: "00000000-0000-4000-8000-000000000000",
      name: "Ghost",
    }).catch((error: unknown) => error);
    expect(codeOf(failure)).toBe("organization/not_found");
    expect((failure as PithyError).payload.status).toBe(404);
  });
});

describe("updateOrganizationAsOperator", () => {
  test("changes the name, the short name and the seat limit together", async () => {
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    });
    const later = new Date("2026-03-03T00:00:00.000Z");
    const updated = await updateOrganizationAsOperator(env.DB, {
      organizationId: organization.id,
      name: "Acme Games",
      slug: "acme-games",
      seatLimit: 25,
      now: later,
    });
    expect(updated.name).toBe("Acme Games");
    expect(updated.slug).toBe("acme-games");
    expect(updated.seatLimit).toBe(25);
    expect(updated.updatedAt).toEqual(later);
  });

  test("absent leaves a field alone, and a null seat limit lifts the limit", async () => {
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    });
    await updateOrganizationAsOperator(env.DB, { organizationId: organization.id, seatLimit: 3, now: new Date() });
    const lifted = await updateOrganizationAsOperator(env.DB, {
      organizationId: organization.id,
      seatLimit: null,
      now: new Date(),
    });
    expect(lifted.seatLimit).toBeNull();
    expect(lifted.name).toBe("Acme");
    expect(lifted.slug).toBe("acme");
  });

  test("a short name another account holds is refused, naming the holder, and nothing is written", async () => {
    const { organization: beta } = await createOrganization(env.DB, NESTING, {
      name: "Beta Studio",
      slug: "beta",
      founderUserId: FOUNDER,
    });
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    });
    const failure = await updateOrganizationAsOperator(env.DB, {
      organizationId: organization.id,
      name: "Renamed",
      slug: "beta",
      now: new Date(),
    }).catch((error: unknown) => error);
    expect(codeOf(failure)).toBe("organization/slug_taken");
    const payload = (failure as PithyError).payload;
    expect(payload.message).toContain("Beta Studio");
    expect(payload.params).toMatchObject({ slug: "beta", holderId: beta.id, holderName: "Beta Studio" });
    const row = await env.DB.prepare("select name, slug from pithy_organization_organizations where id = ?")
      .bind(organization.id)
      .first<{ name: string; slug: string }>();
    expect(row).toEqual({ name: "Acme", slug: "acme" });
  });

  test("the account's own short name is not a collision with itself", async () => {
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    });
    const updated = await updateOrganizationAsOperator(env.DB, {
      organizationId: organization.id,
      slug: "acme",
      now: new Date(),
    });
    expect(updated.slug).toBe("acme");
  });

  test("a short name or a seat limit the column would not hold is refused", async () => {
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    });
    for (const input of [{ slug: "Not Safe" }, { seatLimit: 0 }, { seatLimit: 1.5 }]) {
      const failure = await updateOrganizationAsOperator(env.DB, {
        organizationId: organization.id,
        ...input,
        now: new Date(),
      }).catch((error: unknown) => error);
      expect(codeOf(failure), JSON.stringify(input)).toBe("validation/invalid_input");
    }
  });

  test("an organization that is not there is the same 404 as everywhere else", async () => {
    const failure = await updateOrganizationAsOperator(env.DB, {
      organizationId: "00000000-0000-4000-8000-000000000000",
      name: "Ghost",
      now: new Date(),
    }).catch((error: unknown) => error);
    expect(codeOf(failure)).toBe("organization/not_found");
  });
});

describe("setLogo", () => {
  const PNG = `data:image/png;base64,${"A".repeat(64)}`;

  test("stores a mark, and clearing it is a first-class instruction", async () => {
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    });

    await setLogo(env.DB, { organizationId: organization.id, logo: PNG });
    let row = await env.DB.prepare("select logo from pithy_organization_organizations where id = ?")
      .bind(organization.id)
      .first<{ logo: string | null }>();
    expect(row?.logo).toBe(PNG);

    // `null` is *take the mark off*, not *leave it alone*. Without it the only way back is uploading a
    // blank image.
    await setLogo(env.DB, { organizationId: organization.id, logo: null });
    row = await env.DB.prepare("select logo from pithy_organization_organizations where id = ?")
      .bind(organization.id)
      .first<{ logo: string | null }>();
    expect(row?.logo).toBeNull();
  });

  test("refuses everything the kit's one image rule refuses, and never writes it", async () => {
    const { organization } = await createOrganization(env.DB, NESTING, {
      name: "Acme",
      slug: "acme",
      founderUserId: FOUNDER,
    });
    await setLogo(env.DB, { organizationId: organization.id, logo: PNG });

    const refused = [
      // A `data:` URL too, and the difference between it and a PNG is the whole of what makes the column
      // safe to render. A check for "starts with data:" would pass this.
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      // A link to somebody else's host. Stored, not linked — a remote URL is a fetch of an attacker-chosen
      // host from a screen listing somebody's tenancies.
      "https://example.com/logo.png",
      // Past the ceiling. One row must not make every read of the account expensive.
      `data:image/png;base64,${"A".repeat(32 * 1024)}`,
      // Anchored at both ends, so nothing follows the payload.
      `data:image/png;base64,AAAA"><script>alert(1)</script>`,
    ];
    for (const logo of refused) {
      const failure = await setLogo(env.DB, { organizationId: organization.id, logo }).catch((error: unknown) => error);
      expect(codeOf(failure), logo.slice(0, 40)).toBe("validation/invalid_input");
    }

    // And the mark that was already there is untouched by any of them.
    const row = await env.DB.prepare("select logo from pithy_organization_organizations where id = ?")
      .bind(organization.id)
      .first<{ logo: string | null }>();
    expect(row?.logo).toBe(PNG);
  });

  test("an organization that is not there is the same 404 as everywhere else", async () => {
    const failure = await setLogo(env.DB, {
      organizationId: "00000000-0000-4000-8000-000000000000",
      logo: null,
    }).catch((error: unknown) => error);
    expect(codeOf(failure)).toBe("organization/not_found");
  });
});

describe("deleteOrganization", () => {
  /** Give an account a child in every table that can point at one. */
  async function furnish(organizationId: string, suffix: string): Promise<void> {
    await env.DB.prepare(
      "insert into pithy_organization_invitations (id, organization_id, email, role, invited_by_user_id, token_digest, status, expires_at, accepted_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, null, ?)",
    )
      .bind(
        `11111111-1111-4111-8111-11111111111${suffix}`,
        organizationId,
        `invitee${suffix}@example.com`,
        "member",
        FOUNDER,
        `digest-${suffix}`,
        "pending",
        1_800_000_000_000,
        1_700_000_000_000,
      )
      .run();
    await env.DB.prepare(
      "insert into pithy_organization_ownership_nominations (organization_id, membership_id, nominated_by_user_id, expires_at, created_at) values (?, ?, ?, ?, ?)",
    )
      .bind(
        organizationId,
        `22222222-2222-4222-8222-22222222222${suffix}`,
        FOUNDER,
        1_800_000_000_000,
        1_700_000_000_000,
      )
      .run();
    await env.DB.prepare(
      "insert into pithy_organization_acting (session_id, user_id, organization_id, chosen, chosen_at) values (?, ?, ?, ?, ?)",
    )
      .bind(`session-${suffix}`, FOUNDER, organizationId, 1, 1_700_000_000_000)
      .run();
  }

  test("takes every claim on the account with it, and leaves the other account alone", async () => {
    const doomed = await createOrganization(env.DB, NESTING, { name: "One", slug: "one", founderUserId: FOUNDER });
    const spared = await createOrganization(env.DB, NESTING, { name: "Two", slug: "two", founderUserId: STRANGER });
    await furnish(doomed.organization.id, "1");
    await furnish(spared.organization.id, "2");

    await deleteOrganization(env.DB, doomed.organization.id);

    // A membership that outlived its organization still answers *yes* to "is this person a member of X",
    // and an acting row still points a live session at it. Neither may survive.
    for (const table of [
      "pithy_organization_organizations",
      "pithy_organization_memberships",
      "pithy_organization_invitations",
      "pithy_organization_ownership_nominations",
      "pithy_organization_acting",
    ]) {
      expect(await count(table), table).toBe(1);
    }
    const survivor = await env.DB.prepare("select id from pithy_organization_organizations").first<{ id: string }>();
    expect(survivor?.id).toBe(spared.organization.id);
    const stillActing = await env.DB.prepare("select organization_id from pithy_organization_acting").first<{
      organization_id: string;
    }>();
    expect(stillActing?.organization_id).toBe(spared.organization.id);
  });

  test("an organization that is not there is the same 404 as everywhere else", async () => {
    const failure = await deleteOrganization(env.DB, "00000000-0000-4000-8000-000000000000").catch(
      (error: unknown) => error,
    );
    expect(codeOf(failure)).toBe("organization/not_found");
  });
});

describe("the adopter's own tenanted rows go with the account", () => {
  /*
    Every adopter who composes this has tables keyed on `organizationId`, and this capability cannot see
    them. The seam takes statements rather than doing the work, and they join the same batch. That is the
    half worth testing: not that the rows go, but that when the batch fails, the *account* and the
    adopter's rows are both still there.
  */

  /**
   * A Kysely over the adopter's own schema, which is what the seam's binding is for.
   *
   * This is the shape the seam exists to make possible: their table names, their columns, checked by
   * their own types rather than cast past this capability's.
   */
  function theirs(d1: D1Database): Kysely<{ adopterConnections: { id: string; organizationId: string } }> {
    return new Kysely({ dialect: new D1Dialect({ database: d1 }), plugins: [new CamelCasePlugin()] });
  }

  /** A table of the adopter's, keyed the way every tenanted table of theirs is. */
  async function theirTable(): Promise<void> {
    await env.DB.prepare("drop table if exists adopter_connections").run();
    await env.DB.prepare("create table adopter_connections (id text primary key, organization_id text not null)").run();
  }

  async function theirRows(organizationId: string): Promise<number> {
    const { results } = await env.DB.prepare("select count(*) as n from adopter_connections where organization_id = ?")
      .bind(organizationId)
      .all<{ n: number }>();
    return results[0]?.n ?? 0;
  }

  test("they are deleted in the same transaction", async () => {
    await theirTable();
    const created = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      slug: "acme-games",
      founderUserId: FOUNDER,
    });
    await env.DB.prepare("insert into adopter_connections (id, organization_id) values ('c1', ?)")
      .bind(created.organization.id)
      .run();
    expect(await theirRows(created.organization.id)).toBe(1);

    await deleteOrganization(env.DB, created.organization.id, (d1, organizationId) => [
      theirs(d1).deleteFrom("adopterConnections").where("organizationId", "=", organizationId),
    ]);

    expect(await theirRows(created.organization.id)).toBe(0);
    expect(await count("pithy_organization_organizations")).toBe(0);
  });

  test("**their rows survive a failure anywhere in the delete**", async () => {
    /*
      The property the batch buys, and the one an "after the fact" sweep cannot offer. The adopter's
      statement has to **succeed** and something later fail: in the batch, their delete rolls back with the
      account; outside it, their rows would be gone and the account would not.
    */
    await theirTable();
    const created = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      slug: "acme-games",
      founderUserId: FOUNDER,
    });
    await env.DB.prepare("insert into adopter_connections (id, organization_id) values ('c1', ?)")
      .bind(created.organization.id)
      .run();

    // Fails the whole batch after it has been composed, which is where a partial delete would show.
    const failing = wrapping(env.DB, async () => {
      throw new Error("the batch did not commit");
    });

    await expect(
      deleteOrganization(failing, created.organization.id, (d1, organizationId) => [
        theirs(d1).deleteFrom("adopterConnections").where("organizationId", "=", organizationId),
      ]),
    ).rejects.toThrow();

    // Nothing moved: not the account, not its memberships, and not the adopter's row.
    expect(await count("pithy_organization_organizations")).toBe(1);
    expect(await count("pithy_organization_memberships")).toBe(1);
    expect(await theirRows(created.organization.id)).toBe(1);
  });

  test("composing without the seam is unchanged", async () => {
    const created = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      slug: "acme-games",
      founderUserId: FOUNDER,
    });
    await deleteOrganization(env.DB, created.organization.id);
    expect(await count("pithy_organization_organizations")).toBe(0);
  });

  test("their statements run before the memberships go, so one may still read a membership", async () => {
    // Ordered first, deliberately: an adopter's sweep may need to resolve something through a membership
    // the batch is about to remove. Proved by deleting *by* a membership id rather than by organization.
    await theirTable();
    const created = await createOrganization(env.DB, NESTING, {
      name: "Acme Games",
      slug: "acme-games",
      founderUserId: FOUNDER,
    });
    const membership = await env.DB.prepare("select id from pithy_organization_memberships where organization_id = ?")
      .bind(created.organization.id)
      .first<{ id: string }>();
    if (!membership) throw new Error("expected the founder's membership");
    await env.DB.prepare("insert into adopter_connections (id, organization_id) values (?, ?)")
      .bind(membership.id, created.organization.id)
      .run();

    await deleteOrganization(env.DB, created.organization.id, (d1) => [
      theirs(d1).deleteFrom("adopterConnections").where("id", "=", membership.id),
    ]);
    expect(await theirRows(created.organization.id)).toBe(0);
  });
});

describe("the adopter's own rows begin with the account", () => {
  /** A Kysely over the adopter's own schema: a log of what their builders wrote, in order. */
  function theirs(d1: D1Database): Kysely<{
    adopterRows: { seq?: number; kind: string; organizationId: string; membershipId: string | null };
  }> {
    return new Kysely({ dialect: new D1Dialect({ database: d1 }), plugins: [new CamelCasePlugin()] });
  }

  async function theirTable(): Promise<void> {
    await env.DB.prepare("drop table if exists adopter_rows").run();
    await env.DB.prepare(
      "create table adopter_rows (seq integer primary key autoincrement, kind text not null, organization_id text not null, membership_id text)",
    ).run();
  }

  async function theirRows(): Promise<{ kind: string; organization_id: string; membership_id: string | null }[]> {
    const { results } = await env.DB.prepare(
      "select kind, organization_id, membership_id from adopter_rows order by seq",
    ).all<{ kind: string; organization_id: string; membership_id: string | null }>();
    return results;
  }

  /**
   * A settings row copied out of the founder's membership, so it lands only when the membership is already
   * written: run ahead of the inserts, the select finds nothing and the row is missing.
   */
  const settings: OrganizationCreateStatements = (d1, { membershipId }) => [
    {
      compile: () =>
        sql`insert into adopter_rows (kind, organization_id, membership_id)
          select 'settings', organization_id, id from pithy_organization_memberships where id = ${membershipId}`.compile(
          theirs(d1),
        ),
    },
  ];

  beforeEach(theirTable);

  test("onCreate's statements run in the founding batch, after both inserts", async () => {
    const batches: number[] = [];
    const watched = wrapping(env.DB, async (statements) => void batches.push(statements.length));

    const { organization, membership } = await createOrganization(
      watched,
      NESTING,
      { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER },
      { onCreate: settings },
    );

    // One batch: the organization, the membership, and the adopter's statement.
    expect(batches).toEqual([3]);
    expect(await theirRows()).toEqual([
      { kind: "settings", organization_id: organization.id, membership_id: membership.id },
    ]);
  });

  test("onCreate is told the ids, the founder and the name", async () => {
    const seen: OrganizationCreated[] = [];
    const { organization, membership } = await createOrganization(
      env.DB,
      NESTING,
      { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER },
      {
        onCreate: (_d1, created) => {
          seen.push(created);
          return [];
        },
      },
    );
    expect(seen).toEqual([
      { organizationId: organization.id, membershipId: membership.id, founderUserId: FOUNDER, name: "Acme Games" },
    ]);
  });

  test("**a statement from onCreate that fails rolls the founding back**", async () => {
    const failure = await createOrganization(
      env.DB,
      NESTING,
      { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER },
      {
        onCreate: (d1, { organizationId }) => [
          theirs(d1).insertInto("adopterRows").values({ kind: "settings", organizationId, membershipId: null }),
          // The second statement violates the adopter's own NOT NULL, after the first has run.
          theirs(d1)
            .insertInto("adopterRows")
            .values({ kind: null as never, organizationId, membershipId: null }),
        ],
      },
    ).catch((error: unknown) => error);

    expect(codeOf(failure)).toBe("core/internal");
    expect(await count("pithy_organization_organizations")).toBe(0);
    expect(await count("pithy_organization_memberships")).toBe(0);
    expect(await theirRows()).toEqual([]);
  });

  test("**a derived slug's retry reuses the same ids and statements, and the rows land once**", async () => {
    await createOrganization(env.DB, NESTING, { name: "Acme Games", slug: "acme-games", founderUserId: STRANGER });
    await env.DB.prepare("delete from adopter_rows").run();

    let built = 0;
    const attempts: number[] = [];
    const watched = wrapping(env.DB, async (statements) => void attempts.push(statements.length));
    const { organization, membership } = await createOrganization(
      watched,
      NESTING,
      { name: "Acme Games", founderUserId: FOUNDER, newSuffix: (length) => "q".repeat(length) },
      {
        onCreate: (d1, created) => {
          built += 1;
          return settings(d1, created);
        },
      },
    );

    expect(organization.slug).toBe("acme-games-qqqq");
    // Two attempts, each carrying the one statement the builder returned the one time it ran.
    expect(built).toBe(1);
    expect(attempts).toEqual([3, 3]);
    expect(await theirRows()).toEqual([
      { kind: "settings", organization_id: organization.id, membership_id: membership.id },
    ]);
  });

  test("a commit that loses its connection writes the rows once", async () => {
    let batches = 0;
    const flaky = wrapping(env.DB, async (statements) => {
      batches += 1;
      if (batches > 1) return;
      await env.DB.batch(statements);
      throw new Error("D1_ERROR: Network connection lost");
    });

    const { organization } = await createOrganization(
      flaky,
      NESTING,
      { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER },
      { onCreate: settings },
    );

    expect(await theirRows()).toHaveLength(1);
    expect((await theirRows())[0]?.organization_id).toBe(organization.id);
  });

  test("onJoin runs for the founder, after onCreate, in the same batch", async () => {
    const batches: number[] = [];
    const watched = wrapping(env.DB, async (statements) => void batches.push(statements.length));
    const joined: MembershipJoined[] = [];

    const { organization, membership } = await createOrganization(
      watched,
      NESTING,
      { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER },
      {
        onCreate: settings,
        onJoin: (d1, event) => {
          joined.push(event);
          return [
            theirs(d1)
              .insertInto("adopterRows")
              .values({ kind: "profile", organizationId: event.organizationId, membershipId: event.membershipId }),
          ];
        },
      },
    );

    expect(batches).toEqual([4]);
    expect(joined).toEqual([
      {
        organizationId: organization.id,
        membershipId: membership.id,
        userId: FOUNDER,
        role: "admin",
        via: "founded",
        invitationId: null,
      },
    ]);
    expect((await theirRows()).map((row) => row.kind)).toEqual(["settings", "profile"]);
  });

  /** Makes the founder `owner` in the founding batch, the role founding itself never hands out. */
  const ownership: OrganizationCreateStatements = (d1, { membershipId }) => [
    {
      compile: () =>
        sql`update pithy_organization_memberships set role = 'owner' where id = ${membershipId}`.compile(theirs(d1)),
    },
  ];

  test("**the founder's membership is returned with the role the batch committed**", async () => {
    const { membership } = await createOrganization(
      env.DB,
      NESTING,
      { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER },
      { onCreate: ownership },
    );
    expect(membership.role).toBe("owner");
  });

  test("the organization is returned as the batch committed it", async () => {
    const { organization } = await createOrganization(
      env.DB,
      NESTING,
      { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER },
      {
        onCreate: (d1, { organizationId }) => [
          {
            compile: () =>
              sql`update pithy_organization_organizations set seat_limit = 5 where id = ${organizationId}`.compile(
                theirs(d1),
              ),
          },
        ],
      },
    );
    expect(organization.seatLimit).toBe(5);
  });

  test("a derived slug that retries returns the committed role", async () => {
    await createOrganization(env.DB, NESTING, { name: "Acme Games", slug: "acme-games", founderUserId: STRANGER });

    const { organization, membership } = await createOrganization(
      env.DB,
      NESTING,
      { name: "Acme Games", founderUserId: FOUNDER, newSuffix: (length) => "q".repeat(length) },
      { onCreate: ownership },
    );

    expect(organization.slug).toBe("acme-games-qqqq");
    expect(membership.role).toBe("owner");
  });

  test("onJoin is told the role founding inserted, before onCreate's statements run", async () => {
    const joined: MembershipJoined[] = [];
    await createOrganization(
      env.DB,
      NESTING,
      { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER },
      {
        onCreate: ownership,
        onJoin: (_d1, event) => {
          joined.push(event);
          return [];
        },
      },
    );
    expect(joined.map((event) => event.role)).toEqual(["admin"]);
  });

  test("an onCreate that removes the founder's membership refuses rather than answering a row that is gone", async () => {
    const failure = await createOrganization(
      env.DB,
      NESTING,
      { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER },
      {
        onCreate: (d1, { membershipId }) => [
          {
            compile: () =>
              sql`delete from pithy_organization_memberships where id = ${membershipId}`.compile(theirs(d1)),
          },
        ],
      },
    ).catch((error: unknown) => error);
    expect(codeOf(failure)).toBe("core/internal");
  });

  test("a founding the input refuses never runs the builders", async () => {
    let built = 0;
    const failure = await createOrganization(
      env.DB,
      NESTING,
      { name: "Acme Games", slug: "Not A Slug", founderUserId: FOUNDER },
      {
        onCreate: () => {
          built += 1;
          return [];
        },
      },
    ).catch((error: unknown) => error);
    expect(codeOf(failure)).toBe("validation/invalid_input");
    expect(built).toBe(0);
  });

  test("without builders the founding batch is the two inserts it always was", async () => {
    const batches: number[] = [];
    const watched = wrapping(env.DB, async (statements) => void batches.push(statements.length));
    await createOrganization(watched, NESTING, { name: "Acme Games", slug: "acme-games", founderUserId: FOUNDER }, {});
    await createOrganization(watched, NESTING, { name: "Beta", slug: "beta", founderUserId: FOUNDER });
    expect(batches).toEqual([2, 2]);
  });
});
