// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { organization } from "better-auth/plugins/organization";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";
import { authPluginPlan } from "../migrations/pluginTables";
import { type AuthEmailMessage, makeAuth } from "./auth";

/**
 * The whole claim of #271, end to end inside the Workers runtime: an adopter composes a plugin the kit
 * does not ship, `pithy migrate` creates the tables that plugin needs, and **its routes answer** — a
 * real organisation is created, and it is in a real D1 table.
 *
 * Both halves in one test on purpose. Either alone passes while the feature is broken: a green
 * migration over routes nobody composed creates tables nothing uses, and a composed plugin over a
 * schema nobody migrated fails on the first call with `no such table`.
 */

const PLUGINS = [organization()];

const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "organization",
  "member",
  "invitation",
];

async function migrate(): Promise<void> {
  const provider = createMigrationRegistry([
    {
      database: "app",
      namespace: "auth",
      order: AUTH_MIGRATION_ORDER,
      migrations: { "0001_init": auth_0001_init, ...authPluginPlan(PLUGINS).migrations },
    },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
}

function instanceWithMailbox() {
  const mailbox: AuthEmailMessage[] = [];
  return {
    mailbox,
    auth: makeAuth({
      db: authDatabase(env.DB),
      secret: "test-secret-please-rotate-0000000000",
      baseURL: "http://localhost:8787",
      basePath: "/api/auth",
      trustedOrigins: ["http://localhost:8787"],
      sendEmail: async (message) => {
        mailbox.push(message);
      },
      sessionExpiresIn: 60 * 60 * 24 * 7,
      sessionUpdateAge: 60 * 60 * 24,
      verificationExpiresIn: 300,
      otpLength: 6,
      disableSignUp: false,
      emit: async () => {},
      plugins: PLUGINS,
    }),
  };
}

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await migrate();
});

describe("an adopter's plugin, composed and migrated", () => {
  test("the kit's four still answer — the adopter's list added to them, it did not replace them", async () => {
    const { auth, mailbox } = instanceWithMailbox();

    await auth.api.sendVerificationOTP({ body: { email: "ada@example.com", type: "sign-in" }, headers: new Headers() });
    expect(mailbox.find((message) => message.template === "otp")).toBeTruthy();
    // The JWKS the control-plane seam verifies against, still served by the kit's own jwt plugin.
    const jwks = await auth.api.getJwks();
    expect(Array.isArray(jwks.keys)).toBe(true);
  });

  test("the plugin's own route answers, and its row lands in the table pithy migrate created", async () => {
    const { auth, mailbox } = instanceWithMailbox();

    await auth.api.sendVerificationOTP({ body: { email: "ada@example.com", type: "sign-in" }, headers: new Headers() });
    const otp = mailbox.find((message) => message.template === "otp");
    if (otp?.template !== "otp") throw new Error("no OTP sent");
    const signedIn = await auth.api.signInEmailOTP({
      body: { email: "ada@example.com", otp: otp.code },
      headers: new Headers(),
    });

    const headers = new Headers({ authorization: `Bearer ${signedIn.token}` });
    const created = await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers });
    expect(created?.slug).toBe("acme");

    const row = await env.DB.prepare("select name, slug from organization where slug = ?")
      .bind("acme")
      .first<{ name: string; slug: string }>();
    expect(row).toEqual({ name: "Acme", slug: "acme" });
    // And the membership the plugin writes beside it, in the second table the migration created.
    const members = await env.DB.prepare("select count(*) as n from member").first<{ n: number }>();
    expect(members?.n).toBe(1);
  });

  test("the column the plugin added to the kit's session table is writable — setActive is not half a feature", async () => {
    const { auth, mailbox } = instanceWithMailbox();

    await auth.api.sendVerificationOTP({ body: { email: "ada@example.com", type: "sign-in" }, headers: new Headers() });
    const otp = mailbox.find((message) => message.template === "otp");
    if (otp?.template !== "otp") throw new Error("no OTP sent");
    const signedIn = await auth.api.signInEmailOTP({
      body: { email: "ada@example.com", otp: otp.code },
      headers: new Headers(),
    });
    const headers = new Headers({ authorization: `Bearer ${signedIn.token}` });
    const created = await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers });
    if (!created) throw new Error("no organization created");

    await auth.api.setActiveOrganization({ body: { organizationId: created.id }, headers });

    const session = await env.DB.prepare(
      "select active_organization_id from pithy_auth_sessions where active_organization_id is not null",
    ).first<{ active_organization_id: string }>();
    expect(session?.active_organization_id).toBe(created.id);
  });
});
