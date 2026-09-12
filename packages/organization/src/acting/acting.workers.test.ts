// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { ACTING_TABLE, MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import { ORGANIZATION_MIGRATION_ORDER, organization_0001_init } from "../migrations/0001_init";
import { defineRoles } from "../roles/roles";
import { chooseActing, clearActing, hasAnyMembership, listActable, resolveActing, resolveActingIn } from "./acting";

/**
 * **The most important suite in this package.**
 *
 * A membership is transitively a credential to whatever the tenant owns, and every tenanted route
 * starts by turning a session into *what this caller is entitled to do here*. If that step can be
 * talked into answering for an organization the caller does not belong to, every gate downstream is
 * decoration.
 *
 * Against real D1 rather than a mock, deliberately: the properties being asserted **are query shapes**.
 * That the user and the organization are matched in one predicate, that a revoked membership stops
 * resolving with no cache to clear, that choosing twice is one row — none of those is a fact about the
 * code, and a mock would assert the code.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const AARDVARK = "33333333-3333-4333-8333-333333333333";

const INSIDER = "user_11111111";
const STRANGER = "user_22222222";
const NEIGHBOR = "user_33333333";

const SESSION = "session_aaaa";
const OTHER_SESSION = "session_bbbb";

const NOW = new Date("2026-09-05T12:00:00.000Z");

/** The dashboard's catalog, as `defineRoles` expresses it. Three roles that nest, `owner` unassignable. */
const catalog = defineRoles({
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

const db = () => organizationDatabase(env.DB);

async function organization(id: string, name: string, slug: string): Promise<void> {
  await db()
    .insertInto(ORGANIZATIONS_TABLE)
    .values(Organization.encode({ id, name, slug, logo: null, createdAt: NOW, updatedAt: NOW }))
    .execute();
}

async function membership(organizationId: string, userId: string, role: "owner" | "admin" | "member"): Promise<void> {
  await db()
    .insertInto(MEMBERSHIPS_TABLE)
    .values(Membership.encode({ id: crypto.randomUUID(), organizationId, userId, role, createdAt: NOW }))
    .execute();
}

const choose = (userId: string, organizationId: string, sessionId = SESSION, chosen = true) =>
  chooseActing(db(), { userId, sessionId, organizationId, chosen, now: NOW });

/** The refusal a caller sees, flattened so two of them can be compared for being the same answer. */
function clientPayload(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(PithyError);
  const { detail: _detail, ...client } = (error as PithyError).payload;
  return client;
}

beforeEach(async () => {
  for (const table of [
    "pithy_organization_acting",
    "pithy_organization_ownership_nominations",
    "pithy_organization_invitations",
    "pithy_organization_memberships",
    "pithy_organization_organizations",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await runMigrations(env.DB, provider());
  // Two organizations, two people. Beta exists so "a member, but of something else" is a real row
  // rather than a hypothetical — which is the only way the one-predicate rule can be tested at all.
  await organization(ACME, "Acme Games", "acme");
  await organization(BETA, "Beta Studio", "beta");
  await membership(ACME, INSIDER, "admin");
  await membership(BETA, NEIGHBOR, "owner");
});

describe("resolveActing — the session's selection, rejoined against a live membership", () => {
  test("answers with the organization, the acting person, and the role off the row", async () => {
    await choose(INSIDER, ACME);
    const acting = await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION });
    expect(acting).toEqual({
      organizationId: ACME,
      slug: "acme",
      name: "Acme Games",
      userId: INSIDER,
      role: "admin",
      chosen: true,
    });
  });

  test("a session that has chosen nothing resolves nothing", async () => {
    expect(await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION })).toBeNull();
  });

  test("the choice is the session's, not the person's", async () => {
    // Two browsers, two answers. That is the whole reason this is keyed by session id: a preference on
    // a user row would move one window because somebody switched in another.
    await organization(AARDVARK, "Aardvark", "aardvark");
    await membership(AARDVARK, INSIDER, "member");
    await choose(INSIDER, ACME, SESSION);
    await choose(INSIDER, AARDVARK, OTHER_SESSION);
    expect((await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION }))?.slug).toBe("acme");
    expect((await resolveActing(db(), catalog, { userId: INSIDER, sessionId: OTHER_SESSION }))?.slug).toBe("aardvark");
  });

  test("somebody else's selection on the same session id is not inherited", async () => {
    // A session id is not a secret to this table. The read matches the person as well, so a row written
    // under one cannot answer for another who reuses the id.
    await choose(NEIGHBOR, BETA, SESSION);
    expect(await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION })).toBeNull();
  });

  test("nor when the two share the organization, which is the only shape that could have leaked", async () => {
    // The case the simpler assertion above cannot reach. When the other person's row names an
    // organization the caller *also* belongs to, the join on the membership still matches — so the only
    // thing standing between this session and somebody else's answer is `acting.userId`, and a query
    // that dropped it would pass every other case in this file.
    await membership(ACME, NEIGHBOR, "member");
    await choose(NEIGHBOR, ACME, SESSION);
    expect(await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION })).toBeNull();
  });

  test("a selection row for one organization with a membership only in another resolves nothing", async () => {
    // Written straight to D1, because no writer in this package would produce it — which is exactly why
    // the read has to survive it. The failure this catches is a join on the session alone, which would
    // answer out of whatever row that session holds regardless of who belongs where.
    await env.DB.prepare(
      "insert into pithy_organization_acting (session_id, user_id, organization_id, chosen, chosen_at) values (?, ?, ?, 1, ?)",
    )
      .bind(SESSION, INSIDER, BETA, NOW.getTime())
      .run();
    expect(await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION })).toBeNull();
  });

  test("a revoked membership stops resolving on the next read, with nothing to clear", async () => {
    await choose(INSIDER, ACME);
    expect(await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION })).not.toBeNull();
    await db().deleteFrom(MEMBERSHIPS_TABLE).where("userId", "=", INSIDER).execute();
    // No sign-out, no cache expiry, no cleanup of the acting row: removing the membership is the whole
    // of revocation, and the very next read is where it lands.
    expect(await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION })).toBeNull();
  });

  test("a stale selection is no selection rather than a refusal, so another membership still answers", async () => {
    // Being removed from one account is not being removed from the product. The caller may still belong
    // elsewhere, and this read must not be the thing that decides they do not.
    await organization(AARDVARK, "Aardvark", "aardvark");
    await membership(AARDVARK, INSIDER, "member");
    await choose(INSIDER, AARDVARK);
    await db()
      .deleteFrom(MEMBERSHIPS_TABLE)
      .where("userId", "=", INSIDER)
      .where("organizationId", "=", AARDVARK)
      .execute();
    expect(await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION })).toBeNull();
    expect((await listActable(db(), catalog, INSIDER)).map((row) => row.slug)).toEqual(["acme"]);
  });

  test("a role D1 holds that this catalog does not declare refuses rather than resolving", async () => {
    // The column is text and the catalog is the adopter's, so a repair script, a rolled-back deploy or a
    // bug can put anything in it. Decoding means an unrecognized value fails closed instead of arriving
    // at the matrix as a string that matches nothing — which denies everything today and, one refactor
    // later, allows it.
    await choose(INSIDER, ACME);
    await env.DB.prepare("update pithy_organization_memberships set role = 'superuser' where user_id = ?")
      .bind(INSIDER)
      .run();
    const error = await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("organization/not_found");
  });

  test("the refusal for an undeclared role is the same answer as a non-member's", async () => {
    // Otherwise it is an oracle of a different shape: a caller who can tell "your row is broken" from
    // "you are not in this one" learns that the row exists.
    await choose(INSIDER, ACME);
    await env.DB.prepare("update pithy_organization_memberships set role = 'superuser' where user_id = ?")
      .bind(INSIDER)
      .run();
    const undeclared = clientPayload(
      await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION }).catch((thrown: unknown) => thrown),
    );
    const notAMember = clientPayload(
      await chooseActing(db(), { userId: STRANGER, sessionId: SESSION, organizationId: ACME, now: NOW }).catch(
        (thrown: unknown) => thrown,
      ),
    );
    expect(undeclared).toEqual(notAMember);
  });

  test("an empty user id resolves nothing, however many rows exist", async () => {
    // The shape a bug takes when a session is absent and the id defaults rather than refusing.
    await choose(INSIDER, ACME);
    expect(await resolveActing(db(), catalog, { userId: "", sessionId: SESSION })).toBeNull();
    expect(await resolveActing(db(), catalog, { userId: INSIDER, sessionId: "" })).toBeNull();
  });

  test("every role in the catalog round-trips off the row", async () => {
    for (const role of ["owner", "admin", "member"] as const) {
      await db().deleteFrom(MEMBERSHIPS_TABLE).where("userId", "=", STRANGER).execute();
      await membership(ACME, STRANGER, role);
      await choose(STRANGER, ACME);
      expect((await resolveActing(db(), catalog, { userId: STRANGER, sessionId: SESSION }))?.role).toBe(role);
    }
  });
});

describe("resolveActingIn — a named organization, proved in one predicate", () => {
  test("a member resolves, and `chosen` is false because a route named it rather than a person", async () => {
    const acting = await resolveActingIn(db(), catalog, { userId: INSIDER, organizationId: ACME });
    expect(acting?.slug).toBe("acme");
    expect(acting?.role).toBe("admin");
    expect(acting?.chosen).toBe(false);
  });

  test("a member of another organization resolves nothing for this one", async () => {
    // The failure this catches is a filter on the organization that forgets the user, or on the user
    // that forgets the organization. Both produce a real membership row and the wrong organization.
    expect(await resolveActingIn(db(), catalog, { userId: NEIGHBOR, organizationId: ACME })).toBeNull();
  });

  test("and still resolves their own, so the gate is a gate rather than a wall", async () => {
    expect((await resolveActingIn(db(), catalog, { userId: NEIGHBOR, organizationId: BETA }))?.slug).toBe("beta");
  });

  test("an organization that does not exist resolves nothing", async () => {
    expect(
      await resolveActingIn(db(), catalog, {
        userId: INSIDER,
        organizationId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toBeNull();
  });

  test("a selection elsewhere does not leak into a named resolution", async () => {
    await choose(INSIDER, ACME);
    expect(await resolveActingIn(db(), catalog, { userId: INSIDER, organizationId: BETA })).toBeNull();
  });
});

describe("chooseActing — the whole boundary on the write side", () => {
  test("a stranger with no membership anywhere is refused", async () => {
    const error = await choose(STRANGER, ACME).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.status).toBe(404);
  });

  test("a member of another organization is refused, and refused identically", async () => {
    const notAMember = clientPayload(await choose(NEIGHBOR, ACME).catch((thrown: unknown) => thrown));
    const noSuchThing = clientPayload(
      await choose(NEIGHBOR, "44444444-4444-4444-8444-444444444444").catch((thrown: unknown) => thrown),
    );
    expect(notAMember).toEqual(noSuchThing);
    expect(notAMember.message).toBe("That organization does not exist.");
  });

  test("the refusal names neither the organization nor whoever does belong to it", async () => {
    const error = await choose(STRANGER, ACME).catch((thrown: unknown) => thrown);
    const payload = (error as PithyError).payload;
    expect(payload.message).not.toContain("Acme");
    expect(payload.message).not.toContain(INSIDER);
    // `detail` is stripped by the HTTP codec, reaches the log verbatim, and is where an operator gets
    // the distinction the client is denied.
    expect(payload.detail).toBe(`user ${STRANGER} has no membership in organization ${ACME}`);
  });

  test("a refused choice writes nothing, so the session keeps whatever it had", async () => {
    await choose(NEIGHBOR, BETA);
    await choose(NEIGHBOR, ACME).catch(() => undefined);
    expect((await resolveActing(db(), catalog, { userId: NEIGHBOR, sessionId: SESSION }))?.slug).toBe("beta");
  });

  test("choosing twice is one row, not two answers for one session", async () => {
    await organization(AARDVARK, "Aardvark", "aardvark");
    await membership(AARDVARK, INSIDER, "member");
    await choose(INSIDER, ACME);
    await choose(INSIDER, AARDVARK);
    const rows = await db().selectFrom(ACTING_TABLE).selectAll().where("sessionId", "=", SESSION).execute();
    expect(rows).toHaveLength(1);
    expect((await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION }))?.slug).toBe("aardvark");
  });

  test("the whole value is replaced, so a reused session id inherits nobody's selection", async () => {
    await choose(NEIGHBOR, BETA, SESSION);
    await choose(INSIDER, ACME, SESSION);
    const rows = await db().selectFrom(ACTING_TABLE).selectAll().where("sessionId", "=", SESSION).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(INSIDER);
    expect(await resolveActing(db(), catalog, { userId: NEIGHBOR, sessionId: SESSION })).toBeNull();
  });

  test("`chosen` records whether it was a decision, and defaults to one", async () => {
    await choose(INSIDER, ACME);
    expect((await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION }))?.chosen).toBe(true);
    await choose(INSIDER, ACME, SESSION, false);
    expect((await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION }))?.chosen).toBe(false);
  });
});

describe("listActable — what the chooser draws", () => {
  test("every organization this person may act in, ordered by name", async () => {
    await organization(AARDVARK, "Aardvark", "aardvark");
    await membership(AARDVARK, INSIDER, "member");
    expect((await listActable(db(), catalog, INSIDER)).map((row) => row.name)).toEqual(["Aardvark", "Acme Games"]);
  });

  test("and nobody else's, however many organizations exist", async () => {
    expect((await listActable(db(), catalog, NEIGHBOR)).map((row) => row.slug)).toEqual(["beta"]);
    expect(await listActable(db(), catalog, STRANGER)).toEqual([]);
  });

  test("each row carries the role, so a chooser can draw what somebody is there as", async () => {
    expect((await listActable(db(), catalog, NEIGHBOR))[0]?.role).toBe("owner");
  });

  test("a role this catalog does not declare refuses the list rather than hiding a row", async () => {
    // Skipping would hide an organization from the one screen that exists to say which ones there are,
    // and would hide the deployment mistake that put the value in the column.
    await env.DB.prepare("update pithy_organization_memberships set role = 'superuser' where user_id = ?")
      .bind(INSIDER)
      .run();
    await expect(listActable(db(), catalog, INSIDER)).rejects.toBeInstanceOf(PithyError);
  });
});

describe("hasAnyMembership and clearActing", () => {
  test("belonging somewhere and belonging nowhere are different answers", async () => {
    expect(await hasAnyMembership(db(), INSIDER)).toBe(true);
    expect(await hasAnyMembership(db(), STRANGER)).toBe(false);
  });

  test("it counts rows without decoding a role, so a broken row still answers", async () => {
    await env.DB.prepare("update pithy_organization_memberships set role = 'superuser' where user_id = ?")
      .bind(INSIDER)
      .run();
    expect(await hasAnyMembership(db(), INSIDER)).toBe(true);
  });

  test("clearing takes the selection with the session, and leaves the membership alone", async () => {
    await choose(INSIDER, ACME);
    await clearActing(db(), { sessionId: SESSION });
    expect(await resolveActing(db(), catalog, { userId: INSIDER, sessionId: SESSION })).toBeNull();
    expect(await hasAnyMembership(db(), INSIDER)).toBe(true);
  });

  test("clearing one session leaves another's selection standing", async () => {
    await choose(INSIDER, ACME, SESSION);
    await choose(INSIDER, ACME, OTHER_SESSION);
    await clearActing(db(), { sessionId: SESSION });
    expect((await resolveActing(db(), catalog, { userId: INSIDER, sessionId: OTHER_SESSION }))?.slug).toBe("acme");
  });
});
