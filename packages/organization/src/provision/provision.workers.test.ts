// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { ORGANIZATION_MIGRATION_ORDER, organization_0001_init } from "../migrations/0001_init";
import { defineRoles } from "../roles/roles";
import { createOrganization, deleteOrganization, founderRole, renameOrganization, setLogo } from "./provision";

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
      migrations: { "0001_init": organization_0001_init },
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

  test("one person may found several organizations", async () => {
    // Membership uniqueness is per (organization, user), not per user. An agency running two customers'
    // accounts is the ordinary case, not an edge one.
    await createOrganization(env.DB, NESTING, { name: "One", slug: "one", founderUserId: FOUNDER });
    await createOrganization(env.DB, NESTING, { name: "Two", slug: "two", founderUserId: FOUNDER });
    expect(await count("pithy_organization_memberships")).toBe(2);
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
