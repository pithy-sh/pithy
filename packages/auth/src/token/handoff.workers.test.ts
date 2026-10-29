// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { HANDOFF_SWEEP_LIMIT, HANDOFF_TTL_SECONDS, handoffChallengeOf, issueHandoff, redeemHandoff } from "./handoff";

const TABLES = [
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
];

const NOW = new Date("2026-10-01T12:00:00.000Z");

/** RFC 7636 appendix B: a verifier and the S256 challenge it hashes to. */
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const OTHER_VERIFIER = "the-wrong-verifier-the-wrong-verifier-000000";

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
});

describe("issueHandoff", () => {
  test("answers a long random code and stores only its digest, never the code or a session token", async () => {
    const db = authDatabase(env.DB);
    const issued = await issueHandoff(db, { sessionId: "sess-1", challenge: CHALLENGE, now: NOW });
    expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt.getTime() - NOW.getTime()).toBe(HANDOFF_TTL_SECONDS * 1000);

    const rows = await env.DB.prepare("select identifier, value from pithy_auth_verifications").all<{
      identifier: string;
      value: string;
    }>();
    expect(rows.results).toHaveLength(1);
    const [row] = rows.results;
    expect(row?.identifier).not.toContain(issued.code);
    expect(row?.identifier).toMatch(/^pithy-handoff:[0-9a-f]{64}$/);
    expect(row?.value).not.toContain(VERIFIER);
    expect(JSON.parse(row?.value ?? "{}")).toEqual({ sessionId: "sess-1", challenge: CHALLENGE });
  });

  test("a challenge that is not an S256 digest is refused, so no code is ever unbound", async () => {
    const db = authDatabase(env.DB);
    for (const challenge of ["", "short", `${CHALLENGE}=`, CHALLENGE.replace("-", "+")]) {
      await expect(issueHandoff(db, { sessionId: "sess-1", challenge, now: NOW })).rejects.toThrow();
    }
    const left = await env.DB.prepare("select count(*) as n from pithy_auth_verifications").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  test("issuing sweeps lapsed codes, a bounded batch at a time, and leaves live codes and other flows alone", async () => {
    const db = authDatabase(env.DB);
    const lapsed = new Date(NOW.getTime() - HANDOFF_TTL_SECONDS * 1000 - 1);
    for (let i = 0; i < HANDOFF_SWEEP_LIMIT + 5; i++) {
      await issueHandoff(db, { sessionId: `old-${i}`, challenge: CHALLENGE, now: lapsed });
    }
    const live = await issueHandoff(db, { sessionId: "live", challenge: CHALLENGE, now: NOW });
    await env.DB.prepare(
      "insert into pithy_auth_verifications (id, identifier, value, expires_at, created_at, updated_at) values ('v1', 'sign-in-otp-u@test.com', 'x', '2000-01-01T00:00:00.000Z', 'x', 'x')",
    ).run();

    const count = async (where: string) =>
      (await env.DB.prepare(`select count(*) as n from pithy_auth_verifications where ${where}`).first<{ n: number }>())
        ?.n;
    // The live code's issue swept one batch; the rest go on the next issue.
    expect(await count("identifier like 'pithy-handoff:%'")).toBe(6);
    await issueHandoff(db, { sessionId: "later", challenge: CHALLENGE, now: NOW });
    expect(await count("identifier like 'pithy-handoff:%'")).toBe(2);
    expect(await count("identifier = 'sign-in-otp-u@test.com'")).toBe(1);
    expect(await redeemHandoff(db, { code: live.code, verifier: VERIFIER }, NOW)).toEqual({
      ok: true,
      sessionId: "live",
    });
  });

  test("two codes for one session are two different codes", async () => {
    const db = authDatabase(env.DB);
    const first = await issueHandoff(db, { sessionId: "sess-1", challenge: CHALLENGE, now: NOW });
    const second = await issueHandoff(db, { sessionId: "sess-1", challenge: CHALLENGE, now: NOW });
    expect(first.code).not.toBe(second.code);
  });

  test("the window is a minute at most", () => {
    expect(HANDOFF_TTL_SECONDS).toBeLessThanOrEqual(60);
  });
});

describe("redeemHandoff", () => {
  test("a fresh code answers the session it was issued for, once", async () => {
    const db = authDatabase(env.DB);
    const { code } = await issueHandoff(db, { sessionId: "sess-1", challenge: CHALLENGE, now: NOW });
    expect(await redeemHandoff(db, { code, verifier: VERIFIER }, NOW)).toEqual({ ok: true, sessionId: "sess-1" });
    expect(await redeemHandoff(db, { code, verifier: VERIFIER }, NOW)).toEqual({ ok: false, reason: "unknown" });
  });

  test("a code past its window is refused as expired, and is spent by the attempt", async () => {
    const db = authDatabase(env.DB);
    const { code } = await issueHandoff(db, { sessionId: "sess-1", challenge: CHALLENGE, now: NOW });
    const late = new Date(NOW.getTime() + HANDOFF_TTL_SECONDS * 1000 + 1);
    expect(await redeemHandoff(db, { code, verifier: VERIFIER }, late)).toEqual({ ok: false, reason: "expired" });
    expect(await redeemHandoff(db, { code, verifier: VERIFIER }, NOW)).toEqual({ ok: false, reason: "unknown" });
  });

  test("the right verifier redeems; a wrong one is refused and spends the code all the same", async () => {
    const db = authDatabase(env.DB);
    const { code } = await issueHandoff(db, { sessionId: "sess-1", challenge: CHALLENGE, now: NOW });
    expect(await redeemHandoff(db, { code, verifier: OTHER_VERIFIER }, NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(await redeemHandoff(db, { code, verifier: VERIFIER }, NOW)).toEqual({ ok: false, reason: "unknown" });
  });

  test("a verifier outside RFC 7636's shape is refused as malformed, and spends the code all the same", async () => {
    const db = authDatabase(env.DB);
    const malformed = [
      "",
      "a".repeat(42),
      "a".repeat(129),
      `${VERIFIER.slice(0, -1)}+`,
      `${VERIFIER.slice(0, -1)}=`,
      `${VERIFIER.slice(0, -1)} `,
      `${VERIFIER.slice(0, -1)}é`,
    ];
    for (const verifier of malformed) {
      const { code } = await issueHandoff(db, { sessionId: "sess-1", challenge: CHALLENGE, now: NOW });
      expect(await redeemHandoff(db, { code, verifier }, NOW)).toEqual({ ok: false, reason: "malformed" });
      expect(await redeemHandoff(db, { code, verifier: VERIFIER }, NOW)).toEqual({ ok: false, reason: "unknown" });
    }
  });

  test("every verifier RFC 7636 allows redeems, at both ends of its length and with every unreserved mark", async () => {
    const db = authDatabase(env.DB);
    const verifiers = ["A".repeat(43), `${"0123456789-._~".repeat(9)}ab`, `z${"9".repeat(127)}`];
    for (const verifier of verifiers) {
      const challenge = await handoffChallengeOf(verifier);
      const { code } = await issueHandoff(db, { sessionId: "sess-1", challenge, now: NOW });
      expect(await redeemHandoff(db, { code, verifier }, NOW)).toEqual({ ok: true, sessionId: "sess-1" });
    }
  });

  test("a code nobody issued is refused", async () => {
    const db = authDatabase(env.DB);
    expect(await redeemHandoff(db, { code: "not-a-code-anyone-issued", verifier: VERIFIER }, NOW)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  test("of concurrent redemptions of one code, exactly one wins", async () => {
    const db = authDatabase(env.DB);
    const { code } = await issueHandoff(db, { sessionId: "sess-1", challenge: CHALLENGE, now: NOW });
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => redeemHandoff(db, { code, verifier: VERIFIER }, NOW)),
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  });

  test("a row another flow wrote under the same table is never redeemed as a code", async () => {
    const db = authDatabase(env.DB);
    await env.DB.prepare(
      "insert into pithy_auth_verifications (id, identifier, value, expires_at, created_at, updated_at) values ('v1', 'sign-in-otp-u@test.com', 'sess-x', '2099-01-01T00:00:00.000Z', 'x', 'x')",
    ).run();
    expect(await redeemHandoff(db, { code: "sign-in-otp-u@test.com", verifier: VERIFIER }, NOW)).toEqual({
      ok: false,
      reason: "unknown",
    });
    const left = await env.DB.prepare("select count(*) as n from pithy_auth_verifications").first<{ n: number }>();
    expect(left?.n).toBe(1);
  });
});

describe("handoffChallengeOf", () => {
  test("is the RFC 7636 S256 transform", async () => {
    expect(await handoffChallengeOf(VERIFIER)).toBe(CHALLENGE);
  });
});
