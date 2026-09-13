// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { Invitation } from "../data/invitation";
import { INVITATIONS_TABLE, MEMBERSHIPS_TABLE, organizationDatabase } from "../data/tables";
import { ORGANIZATION_MIGRATION_ORDER, organization_0001_init } from "../migrations/0001_init";
import { defineRoles } from "../roles/roles";
import { acceptInvitation, invite, listInvitations, resendInvitation, withdrawInvitation } from "./invite";
import { invitationDigest, mintInvitationToken } from "./token";

/**
 * The invitation, against real D1.
 *
 * **Every property worth having here is a property of a query**, so a mocked database would assert the
 * code rather than the constraint: that N concurrent redemptions produce one membership is the unique
 * index and the conditional update doing it, that an expired row is refused is a comparison in a
 * handler over a row SQLite actually stored, and that the plaintext token is nowhere in the table is a
 * claim about columns. All three are only true of a database.
 */

/** The binding the workers project provides. Cast rather than declared, so this file owns its own types. */
const d1 = (env as unknown as { DB: D1Database }).DB;
const db = organizationDatabase(d1);

/** A catalog shaped like the dashboard's: three roles that nest, `owner` unassignable. */
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

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const INVITER = "user-inviter";
const ADA = "user-ada";
const NOW = new Date("2026-09-01T12:00:00.000Z");
const TTL_DAYS = 14;

/** An app-database provider holding just this capability's migration set. */
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
    await d1.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await runMigrations(d1, provider());
});

/** Mint one offer, with everything uninteresting left at a sensible default. */
async function offer(seed: { email?: string; role?: "member" | "admin"; now?: Date; organizationId?: string } = {}) {
  return await invite(env.DB, catalog, {
    organizationId: seed.organizationId ?? ORG,
    email: seed.email ?? "Ada@Example.com",
    role: seed.role ?? "member",
    invitedByUserId: INVITER,
    ttlDays: TTL_DAYS,
    now: seed.now ?? NOW,
  });
}

/** How many memberships exist, across every organization. */
async function membershipCount(): Promise<number> {
  const rows = await db.selectFrom(MEMBERSHIPS_TABLE).selectAll().execute();
  return rows.length;
}

/** The refusal a call produced, or a failure saying it produced none. */
async function refusal(run: () => Promise<unknown>): Promise<PithyError> {
  try {
    await run();
  } catch (error) {
    return error as PithyError;
  }
  throw new Error("expected a refusal, and the call returned");
}

describe("invite", () => {
  test("normalizes the address before it is written", async () => {
    const minted = await offer({ email: "  Ada@Example.COM " });
    expect(minted.invitation.email).toBe("ada@example.com");

    const [row] = await db.selectFrom(INVITATIONS_TABLE).selectAll().execute();
    expect(row?.email).toBe("ada@example.com");
  });

  test("refuses a role the catalog does not call assignable", async () => {
    // `owner` is a declared role. It is excluded from assignment because ownership moves by a two-party
    // transfer, and this is the door that would otherwise hand it over in one call.
    const error = await refusal(() =>
      invite(env.DB, catalog, {
        organizationId: ORG,
        email: "ada@example.com",
        // Deliberately cast: the type already refuses this, and the runtime has to as well for the day
        // a role arrives off a request body that the type system never saw.
        role: "owner" as "member",
        invitedByUserId: INVITER,
        ttlDays: TTL_DAYS,
        now: NOW,
      }),
    );
    expect(error.payload.code).toBe("organization/forbidden");
    expect(await db.selectFrom(INVITATIONS_TABLE).selectAll().execute()).toHaveLength(0);
  });

  test("refuses a role no catalog declares, with the same refusal as an excluded one", async () => {
    const unknown = await refusal(() =>
      invite(env.DB, catalog, {
        organizationId: ORG,
        email: "ada@example.com",
        role: "sysadmin" as "member",
        invitedByUserId: INVITER,
        ttlDays: TTL_DAYS,
        now: NOW,
      }),
    );
    expect(unknown.payload.code).toBe("organization/forbidden");
  });

  test("stores the digest, and the plaintext token appears in no column of any row", async () => {
    const minted = await offer();

    // Every value of every row, not just `token_digest` — a token copied into a second column would
    // satisfy an assertion about the first one and still be a live credential at rest.
    const { results } = await d1.prepare("select * from pithy_organization_invitations").all();
    expect(results).toHaveLength(1);
    for (const row of results) {
      for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
        expect(`${column}=${String(value)}`).not.toContain(minted.token);
      }
    }
    expect(minted.invitation.tokenDigest).not.toBe(minted.token);
  });

  test("expires ttlDays after the instant it was minted", async () => {
    const minted = await offer();
    expect(minted.invitation.expiresAt.getTime()).toBe(NOW.getTime() + TTL_DAYS * 24 * 60 * 60 * 1000);
  });

  test("supersedes a live offer to the same address rather than leaving two live tokens", async () => {
    const first = await offer();
    const second = await offer();

    const outstanding = await listInvitations(db, ORG);
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]?.id).toBe(second.invitation.id);

    // The superseded token is dead. Two working links would make withdrawing one of them a revoke that
    // does not revoke.
    const error = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: first.token,
        session: { userId: ADA, email: "ada@example.com" },
        now: NOW,
      }),
    );
    if (!("payload" in (error as object)))
      throw new Error(`not a PithyError: ${String(error)} ${JSON.stringify(error)}`);
    expect(error.payload.code).toBe("organization/invitation_invalid");
    expect(await membershipCount()).toBe(0);
  });

  test("leaves another organization's offer to the same address alone", async () => {
    const elsewhere = await offer({ organizationId: OTHER_ORG });
    await offer({ organizationId: ORG });

    expect(await listInvitations(db, OTHER_ORG)).toHaveLength(1);
    expect((await listInvitations(db, OTHER_ORG))[0]?.id).toBe(elsewhere.invitation.id);
  });
});

describe("one live offer per address", () => {
  test("two concurrent invitations to one mailbox leave one live token, not two", async () => {
    /*
      A double-clicked button, or a retried POST. Both calls find nothing to supersede — the supersede
      and the insert are two statements — and without the constraint both insert. The account then holds
      two live tokens for one person, and withdrawing the one a pane happens to show is a revoke that
      does not revoke: whichever copy the recipient kept still works for the rest of the TTL.

      So the table refuses it. A partial unique index on `(organizationId, email) where status =
      'pending'` means one of the two loses, and the rule stops depending on whoever writes the handler.
    */
    const settled = await Promise.allSettled([
      invite(env.DB, catalog, {
        organizationId: ORG,
        email: "ada@example.com",
        role: "member",
        invitedByUserId: INVITER,
        ttlDays: TTL_DAYS,
        now: NOW,
      }),
      invite(env.DB, catalog, {
        organizationId: ORG,
        email: "ada@example.com",
        role: "member",
        invitedByUserId: INVITER,
        ttlDays: TTL_DAYS,
        now: NOW,
      }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);

    const live = await db
      .selectFrom(INVITATIONS_TABLE)
      .select(["id"])
      .where("organizationId", "=", ORG)
      .where("email", "=", "ada@example.com")
      .where("status", "=", "pending")
      .execute();
    expect(live).toHaveLength(1);
  });

  test("and a second offer after the first is spent is still allowed", async () => {
    // Partial, on `pending`, because spent and withdrawn offers are history. A plain unique index would
    // refuse the second invitation anybody ever sent to an address, which is a legitimate act.
    const first = await offer({ email: "ada@example.com" });
    await withdrawInvitation(db, { organizationId: ORG, invitationId: first.invitation.id, now: NOW });
    const second = await offer({ email: "ada@example.com" });
    expect(second.invitation.id).not.toBe(first.invitation.id);
  });
});

describe("listInvitations", () => {
  test("lists what is outstanding, newest first, and nothing that has been spent", async () => {
    const older = await offer({ email: "ada@example.com", now: new Date(NOW.getTime() - 60_000) });
    const newer = await offer({ email: "grace@example.com" });
    await withdrawInvitation(db, { organizationId: ORG, invitationId: older.invitation.id, now: NOW });

    const outstanding = await listInvitations(db, ORG);
    expect(outstanding.map((row) => row.id)).toEqual([newer.invitation.id]);
  });

  test("keeps an expired offer on the list, because it is the answer to why nobody appeared", async () => {
    const minted = await offer();
    const later = new Date(NOW.getTime() + (TTL_DAYS + 1) * 24 * 60 * 60 * 1000);

    expect((await listInvitations(db, ORG)).map((row) => row.id)).toEqual([minted.invitation.id]);
    // And it is still refused at redemption, with no sweep having run.
    const error = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: minted.token,
        session: { userId: ADA, email: "ada@example.com" },
        now: later,
      }),
    );
    expect(error.payload.code).toBe("organization/invitation_invalid");
  });

  test("does not list another organization's offers", async () => {
    await offer({ organizationId: OTHER_ORG });
    expect(await listInvitations(db, ORG)).toHaveLength(0);
  });
});

describe("withdrawInvitation", () => {
  test("cancels the offer and kills its token", async () => {
    const minted = await offer();
    const withdrawn = await withdrawInvitation(db, {
      organizationId: ORG,
      invitationId: minted.invitation.id,
      now: NOW,
    });
    expect(withdrawn.status).toBe("canceled");

    const error = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: minted.token,
        session: { userId: ADA, email: "ada@example.com" },
        now: NOW,
      }),
    );
    expect(error.payload.code).toBe("organization/invitation_invalid");
    expect(await membershipCount()).toBe(0);
  });

  test("refuses an invitation belonging to another organization", async () => {
    const elsewhere = await offer({ organizationId: OTHER_ORG });
    const error = await refusal(() =>
      withdrawInvitation(db, { organizationId: ORG, invitationId: elsewhere.invitation.id, now: NOW }),
    );
    expect(error.payload.code).toBe("organization/invitation_invalid");

    // Untouched — the row was resolved by both halves of the predicate, so it never matched.
    expect(await listInvitations(db, OTHER_ORG)).toHaveLength(1);
  });

  test("refuses one that has already been withdrawn", async () => {
    const minted = await offer();
    await withdrawInvitation(db, { organizationId: ORG, invitationId: minted.invitation.id, now: NOW });
    const error = await refusal(() =>
      withdrawInvitation(db, { organizationId: ORG, invitationId: minted.invitation.id, now: NOW }),
    );
    expect(error.payload.code).toBe("organization/invitation_invalid");
  });
});

describe("resendInvitation", () => {
  test("mints a new token, kills the old one, and restarts the clock", async () => {
    const minted = await offer();
    const later = new Date(NOW.getTime() + 60_000);
    const resent = await resendInvitation(db, {
      organizationId: ORG,
      invitationId: minted.invitation.id,
      ttlDays: TTL_DAYS,
      now: later,
    });

    expect(resent.token).not.toBe(minted.token);
    expect(resent.invitation.expiresAt.getTime()).toBe(later.getTime() + TTL_DAYS * 24 * 60 * 60 * 1000);

    const dead = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: minted.token,
        session: { userId: ADA, email: "ada@example.com" },
        now: later,
      }),
    );
    expect(dead.payload.code).toBe("organization/invitation_invalid");

    const accepted = await acceptInvitation(d1, catalog, {
      token: resent.token,
      session: { userId: ADA, email: "ada@example.com" },
      now: later,
    });
    expect(accepted.joined).toBe(true);
  });

  test("refuses a withdrawn offer, so a resend cannot undo a revoke", async () => {
    const minted = await offer();
    await withdrawInvitation(db, { organizationId: ORG, invitationId: minted.invitation.id, now: NOW });
    const error = await refusal(() =>
      resendInvitation(db, {
        organizationId: ORG,
        invitationId: minted.invitation.id,
        ttlDays: TTL_DAYS,
        now: NOW,
      }),
    );
    expect(error.payload.code).toBe("organization/invitation_invalid");
  });
});

describe("acceptInvitation", () => {
  test("creates the membership with the role that was offered", async () => {
    const minted = await offer({ role: "admin" });
    const accepted = await acceptInvitation(d1, catalog, {
      token: minted.token,
      session: { userId: ADA, email: "ada@example.com" },
      now: NOW,
    });

    expect(accepted.joined).toBe(true);
    expect(accepted.role).toBe("admin");
    expect(accepted.invitation.status).toBe("accepted");

    const [membership] = await db.selectFrom(MEMBERSHIPS_TABLE).selectAll().execute();
    expect(membership?.userId).toBe(ADA);
    expect(membership?.organizationId).toBe(ORG);
    // The role comes off the offer, never off the request that accepted it.
    expect(membership?.role).toBe("admin");
    expect(await listInvitations(db, ORG)).toHaveLength(0);
  });

  test("is refused for a session whose address differs, even holding a valid token", async () => {
    // The property that makes a forwarded link useless. Holding the token is necessary and is not
    // sufficient, and this is the test that says so.
    const minted = await offer({ email: "ada@example.com" });
    const error = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: minted.token,
        session: { userId: "user-mallory", email: "mallory@example.com" },
        now: NOW,
      }),
    );

    expect(error.payload.code).toBe("organization/invitation_invalid");
    expect(await membershipCount()).toBe(0);
    // And the offer is still standing for the person it was made to.
    expect(await listInvitations(db, ORG)).toHaveLength(1);
  });

  test("matches the invited address in its normal form, so case and padding do not lock somebody out", async () => {
    const minted = await offer({ email: "Ada@Example.com" });
    const accepted = await acceptInvitation(d1, catalog, {
      token: minted.token,
      session: { userId: ADA, email: "  ADA@example.COM  " },
      now: NOW,
    });
    expect(accepted.joined).toBe(true);
  });

  test("is refused once expired, with no sweep having run", async () => {
    const minted = await offer();
    const rows = await d1.prepare("select status from pithy_organization_invitations").all();
    // Still `pending` on the row: expiry is a comparison, not a state something had to write.
    expect((rows.results[0] as { status: string }).status).toBe("pending");

    const error = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: minted.token,
        session: { userId: ADA, email: "ada@example.com" },
        now: new Date(minted.invitation.expiresAt.getTime()),
      }),
    );
    expect(error.payload.code).toBe("organization/invitation_invalid");
    expect(await membershipCount()).toBe(0);
  });

  test("is refused for a token nobody minted", async () => {
    const error = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: mintInvitationToken(),
        session: { userId: ADA, email: "ada@example.com" },
        now: NOW,
      }),
    );
    expect(error.payload.code).toBe("organization/invitation_invalid");
  });

  test("is refused a second time, so one offer is one membership", async () => {
    const minted = await offer();
    await acceptInvitation(d1, catalog, {
      token: minted.token,
      session: { userId: ADA, email: "ada@example.com" },
      now: NOW,
    });
    const error = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: minted.token,
        session: { userId: "user-second", email: "ada@example.com" },
        now: NOW,
      }),
    );
    expect(error.payload.code).toBe("organization/invitation_invalid");
    expect(await membershipCount()).toBe(1);
  });

  test("is refused when the catalog no longer declares the role the offer carries", async () => {
    const minted = await offer({ role: "member" });
    // A build that dropped a role while an offer carrying it was outstanding. Decoded, never asserted:
    // a membership holding a name no matrix has a branch for denies everything today and, one refactor
    // later, allows it.
    const narrowed = defineRoles({
      roles: {
        admin: ["organization:read", "organization:manage", "members:manage", "billing:manage", "organization:delete"],
      },
      administrativePower: "organization:manage",
    });
    const error = await refusal(() =>
      acceptInvitation(d1, narrowed, {
        token: minted.token,
        session: { userId: ADA, email: "ada@example.com" },
        now: NOW,
      }),
    );
    expect(error.payload.code).toBe("organization/invitation_invalid");
    expect(await membershipCount()).toBe(0);
  });

  test("is idempotent for somebody already a member — the offer is spent, not a second row", async () => {
    await db
      .insertInto(MEMBERSHIPS_TABLE)
      .values({
        id: "33333333-3333-4333-8333-333333333333",
        organizationId: ORG,
        userId: ADA,
        role: "admin",
        createdAt: NOW.getTime(),
      })
      .execute();

    const minted = await offer({ role: "member" });
    const accepted = await acceptInvitation(d1, catalog, {
      token: minted.token,
      session: { userId: ADA, email: "ada@example.com" },
      now: NOW,
    });

    expect(accepted.joined).toBe(false);
    expect(accepted.membershipId).toBe("33333333-3333-4333-8333-333333333333");
    expect(await membershipCount()).toBe(1);
    // The standing role is not downgraded by an offer of a weaker one.
    const [membership] = await db.selectFrom(MEMBERSHIPS_TABLE).selectAll().execute();
    expect(membership?.role).toBe("admin");
    // And the offer is consumed, so no live token points at an account this person is already in.
    expect(await listInvitations(db, ORG)).toHaveLength(0);
  });

  test("gives exactly one membership for N concurrent redemptions of one link", async () => {
    const minted = await offer();
    const attempts = 8;

    const settled = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        acceptInvitation(d1, catalog, {
          token: minted.token,
          session: { userId: ADA, email: "ada@example.com" },
          now: NOW,
        }),
      ),
    );

    expect(await membershipCount()).toBe(1);

    const joined = settled.filter((one) => one.status === "fulfilled" && one.value.joined);
    expect(joined).toHaveLength(1);

    // Nobody who lost the race was told anything but "that invitation can no longer be accepted".
    for (const one of settled) {
      if (one.status === "rejected") {
        expect((one.reason as PithyError).payload.code).toBe("organization/invitation_invalid");
      }
    }
  });

  test("is still one membership when the racers are different sessions", async () => {
    // **This is the test that plants against the conditional update rather than against the index.**
    // The unique index on `(organizationId, userId)` cannot refuse these: every racer would insert a
    // different row. What refuses them is the `status = 'pending'` condition carried by *both*
    // statements of the batch — take it off and this is six memberships from one offer, while the
    // same-user test above stays green because the index quietly covers for it.
    const minted = await offer();
    const racers = 6;

    const settled = await Promise.allSettled(
      Array.from({ length: racers }, (_, at) =>
        acceptInvitation(d1, catalog, {
          token: minted.token,
          session: { userId: `user-racer-${at}`, email: "ada@example.com" },
          now: NOW,
        }),
      ),
    );

    expect(await membershipCount()).toBe(1);
    expect(settled.filter((one) => one.status === "fulfilled")).toHaveLength(1);
  });
});

describe("an offer of a role the project has since reserved", () => {
  /*
    **The escalation this closes, in the order it actually happens.**

    A project ships `owner` as an ordinary role and somebody is invited to it — legally, because
    `invite()` checked the assignable set at that moment. Days later the project adds the two-party
    ownership transfer, which is what `unassignable` is *for* and what `ownership.ts` tells adopters to
    do. The pending link is still live.

    Redeemed, it would mint an owner nobody nominated and nobody accepted — through a door
    `changeRole` refuses to every caller holding every power, and into a role `members.ts` then shields
    from demotion and removal. Nothing about the row looks wrong; the catalog moved underneath it.

    So the assignable set is re-asked at acceptance rather than trusted from the moment of the offer.
  */

  /** The catalog after the change: `owner` is now reserved for the transfer. */
  const reserved = defineRoles({
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

  /** A pending offer of `owner`, written the way the older catalog would have written it. */
  async function reservedOffer(): Promise<string> {
    const token = "a-token-minted-before-the-catalog-moved";
    await db
      .insertInto(INVITATIONS_TABLE)
      .values(
        Invitation.encode({
          id: crypto.randomUUID(),
          organizationId: ORG,
          email: "ada@example.com",
          role: "owner",
          invitedByUserId: INVITER,
          tokenDigest: await invitationDigest(token),
          status: "pending",
          expiresAt: new Date(NOW.getTime() + TTL_DAYS * 86_400_000),
          acceptedAt: null,
          createdAt: NOW,
        }),
      )
      .execute();
    return token;
  }

  test("is dead, and no membership is written", async () => {
    const token = await reservedOffer();
    const error = await refusal(() =>
      acceptInvitation(d1, reserved, {
        token,
        session: { userId: ADA, email: "ada@example.com" },
        now: NOW,
      }),
    );
    expect(error.payload.code).toBe("organization/invitation_invalid");
    expect(await membershipCount()).toBe(0);
  });

  test("and the refusal is the one every other dead offer gets", async () => {
    // A holder must not be able to tell "withdrawn" from "the project reserved that role", which would
    // say something about the catalog to somebody holding nothing but a link.
    const token = await reservedOffer();
    const reserved_ = await refusal(() =>
      acceptInvitation(d1, reserved, { token, session: { userId: ADA, email: "ada@example.com" }, now: NOW }),
    );
    const unknown = await refusal(() =>
      acceptInvitation(d1, reserved, {
        token: "no-such-token",
        session: { userId: ADA, email: "ada@example.com" },
        now: NOW,
      }),
    );
    const { detail: _a, ...reservedClient } = reserved_.payload;
    const { detail: _b, ...unknownClient } = unknown.payload;
    expect(reservedClient).toEqual(unknownClient);
    // And the operator can still tell them apart.
    expect(reserved_.payload.detail).toContain("no longer assigns");
  });

  test("an ordinary offer is unaffected", async () => {
    // The narrowing must not close the door on every invitation ever sent.
    const { token } = await offer({ role: "admin" });
    const accepted = await acceptInvitation(d1, reserved, {
      token,
      session: { userId: ADA, email: "ada@example.com" },
      now: NOW,
    });
    expect(accepted.role).toBe("admin");
    expect(accepted.joined).toBe(true);
  });
});

describe("the refusals are one refusal", () => {
  test("no such token, wrong address, expired, withdrawn and spent all read identically to a client", async () => {
    const unknown = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: mintInvitationToken(),
        session: { userId: ADA, email: "ada@example.com" },
        now: NOW,
      }),
    );

    const bound = await offer();
    const wrongAddress = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: bound.token,
        session: { userId: "user-mallory", email: "mallory@example.com" },
        now: NOW,
      }),
    );

    const expired = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: bound.token,
        session: { userId: ADA, email: "ada@example.com" },
        now: new Date(bound.invitation.expiresAt.getTime() + 1),
      }),
    );

    const withdrawnOffer = await offer({ email: "grace@example.com" });
    await withdrawInvitation(db, {
      organizationId: ORG,
      invitationId: withdrawnOffer.invitation.id,
      now: NOW,
    });
    const withdrawn = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: withdrawnOffer.token,
        session: { userId: "user-grace", email: "grace@example.com" },
        now: NOW,
      }),
    );

    const spentOffer = await offer({ email: "hopper@example.com" });
    await acceptInvitation(d1, catalog, {
      token: spentOffer.token,
      session: { userId: "user-hopper", email: "hopper@example.com" },
      now: NOW,
    });
    const spent = await refusal(() =>
      acceptInvitation(d1, catalog, {
        token: spentOffer.token,
        session: { userId: "user-hopper", email: "hopper@example.com" },
        now: NOW,
      }),
    );

    const refusals = [unknown, wrongAddress, expired, withdrawn, spent];

    // Byte-identical on everything a client is handed. A caller who could tell "no such token" from
    // "wrong address" could tell whether a link they were forwarded was minted for them.
    const client = refusals.map((error) => ({
      code: error.payload.code,
      status: error.payload.status,
      message: error.payload.message,
      action: error.payload.action,
    }));
    for (const one of client) expect(one).toEqual(client[0]);

    // And the distinction survives where an operator can read it.
    const details = refusals.map((error) => error.payload.detail);
    expect(new Set(details).size).toBe(refusals.length);
    for (const detail of details) expect(detail).toBeTruthy();
  });
});

describe("two invitations to one mailbox at once", () => {
  test("**leave one live offer, not two** — the supersede and the mint are one transaction", async () => {
    // The double-clicked Send, and the retried POST. These were two awaits: both calls found nothing to
    // supersede, both inserted, and the account held two live tokens for one person. Withdrawing the one
    // a pane happened to show was then a revoke that did not revoke.
    const both = await Promise.allSettled([offer({ email: "ada@example.com" }), offer({ email: "ada@example.com" })]);

    // One may lose to the index underneath — that is the backstop working, not a second defect — but at
    // least one has to have written an offer, or this asserts nothing about a table nobody wrote to.
    expect(both.some((settled) => settled.status === "fulfilled")).toBe(true);

    const live = await db
      .selectFrom(INVITATIONS_TABLE)
      .select(["id", "tokenDigest"])
      .where("organizationId", "=", ORG)
      .where("email", "=", "ada@example.com")
      .where("status", "=", "pending")
      .execute();
    expect(live).toHaveLength(1);

    /*
      And the offer that is live is one somebody was handed a token for.

      **Which of the two wins is not asserted, because it is not knowable and not the invariant.** Both
      calls can succeed — the later batch supersedes the earlier one's row, which is the ordinary
      behavior arriving out of order rather than a defect. What must be true is that the surviving row
      is one of the two that were minted: a live offer nobody holds a token for would be an invitation
      that can never be accepted and never be withdrawn from the pane that lists it.
    */
    const minted = both.flatMap((settled) => (settled.status === "fulfilled" ? [settled.value.invitation.id] : []));
    expect(minted).toContain(live[0]?.id);
  });

  test("**the supersede and the mint reach D1 as one batch** — which is what makes them one act", async () => {
    /*
      **The assertion that actually bites, and the first one here did not.**

      "One live offer" was already true before this change: the partial unique index refuses the second
      insert, so the old two-statement shape produced one row too. Planting the old shape back left the
      count assertion green, which is a test that describes the outcome without testing the change.

      What batching fixes is the *failure*: without it, the loser of the race gets a raw constraint
      violation — a 500 on a double-clicked Send — instead of a supersede. With it, two batches serialize,
      the later cancels the earlier's row, and both callers get the offer they asked for.

      That race is not deterministic at this level, so it is not what is asserted. The structural fact
      under it is: the two statements leave here together or not at all. A spy on the binding is how that
      is observed, and it fails the moment somebody splits them again.
    */
    const batches: number[] = [];
    const watched = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "batch") {
          return (statements: unknown[]) => {
            batches.push(statements.length);
            return (target as D1Database).batch(statements as never);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as D1Database;

    await invite(watched, catalog, {
      organizationId: ORG,
      email: "ada@example.com",
      role: "member",
      invitedByUserId: INVITER,
      ttlDays: TTL_DAYS,
      now: NOW,
    });

    expect(batches).toEqual([2]);
  });

  test("a second invitation after the first has settled still supersedes it", async () => {
    // Sequential, which is the ordinary path — the transaction must not have made superseding conditional
    // on losing a race.
    const first = await offer({ email: "ada@example.com" });
    const second = await offer({ email: "ada@example.com" });

    const rows = await db
      .selectFrom(INVITATIONS_TABLE)
      .select(["id", "status"])
      .where("organizationId", "=", ORG)
      .where("email", "=", "ada@example.com")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.invitation.id)?.status).toBe("canceled");
    expect(rows.find((row) => row.id === second.invitation.id)?.status).toBe("pending");
  });
});
