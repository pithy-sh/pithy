// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { User } from "../data/betterAuth";
import { type AuthDatabase, authDatabase } from "../data/tables";
import { VerificationOutcome } from "../data/verificationOutcome";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { verificationLedger } from "./record";

/**
 * The ledger's writers against real D1, driven the way Better Auth drives them: each moment handed the row it
 * would see and the request it would see it in. The flows end to end, through a real instance, are in
 * `../instance/verificationLedger.workers.test.ts`.
 */

const NOW = new Date("2026-10-26T12:00:00.000Z");
const IN_FIVE = new Date(NOW.getTime() + 300_000);

function db(): AuthDatabase {
  return authDatabase(env.DB);
}

async function rows(): Promise<VerificationOutcome[]> {
  const found = await db().selectFrom("pithyAuthVerificationOutcomes").selectAll().orderBy("id").execute();
  return found.map((row) => VerificationOutcome.parse(row));
}

async function seedUser(id: string, email: string): Promise<void> {
  await db()
    .insertInto("pithyAuthUsers")
    .values(
      User.encode({
        id,
        name: "" as User["name"],
        email: email as User["email"],
        emailVerified: true,
        image: null,
        locale: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    .execute();
}

beforeEach(async () => {
  for (const table of [
    "pithy_auth_accounts",
    "pithy_auth_devices",
    "pithy_auth_jwks",
    "pithy_auth_rate_limit",
    "pithy_auth_rotated_tokens",
    "pithy_auth_user_lifecycle",
    "pithy_auth_verification_outcomes",
    "pithy_auth_sessions",
    "pithy_auth_users",
    "pithy_auth_verifications",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const untyped = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  for (const migration of Object.values(AUTH_MIGRATIONS)) await migration.up(untyped);
});

describe("issuing", () => {
  test("a sent link is recorded against the row created before it, with its job and its account", async () => {
    await seedUser("u-1", "ada@example.test");
    const ledger = verificationLedger(db(), () => NOW);
    const request = {};
    await ledger.created({ id: "v-1", createdAt: NOW, expiresAt: IN_FIVE }, request);
    await ledger.issued(request, { type: "magic_link", email: "ada@example.test", emailJobId: "job-1" });
    expect(await rows()).toEqual([
      {
        id: expect.any(Number),
        verificationId: "v-1",
        type: "magic_link",
        userId: "u-1",
        emailJobId: "job-1",
        issuedAt: NOW,
        expiresAt: IN_FIVE,
        usedAt: null,
      },
    ]);
  });

  test("a link asked for in another case still names the account, which Better Auth stores lowercased", async () => {
    // `/sign-in/magic-link` hands the address on exactly as typed; the account was written lowercased.
    await seedUser("u-1", "ada@example.test");
    const ledger = verificationLedger(db(), () => NOW);
    const request = {};
    await ledger.created({ id: "v-1", createdAt: NOW, expiresAt: IN_FIVE }, request);
    await ledger.issued(request, { type: "magic_link", email: "Ada@Example.TEST", emailJobId: "job-1" });
    expect((await rows())[0]).toMatchObject({ verificationId: "v-1", userId: "u-1", emailJobId: "job-1" });
  });

  test("a sign-up's code has no account yet, and is recorded with its job alone", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    const request = {};
    await ledger.created({ id: "v-1", createdAt: NOW, expiresAt: IN_FIVE }, request);
    await ledger.issued(request, { type: "otp", email: "new@example.test", emailJobId: "job-1" });
    expect((await rows())[0]).toMatchObject({ type: "otp", userId: null, emailJobId: "job-1" });
  });

  test("a send the seam could not queue is recorded with no job, because the link was still issued", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    const request = {};
    await ledger.created({ id: "v-1", createdAt: NOW, expiresAt: IN_FIVE }, request);
    await ledger.issued(request, { type: "magic_link", email: "x@example.test", emailJobId: null });
    expect((await rows())[0]).toMatchObject({ verificationId: "v-1", emailJobId: null });
  });

  test("a row created and never sent is never recorded — OAuth state is that", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    await ledger.created({ id: "state-1", createdAt: NOW, expiresAt: IN_FIVE }, {});
    expect(await rows()).toEqual([]);
  });

  test("a send in another request pairs with nothing", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    await ledger.created({ id: "v-1", createdAt: NOW, expiresAt: IN_FIVE }, {});
    await ledger.issued({}, { type: "otp", email: "x@example.test", emailJobId: "job-1" });
    expect(await rows()).toEqual([]);
  });

  test("one created row is recorded once, however many sends follow it", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    const request = {};
    await ledger.created({ id: "v-1", createdAt: NOW, expiresAt: IN_FIVE }, request);
    await ledger.issued(request, { type: "otp", email: "x@example.test", emailJobId: "job-1" });
    await ledger.issued(request, { type: "otp", email: "x@example.test", emailJobId: "job-2" });
    expect(await rows()).toHaveLength(1);
  });

  test("a row with no creation date is issued now", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    const request = {};
    await ledger.created({ id: "v-1", expiresAt: IN_FIVE }, request);
    await ledger.issued(request, { type: "otp", email: "x@example.test", emailJobId: "job-1" });
    expect((await rows())[0]?.issuedAt).toEqual(NOW);
  });
});

/** One issued link, recorded in its own request, the way a send endpoint leaves it. */
async function issue(ledger: ReturnType<typeof verificationLedger>, id = "v-1"): Promise<void> {
  const request = {};
  await ledger.created({ id, createdAt: NOW, expiresAt: IN_FIVE }, request);
  await ledger.issued(request, { type: "magic_link", email: "x@example.test", emailJobId: `job-${id}` });
}

describe("using", () => {
  test("a consume followed by a session stamps the row used, and names the account a sign-up created", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    await issue(ledger);
    const request = {};
    ledger.consuming({ id: "v-1", expiresAt: IN_FIVE }, request);
    await ledger.signedIn(request, "u-new");
    expect((await rows())[0]).toMatchObject({ usedAt: NOW, userId: "u-new" });
  });

  test("an account named at issue is kept, never overwritten by the session's", async () => {
    await seedUser("u-1", "x@example.test");
    const ledger = verificationLedger(db(), () => NOW);
    await issue(ledger);
    const request = {};
    ledger.consuming({ id: "v-1", expiresAt: IN_FIVE }, request);
    await ledger.signedIn(request, "u-other");
    expect((await rows())[0]).toMatchObject({ userId: "u-1", usedAt: NOW });
  });

  test("a consume with no session after it — a lost race, a refusal — stamps nothing", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    await issue(ledger);
    ledger.consuming({ id: "v-1", expiresAt: IN_FIVE }, {});
    expect((await rows())[0]?.usedAt).toBeNull();
  });

  test("a session with no consume before it — a token refresh — stamps nothing", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    await issue(ledger);
    await ledger.signedIn({}, "u-1");
    expect((await rows())[0]?.usedAt).toBeNull();
  });

  test("an expired row being swept is not a use, even with a session after it", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    await issue(ledger);
    const request = {};
    ledger.consuming({ id: "v-1", expiresAt: NOW }, request);
    await ledger.signedIn(request, "u-1");
    expect((await rows())[0]?.usedAt).toBeNull();
  });

  test("a consumed row that is not in the ledger matches nothing — an OAuth callback's state", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    await issue(ledger);
    const request = {};
    ledger.consuming({ id: "state-1", expiresAt: IN_FIVE }, request);
    await ledger.signedIn(request, "u-1");
    expect((await rows())[0]?.usedAt).toBeNull();
  });

  test("a row used once is not stamped again", async () => {
    let clock = NOW;
    const ledger = verificationLedger(db(), () => clock);
    await issue(ledger);
    const first = {};
    ledger.consuming({ id: "v-1", expiresAt: IN_FIVE }, first);
    await ledger.signedIn(first, "u-1");
    clock = new Date(NOW.getTime() + 1_000);
    const second = {};
    ledger.consuming({ id: "v-1", expiresAt: IN_FIVE }, second);
    await ledger.signedIn(second, "u-2");
    expect((await rows())[0]).toMatchObject({ usedAt: NOW, userId: "u-1" });
  });

  test("a wrong code moves the row onto its re-issue, and the right one then stamps it", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    await issue(ledger);
    // The wrong attempt: consumed to be checked, re-created with the same expiry, refused.
    const wrong = {};
    ledger.consuming({ id: "v-1", expiresAt: IN_FIVE }, wrong);
    await ledger.created({ id: "v-2", createdAt: NOW, expiresAt: IN_FIVE }, wrong);
    expect((await rows())[0]?.verificationId).toBe("v-2");
    // The right one, in the next request.
    const right = {};
    ledger.consuming({ id: "v-2", expiresAt: IN_FIVE }, right);
    await ledger.signedIn(right, "u-1");
    expect(await rows()).toEqual([expect.objectContaining({ verificationId: "v-2", usedAt: NOW, userId: "u-1" })]);
  });

  test("a row created after a consume with a different expiry is a new row, not a re-issue", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    await issue(ledger);
    const request = {};
    ledger.consuming({ id: "v-1", expiresAt: IN_FIVE }, request);
    await ledger.created({ id: "v-9", createdAt: NOW, expiresAt: new Date(IN_FIVE.getTime() + 1) }, request);
    expect((await rows())[0]?.verificationId).toBe("v-1");
  });
});

describe("never fatal", () => {
  test("a write that fails is swallowed: the ledger is never the reason a sign-in fails", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    await env.DB.exec("DROP TABLE pithy_auth_verification_outcomes");
    const request = {};
    await expect(ledger.created({ id: "v-1", createdAt: NOW, expiresAt: IN_FIVE }, request)).resolves.toBeUndefined();
    await expect(
      ledger.issued(request, { type: "otp", email: "x@example.test", emailJobId: "job-1" }),
    ).resolves.toBeUndefined();
    ledger.consuming({ id: "v-1", expiresAt: IN_FIVE }, request);
    await expect(ledger.signedIn(request, "u-1")).resolves.toBeUndefined();
  });

  test("a request that is not an object, or a row that is not a row, is ignored", async () => {
    const ledger = verificationLedger(db(), () => NOW);
    await ledger.created({ id: "v-1", expiresAt: IN_FIVE }, undefined);
    await ledger.created("nonsense", {});
    ledger.consuming(null, {});
    await ledger.signedIn({}, 42);
    expect(await rows()).toEqual([]);
  });
});
