// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { beforeEach, describe, expect, test } from "vitest";
import type { AuthEmailDelivery } from "../audit/evidence";
import { authDatabase } from "../data/tables";
import { VerificationOutcome } from "../data/verificationOutcome";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { type AuthEmailMessage, type AuthInstanceDeps, makeAuth } from "./auth";
import { NO_SOCIAL_PROVIDERS } from "./providers";

/**
 * The verification ledger (#829) through a real instance: every sign-in link and code auth issues writes a row,
 * and its use stamps it — per type, with the mail that carried it, and never the token or the address.
 */

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

/** An instance whose email seam answers with a numbered job per message — or with whatever `answer` says. */
function instance(answer?: (message: AuthEmailMessage, jobId: string) => AuthEmailDelivery) {
  const mailbox: AuthEmailMessage[] = [];
  const deps: AuthInstanceDeps = {
    db: authDatabase(env.DB),
    secret: "test-secret-please-rotate-0000000000",
    baseURL: "http://localhost:8787",
    basePath: "/api/auth",
    trustedOrigins: ["http://localhost:8787"],
    ...NO_SOCIAL_PROVIDERS,
    sendEmail: async (message) => {
      mailbox.push(message);
      const jobId = `job-${mailbox.length}`;
      return answer ? answer(message, jobId) : { delivery: "queued", jobId };
    },
    sessionExpiresIn: 60 * 60 * 24 * 7,
    sessionUpdateAge: 60 * 60 * 24,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    providerSignUp: { google: true, apple: true, facebook: true, github: true, microsoft: true },
    emit: async () => {},
    plugins: [],
  };
  return { auth: makeAuth(deps), mailbox };
}

async function ledger(): Promise<VerificationOutcome[]> {
  const rows = await authDatabase(env.DB)
    .selectFrom("pithyAuthVerificationOutcomes")
    .selectAll()
    .orderBy("id")
    .execute();
  return rows.map((row) => VerificationOutcome.parse(row));
}

async function userIdOf(email: string): Promise<string> {
  const row = await env.DB.prepare("select id from pithy_auth_users where email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!row) throw new Error(`no user for ${email}`);
  return row.id;
}

async function liveVerificationIds(): Promise<string[]> {
  const rows = await env.DB.prepare("select id from pithy_auth_verifications").all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

function lastOtp(mailbox: AuthEmailMessage[]): string {
  const message = mailbox.at(-1);
  if (message?.template !== "otp") throw new Error("no OTP sent");
  return message.code;
}

function lastLinkToken(mailbox: AuthEmailMessage[]): string {
  const message = mailbox.at(-1);
  if (message?.template !== "magicLink") throw new Error("no magic link sent");
  return message.token;
}

describe("a sign-in code", () => {
  test("is recorded when sent, against its live verification row and its mail", async () => {
    const { auth } = instance();
    const before = Date.now();
    await auth.api.sendVerificationOTP({
      body: { email: "ada@example.test", type: "sign-in" },
      headers: new Headers(),
    });
    const [row] = await ledger();
    expect(row).toMatchObject({ type: "otp", emailJobId: "job-1", userId: null, usedAt: null });
    expect(await liveVerificationIds()).toEqual([row?.verificationId]);
    expect(row?.issuedAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(row?.issuedAt.getTime() ?? 0);
  });

  test("is stamped used when it signs somebody in, and a sign-up gains the account it created", async () => {
    const { auth, mailbox } = instance();
    await auth.api.sendVerificationOTP({
      body: { email: "ada@example.test", type: "sign-in" },
      headers: new Headers(),
    });
    expect((await ledger())[0]?.userId).toBeNull();
    await auth.api.signInEmailOTP({
      body: { email: "ada@example.test", otp: lastOtp(mailbox) },
      headers: new Headers(),
    });
    const [row] = await ledger();
    expect(row?.usedAt).not.toBeNull();
    expect(row?.userId).toBe(await userIdOf("ada@example.test"));
    expect(row?.emailJobId).toBe("job-1");
  });

  test("an existing account is named from the moment it is sent", async () => {
    const { auth, mailbox } = instance();
    await auth.api.sendVerificationOTP({
      body: { email: "ada@example.test", type: "sign-in" },
      headers: new Headers(),
    });
    await auth.api.signInEmailOTP({
      body: { email: "ada@example.test", otp: lastOtp(mailbox) },
      headers: new Headers(),
    });
    await auth.api.sendVerificationOTP({
      body: { email: "ada@example.test", type: "sign-in" },
      headers: new Headers(),
    });
    const rows = await ledger();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ userId: await userIdOf("ada@example.test"), usedAt: null, emailJobId: "job-2" });
  });

  test("a wrong code first and the right one after still stamp the row the mail was counted against", async () => {
    const { auth, mailbox } = instance();
    await auth.api.sendVerificationOTP({
      body: { email: "ada@example.test", type: "sign-in" },
      headers: new Headers(),
    });
    const code = lastOtp(mailbox);
    const wrong = code === "000000" ? "111111" : "000000";
    await expect(
      auth.api.signInEmailOTP({ body: { email: "ada@example.test", otp: wrong }, headers: new Headers() }),
    ).rejects.toThrow();
    // Better Auth re-issued the code under a new row; the ledger row followed it.
    const [moved] = await ledger();
    expect(await liveVerificationIds()).toEqual([moved?.verificationId]);
    expect(moved?.usedAt).toBeNull();
    await auth.api.signInEmailOTP({ body: { email: "ada@example.test", otp: code }, headers: new Headers() });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usedAt).not.toBeNull();
  });

  test("a code that fails every attempt stays unused", async () => {
    const { auth, mailbox } = instance();
    await auth.api.sendVerificationOTP({
      body: { email: "ada@example.test", type: "sign-in" },
      headers: new Headers(),
    });
    const wrong = lastOtp(mailbox) === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(
        auth.api.signInEmailOTP({ body: { email: "ada@example.test", otp: wrong }, headers: new Headers() }),
      ).rejects.toThrow();
    }
    expect((await ledger())[0]?.usedAt).toBeNull();
  });
});

describe("a sign-in link", () => {
  test("is recorded when sent, with its mail, and stamped used when followed", async () => {
    const { auth, mailbox } = instance();
    await auth.api.signInMagicLink({ body: { email: "bo@example.test" }, headers: new Headers() });
    const [issued] = await ledger();
    expect(issued).toMatchObject({ type: "magic_link", emailJobId: "job-1", userId: null, usedAt: null });
    expect(await liveVerificationIds()).toEqual([issued?.verificationId]);

    await auth.api.magicLinkVerify({ query: { token: lastLinkToken(mailbox) }, headers: new Headers() });
    const [used] = await ledger();
    expect(used?.usedAt).not.toBeNull();
    expect(used?.userId).toBe(await userIdOf("bo@example.test"));
  });

  test("followed twice, is used once — the second visit is refused and stamps nothing", async () => {
    const { auth, mailbox } = instance();
    await auth.api.signInMagicLink({ body: { email: "bo@example.test" }, headers: new Headers() });
    const token = lastLinkToken(mailbox);
    await auth.api.magicLinkVerify({ query: { token }, headers: new Headers() });
    const first = (await ledger())[0]?.usedAt;
    await auth.api.magicLinkVerify({ query: { token }, headers: new Headers() }).catch(() => undefined);
    expect((await ledger())[0]?.usedAt).toEqual(first);
  });

  test("a link whose mail was withheld is recorded with the suppressed job, so the suppression joins to it", async () => {
    const { auth } = instance((_message, jobId) => ({ delivery: "withheld", reason: "hard_bounce", jobId }));
    await auth.api.signInMagicLink({ body: { email: "bo@example.test" }, headers: new Headers() });
    expect((await ledger())[0]).toMatchObject({ type: "magic_link", emailJobId: "job-1", usedAt: null });
  });

  test("a link the email seam failed to queue is still recorded, with no mail to join", async () => {
    const { auth } = instance(() => {
      throw new Error("queue down");
    });
    await auth.api
      .signInMagicLink({ body: { email: "bo@example.test" }, headers: new Headers() })
      .catch(() => undefined);
    expect((await ledger())[0]).toMatchObject({ type: "magic_link", emailJobId: null });
  });
});

describe("what the ledger never holds", () => {
  test("no column of any row carries the token, the code or the address", async () => {
    const { auth, mailbox } = instance();
    await auth.api.signInMagicLink({ body: { email: "bo@example.test" }, headers: new Headers() });
    const token = lastLinkToken(mailbox);
    await auth.api.sendVerificationOTP({
      body: { email: "ada@example.test", type: "sign-in" },
      headers: new Headers(),
    });
    const code = lastOtp(mailbox);
    const raw = await env.DB.prepare("select * from pithy_auth_verification_outcomes").all<Record<string, unknown>>();
    expect(raw.results).toHaveLength(2);
    const text = JSON.stringify(raw.results);
    for (const secret of [token, code, "bo@example.test", "ada@example.test"]) expect(text).not.toContain(secret);
  });

  test("a session made any other way stamps nothing: a token refresh is not a sign-in link", async () => {
    const { auth, mailbox } = instance();
    await auth.api.sendVerificationOTP({
      body: { email: "ada@example.test", type: "sign-in" },
      headers: new Headers(),
    });
    const signedIn = await auth.api.signInEmailOTP({
      body: { email: "ada@example.test", otp: lastOtp(mailbox) },
      headers: new Headers(),
    });
    await auth.api.sendVerificationOTP({
      body: { email: "ada@example.test", type: "sign-in" },
      headers: new Headers(),
    });
    await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${signedIn.token}` }) });
    expect((await ledger())[1]?.usedAt).toBeNull();
  });
});
