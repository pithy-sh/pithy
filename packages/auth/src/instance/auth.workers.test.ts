// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";
import { type AuthEmailMessage, type AuthInstanceDeps, makeAuth } from "./auth";
import { NO_SOCIAL_PROVIDERS, type ResolvedProviders } from "./providers";

const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
];

async function migrate(): Promise<void> {
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: { "0001_init": auth_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
}

/** Build an instance whose email seam records messages and whose audit seam records emitted events. */
function instanceWithMailbox() {
  const mailbox: AuthEmailMessage[] = [];
  const events: { action: string; outcome: string }[] = [];
  const deps: AuthInstanceDeps = {
    db: authDatabase(env.DB),
    secret: "test-secret-please-rotate-0000000000",
    baseURL: "http://localhost:8787",
    basePath: "/api/auth",
    trustedOrigins: ["http://localhost:8787"],
    ...NO_SOCIAL_PROVIDERS,
    sendEmail: async (message) => {
      mailbox.push(message);
    },
    sessionExpiresIn: 60 * 60 * 24 * 7,
    sessionUpdateAge: 60 * 60 * 24,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    emit: async (event) => {
      events.push({ action: event.action, outcome: event.outcome });
    },
    plugins: [],
  };
  return { auth: makeAuth(deps), mailbox, events };
}

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await migrate();
});

describe("the reader's stored locale", () => {
  /**
   * **The gate on `user.additionalFields`, and it has to be end-to-end.**
   *
   * Better Auth's Kysely adapter writes only the fields its options declare and projects only those
   * back, so a `locale` column present in the migration and in the `User` Zod object and absent from
   * `KIT_USER_FIELDS` is null forever and missing from every user object the instance returns. Nothing
   * about that is a type error and nothing about it is a schema mismatch — it is a column that silently
   * does nothing, which is exactly how it shipped once (#441): reverting the declaration left all 405
   * tests green.
   *
   * Asserted here rather than against `makeAuth`'s options because `betterAuth()` cannot be constructed
   * without a real database, and because the options are not the property anyway. What matters is
   * whether the value survives a write and a read through the adapter.
   */
  async function signIn(auth: ReturnType<typeof makeAuth>, mailbox: AuthEmailMessage[], email: string) {
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" }, headers: new Headers() });
    const otp = mailbox.find((m) => m.template === "otp");
    if (otp?.template !== "otp") throw new Error("no OTP sent");
    const signedIn = await auth.api.signInEmailOTP({ body: { email, otp: otp.code }, headers: new Headers() });
    return signedIn.token;
  }

  test("a reader sets a locale, reads it back, and can clear it again", async () => {
    const { auth, mailbox } = instanceWithMailbox();
    const token = await signIn(auth, mailbox, "locale@example.test");
    const headers = new Headers({ authorization: `Bearer ${token}` });

    // Absent until chosen. That null is what makes the server fall back to `Accept-Language`.
    const fresh = await auth.api.getSession({ headers });
    expect((fresh?.user as { locale?: unknown } | undefined)?.locale ?? null).toBeNull();

    await auth.api.updateUser({ body: { locale: "es-AR" }, headers });
    const chosen = await auth.api.getSession({ headers });
    expect((chosen?.user as { locale?: unknown } | undefined)?.locale).toBe("es-AR");

    // And the round trip really reached the column, not just the session projection.
    const row = await env.DB.prepare("select locale from pithy_auth_users where email = ?")
      .bind("locale@example.test")
      .first<{ locale: string | null }>();
    expect(row?.locale).toBe("es-AR");

    // Taking it back is the case a bare `Locale` validator refused. Null is an ordinary state here.
    await auth.api.updateUser({ body: { locale: null }, headers });
    const cleared = await auth.api.getSession({ headers });
    expect((cleared?.user as { locale?: unknown } | undefined)?.locale ?? null).toBeNull();
  });

  test("a locale that is not a language tag is refused, so no read can be poisoned", async () => {
    // Every read of the column goes through `User.parse`, and the admin listing parses a page of rows
    // at a time — so one junk write would throw for every operator, not only for whoever wrote it. The
    // validator is what keeps that impossible rather than unlikely.
    const { auth, mailbox } = instanceWithMailbox();
    const token = await signIn(auth, mailbox, "junk@example.test");
    const headers = new Headers({ authorization: `Bearer ${token}` });
    await expect(auth.api.updateUser({ body: { locale: "not a tag" }, headers })).rejects.toThrow();
    await expect(auth.api.updateUser({ body: { locale: "x".repeat(5000) }, headers })).rejects.toThrow();
  });
});

describe("Better Auth ⇄ CamelCasePlugin on snake_case D1 tables", () => {
  /** Sign a user in via email-OTP and return the session token (usable as `Authorization: Bearer`). */
  async function signInViaOtp(auth: ReturnType<typeof makeAuth>, mailbox: AuthEmailMessage[], email: string) {
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" }, headers: new Headers() });
    const otpMessage = mailbox.find((m) => m.template === "otp");
    if (otpMessage?.template !== "otp") throw new Error("no OTP sent");
    expect(otpMessage.code).toMatch(/^\d{6}$/);
    const signedIn = await auth.api.signInEmailOTP({ body: { email, otp: otpMessage.code }, headers: new Headers() });
    return signedIn.token;
  }

  test("a magic-link sign-in creates a verified user and a session (write path)", async () => {
    const { auth, mailbox } = instanceWithMailbox();

    await auth.api.signInMagicLink({ body: { email: "ada@example.com" }, headers: new Headers() });
    const link = mailbox.find((m) => m.template === "magicLink");
    if (link?.template !== "magicLink") throw new Error("no magic link sent");

    await auth.api.magicLinkVerify({ query: { token: link.token }, headers: new Headers(), asResponse: true });

    // Proves the WRITE path: Better Auth inserted into the snake_case tables via our Kysely.
    const user = await env.DB.prepare("select email, email_verified from pithy_auth_users where email = ?")
      .bind("ada@example.com")
      .first<{ email: string; email_verified: number }>();
    expect(user).toEqual({ email: "ada@example.com", email_verified: 1 });
    const sessions = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(1);
  });

  test("an email-OTP sign-in round-trips and getSession reads it back via bearer (read path)", async () => {
    const { auth, mailbox } = instanceWithMailbox();

    const token = await signInViaOtp(auth, mailbox, "grace@example.com");
    expect(token).toBeTruthy();

    const user = await env.DB.prepare("select email from pithy_auth_users where email = ?")
      .bind("grace@example.com")
      .first<{ email: string }>();
    expect(user?.email).toBe("grace@example.com");

    // Proves the READ path: Better Auth resolves the session off the same tables.
    const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    expect(session?.user.email).toBe("grace@example.com");
  });

  test("device headers at sign-in register a device, bind the session, and emit audit events", async () => {
    const { auth, mailbox, events } = instanceWithMailbox();
    await auth.api.sendVerificationOTP({ body: { email: "mae@example.com", type: "sign-in" }, headers: new Headers() });
    const otp = mailbox.find((m) => m.template === "otp");
    if (otp?.template !== "otp") throw new Error("no OTP sent");

    await auth.api.signInEmailOTP({
      body: { email: "mae@example.com", otp: otp.code },
      headers: new Headers({
        "x-pithy-device-id": "dev-xyz",
        "x-pithy-platform": "android",
        "x-pithy-device-name": "Pixel",
        "cf-connecting-ip": "203.0.113.9",
      }),
    });

    const device = await env.DB.prepare("select id, platform, name, user_id from pithy_auth_devices where id = ?")
      .bind("dev-xyz")
      .first<{ id: string; platform: string; name: string; user_id: string }>();
    expect(device).toMatchObject({ id: "dev-xyz", platform: "android", name: "Pixel" });

    const session = await env.DB.prepare("select device_id from pithy_auth_sessions where user_id = ?")
      .bind(device?.user_id)
      .first<{ device_id: string }>();
    expect(session?.device_id).toBe("dev-xyz");

    expect(events).toContainEqual({ action: "auth/signin", outcome: "success" });
    expect(events).toContainEqual({ action: "auth/device_registered", outcome: "success" });
    expect(events).toContainEqual({ action: "auth/otp_sent", outcome: "success" });
  });

  test("the JWKS endpoint publishes a key and /token mints a JWT access token", async () => {
    const { auth, mailbox } = instanceWithMailbox();
    const token = await signInViaOtp(auth, mailbox, "lin@example.com");

    const accessToken = await auth.api.getToken({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    expect(accessToken.token.split(".")).toHaveLength(3); // a JWT: header.payload.signature

    const jwks = await auth.api.getJwks();
    expect(jwks.keys.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Social-provider + account-linking wiring, asserted through the options Better Auth receives verbatim
 * (`instance.options`). Constructing the instance needs `env.DB` but touches no network — no OAuth
 * round-trip — so this pins exactly what Pithy hands Better Auth, per provider.
 */
describe("social providers and account linking, via instance.options", () => {
  function instanceWith(providers: Partial<ResolvedProviders>) {
    const deps: AuthInstanceDeps = {
      db: authDatabase(env.DB),
      secret: "test-secret-please-rotate-0000000000",
      baseURL: "http://localhost:8787",
      basePath: "/api/auth",
      trustedOrigins: ["http://localhost:8787"],
      sendEmail: async () => {},
      sessionExpiresIn: 60 * 60 * 24 * 7,
      sessionUpdateAge: 60 * 60 * 24,
      verificationExpiresIn: 300,
      otpLength: 6,
      disableSignUp: false,
      emit: async () => {},
      plugins: [],
      ...NO_SOCIAL_PROVIDERS,
      ...providers,
    };
    return makeAuth(deps);
  }

  test("no provider credentials → socialProviders is omitted entirely", () => {
    expect(instanceWith({}).options.socialProviders).toBeUndefined();
  });

  test("enabled providers appear in the options Better Auth receives, with the right scopes", () => {
    const options = instanceWith({
      google: { state: "ready", credentials: { clientId: "g", clientSecret: "gs" } },
      apple: { state: "ready", credentials: { clientId: "a", clientSecret: "as" } },
      facebook: { state: "ready", credentials: { clientId: "f", clientSecret: "fs" } },
      github: { state: "ready", credentials: { clientId: "h", clientSecret: "hs" } },
    }).options;
    const social = options.socialProviders as Record<
      string,
      { scope?: string[]; mapProfileToUser?: () => { emailVerified?: boolean } }
    >;
    expect(Object.keys(social).sort()).toEqual(["apple", "facebook", "github", "google"]);
    expect(social.facebook?.scope).toEqual(["email"]);
    // Facebook's email is asserted verified (it stays out of trustedProviders — see the linking test).
    expect(social.facebook?.mapProfileToUser?.()).toEqual({ emailVerified: true });
    expect(social.github?.scope).toEqual(["user:email"]);
  });

  test("trustedProviders stays Google and Apple only — Facebook and GitHub are never trusted", () => {
    const linking = instanceWith({
      facebook: { state: "ready", credentials: { clientId: "f", clientSecret: "fs" } },
      github: { state: "ready", credentials: { clientId: "h", clientSecret: "hs" } },
    }).options.account?.accountLinking;
    expect(linking?.enabled).toBe(true);
    expect(linking?.trustedProviders).toEqual(["google", "apple"]);
    expect(linking?.trustedProviders).not.toContain("facebook");
    expect(linking?.trustedProviders).not.toContain("github");
  });

  /**
   * #381, at the layer where the instance is assembled. An unresolvable provider is built *out* — the
   * whole point, since a `Promise.all` rejection used to build nothing at all — while the ready one
   * beside it is untouched. What the two absences then look like from outside is not the same, and
   * that half is `providers.test.ts`'s and `http/providerResolution.workers.test.ts`'s.
   */
  test("an unresolvable provider is left out, and its ready sibling is not", () => {
    const social = instanceWith({
      google: { state: "ready", credentials: { clientId: "g", clientSecret: "gs" } },
      github: { state: "unresolvable" },
    }).options.socialProviders as Record<string, unknown>;
    expect(Object.keys(social)).toEqual(["google"]);
  });

  test("every provider unresolvable → socialProviders is omitted, as when every provider is off", () => {
    expect(
      instanceWith({
        google: { state: "unresolvable" },
        apple: { state: "unresolvable" },
        facebook: { state: "unresolvable" },
        github: { state: "unresolvable" },
      }).options.socialProviders,
    ).toBeUndefined();
  });

  test("the seeding guard is wired as a user create.before hook", () => {
    expect(typeof instanceWith({}).options.databaseHooks?.user?.create?.before).toBe("function");
  });
});
