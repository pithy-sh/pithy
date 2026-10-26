// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { encodeCursor } from "@pithy-sh/core/src/data/cursor";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { type AuthDatabase, authDatabase } from "../data/tables";
import { VerificationOutcome, type VerificationType } from "../data/verificationOutcome";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { listVerificationOutcomes, verificationCounts } from "./read";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const MINUTE = 60_000;
const WINDOW = { since: new Date(NOW.getTime() - 60 * MINUTE), until: NOW };

function db(): AuthDatabase {
  return authDatabase(env.DB);
}

/** One ledger row, issued `ago` minutes before NOW, living five minutes, used `usedAgo` minutes before NOW. */
async function seed(
  verificationId: string,
  type: VerificationType,
  ago: number,
  usedAgo: number | null = null,
): Promise<void> {
  const issuedAt = new Date(NOW.getTime() - ago * MINUTE);
  const { id: _id, ...record } = VerificationOutcome.encode({
    id: 0,
    verificationId,
    type,
    userId: null,
    emailJobId: `job-${verificationId}`,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 5 * MINUTE),
    usedAt: usedAgo === null ? null : new Date(NOW.getTime() - usedAgo * MINUTE),
  });
  await db().insertInto("pithyAuthVerificationOutcomes").values(record).execute();
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

describe("verificationCounts", () => {
  test("counts by type and state over the window, and the states add up", async () => {
    await seed("link-used", "magic_link", 30, 29);
    await seed("link-expired", "magic_link", 20);
    await seed("link-pending", "magic_link", 2);
    await seed("code-used", "otp", 10, 9);
    await seed("code-used-2", "otp", 8, 7);
    await seed("code-expired", "otp", 50);
    expect(await verificationCounts(db(), WINDOW, NOW)).toEqual([
      { type: "magic_link", issued: 3, used: 1, expired: 1, pending: 1 },
      { type: "otp", issued: 3, used: 2, expired: 1, pending: 0 },
    ]);
  });

  test("every type is answered, with zeros where nothing was issued", async () => {
    expect(await verificationCounts(db(), WINDOW, NOW)).toEqual([
      { type: "magic_link", issued: 0, used: 0, expired: 0, pending: 0 },
      { type: "otp", issued: 0, used: 0, expired: 0, pending: 0 },
    ]);
  });

  test("the window is on issue time, start inclusive and end exclusive", async () => {
    await seed("at-start", "otp", 60);
    await seed("before-start", "otp", 61);
    await seed("at-end", "otp", 0);
    const [, otp] = await verificationCounts(db(), WINDOW, NOW);
    expect(otp?.issued).toBe(1);
  });

  test("an unused row turns expired the moment its expiry passes, with nothing written", async () => {
    await seed("pending", "otp", 2);
    const later = new Date(NOW.getTime() + 10 * MINUTE);
    expect((await verificationCounts(db(), WINDOW, NOW))[1]).toMatchObject({ pending: 1, expired: 0 });
    expect((await verificationCounts(db(), WINDOW, later))[1]).toMatchObject({ pending: 0, expired: 1 });
  });
});

describe("listVerificationOutcomes", () => {
  test("lists the window newest first", async () => {
    await seed("a", "otp", 30);
    await seed("b", "magic_link", 10);
    await seed("c", "otp", 20);
    await seed("outside", "otp", 90);
    const page = await listVerificationOutcomes(db(), { window: WINDOW, now: NOW });
    expect(page.items.map((row) => row.verificationId)).toEqual(["b", "c", "a"]);
    expect(page.nextCursor).toBeNull();
  });

  test("pages by keyset, and two rows issued in one millisecond are neither skipped nor repeated", async () => {
    for (const id of ["t1", "t2", "t3"]) await seed(id, "otp", 5);
    await seed("older", "otp", 6);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listVerificationOutcomes(db(), { window: WINDOW, now: NOW, limit: 1, cursor });
      seen.push(...page.items.map((row) => row.verificationId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["t3", "t2", "t1", "older"]);
  });

  test("filters by type and by state, judged at the same now as the counts", async () => {
    await seed("link-used", "magic_link", 30, 29);
    await seed("link-expired", "magic_link", 20);
    await seed("code-pending", "otp", 2);
    const ids = async (filter: { type?: VerificationType; state?: "used" | "expired" | "pending" }) =>
      (await listVerificationOutcomes(db(), { window: WINDOW, now: NOW, ...filter })).items.map(
        (row) => row.verificationId,
      );
    expect(await ids({ type: "magic_link" })).toEqual(["link-expired", "link-used"]);
    expect(await ids({ state: "used" })).toEqual(["link-used"]);
    expect(await ids({ state: "expired" })).toEqual(["link-expired"]);
    expect(await ids({ state: "pending" })).toEqual(["code-pending"]);
    expect(await ids({ type: "otp", state: "expired" })).toEqual([]);
  });

  test("a malformed cursor, or one from another listing, is a first page", async () => {
    await seed("a", "otp", 5);
    for (const cursor of ["!!not-a-cursor", encodeCursor({ sort: "2026-01-01", id: "u-1" })]) {
      const page = await listVerificationOutcomes(db(), { window: WINDOW, now: NOW, cursor });
      expect(page.items.map((row) => row.verificationId)).toEqual(["a"]);
    }
  });
});
