// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The provider-link trail, asserted against the account table it is supposed to describe.**
 *
 * The question this trail exists to answer is *which providers can sign in as this account today, and
 * when did that change*. So every case here asserts the event **and** `pithy_auth_accounts` in the same
 * breath: a row emitted while the table disagrees is the defect (#627), not a passing test. That is also
 * why nothing here stubs `emitAfterRequest` or any other emitter — a spy proves a function ran, and what
 * was wrong before was *when* it ran, which a spy cannot see.
 *
 * Both writes go through `internalAdapter` and therefore through Better Auth's `account` database hooks,
 * which is where the kit listens: `createAccount`/`linkAccount` both call `createWithHooks(…, "account")`
 * and `deleteAccount` calls `deleteWithHooks(…, "account")` (`better-auth/dist/db/internal-adapter.mjs`).
 * Driving the row is driving the real path, in the workers runtime over real D1.
 */

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { AuthConfig, type AuthWiring } from "../capability";
import { authDatabase } from "../data/tables";
import { publishSameOrigin } from "../http/csrf";
import { createSessionMiddleware } from "../http/middleware";
import { createAuthRoutes } from "../http/routes";
import { makeAuth } from "../instance/auth";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";

const SECRET = "test-secret-please-rotate-0000000000";

const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
  // The send seam's own tables. A queued message is what `auth/magic_link_sent` and `auth/otp_sent`
  // claim, so the claim is checked against the row the email capability writes rather than against a
  // stub this file controls — the assertion has to come from outside the thing it is asserting about.
  "pithy_email_jobs",
  "pithy_email_events",
];

const SECRETS: SecretFixture<typeof authSecretsRegistry> = {
  "auth-session-secret": SECRET,
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
  "auth-github-credentials": { clientId: "h", clientSecret: "h" },
};

/** The `emit` seam, capturing. The seam is core's contract; nothing below it is stubbed. */
function capturingEmit(): { emit: AuditEmit; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return { events, emit: async (event) => void events.push(event) };
}

function wiring(over: { disableSignUp?: boolean } = {}): AuthWiring {
  return {
    config: AuthConfig.parse({
      baseURL: "http://localhost",
      basePath: "/auth",
      trustedOrigins: ["http://localhost"],
      google: { enabled: true },
      ...over,
    }),
    resolveGithubUserInfo: undefined,
    // The real capability's enqueue. Nothing here sends mail, but the seam is the composed one rather
    // than a stub, so a shape change in `@pithy-sh/email` reaches this suite as a type error.
    enqueueEmail: email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" }).enqueue,
    // Not composed. The humanity gate sits on the two send routes, and nothing here sends.
    turnstile: undefined,
  };
}

/** The capability's own middleware order, so a request reaching a route carries what the route reads. */
function buildApp(emit: AuditEmit, config: AuthWiring = wiring()): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("emit", emit);
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  publishSameOrigin(config)(app);
  createSessionMiddleware(config)(app);
  createAuthRoutes(config)(app);
  return app;
}

/** The email jobs the send seam actually queued — the send events' subject, read from its own table. */
async function queuedEmails(): Promise<{ to_address: string; template: string }[]> {
  const result = await env.DB.prepare("select to_address, template from pithy_email_jobs").all<{
    to_address: string;
    template: string;
  }>();
  return result.results;
}

function appEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

/**
 * A management console, as an adopter's plugin — the seam `auth({ plugins: [...] })` exists for, and the
 * shape Better Auth's own `/delete-user` has.
 *
 * **Two endpoints, because the cascade's actor depends on who reached it.** One declares
 * `sessionMiddleware`, so `ctx.context.session` is the operator's and the row names them; the other
 * declares none, so a server-to-server caller has an address and no identity. Nothing here is a stand-in
 * for the cascade itself: both call the real `internalAdapter.deleteUser`, which walks the real
 * `deleteManyWithHooks` over the real account table.
 */
function operatorConsole() {
  const body = z.object({ userId: z.string().describe("The user to delete, cascading their accounts.") });
  return {
    id: "test-operator-console",
    endpoints: {
      operatorDeleteUser: createAuthEndpoint(
        "/operator/delete-user",
        { method: "POST", body, use: [sessionMiddleware] },
        async (ctx) => {
          await ctx.context.internalAdapter.deleteUser(ctx.body.userId);
          return ctx.json({ deleted: true });
        },
      ),
      machineDeleteUser: createAuthEndpoint("/operator/machine-delete-user", { method: "POST", body }, async (ctx) => {
        await ctx.context.internalAdapter.deleteUser(ctx.body.userId);
        return ctx.json({ deleted: true });
      }),
    },
  };
}

/** A real instance over the real D1 bindings, with the `emit` seam handed in. */
function instance<const Plugins extends readonly BetterAuthPlugin[]>(
  emit: AuditEmit,
  plugins: Plugins = [] as unknown as Plugins,
) {
  const mailbox: { template: string; code?: string }[] = [];
  const auth = makeAuth({
    db: authDatabase(env.DB),
    secret: SECRET,
    baseURL: "http://localhost",
    basePath: "/auth",
    trustedOrigins: ["http://localhost"],
    google: { state: "ready", credentials: { clientId: "g", clientSecret: "g" } },
    apple: { state: "disabled" },
    facebook: { state: "disabled" },
    github: { state: "disabled" },
    sendEmail: async (m) => {
      mailbox.push(m.template === "otp" ? { template: "otp", code: m.code } : { template: m.template });
    },
    sessionExpiresIn: 604800,
    sessionUpdateAge: 86400,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    providerSignUp: { google: true, apple: true, facebook: true, github: true },
    emit,
    plugins,
  });
  return { auth, mailbox };
}

/** Somebody else's account, with a provider linked to it — what an operator's cascade removes. */
async function victimWithAccount(emit: AuditEmit): Promise<{ userId: string; accountId: string }> {
  const ctx = await instance(emit).auth.$context;
  const user = await ctx.internalAdapter.createUser(
    { email: "victim@test.com", name: "Victim", emailVerified: true },
    { method: "oauth", oauth: { providerId: "google", profile: {} } },
  );
  const account = await createAccountRow(emit, {
    userId: String(user.id),
    providerId: "google",
    accountId: "google-sub-victim",
    issuer: "https://accounts.google.com",
  });
  return { userId: String(user.id), accountId: account.id };
}

/** Sign somebody in for real (OTP, no HTTP, no mail) and hand back a usable bearer token. */
async function signIn(emit: AuditEmit): Promise<{ token: string; userId: string }> {
  const { auth, mailbox } = instance(emit);
  await auth.api.sendVerificationOTP({ body: { email: "u@test.com", type: "sign-in" }, headers: new Headers() });
  const otp = mailbox.find((m) => m.template === "otp");
  if (!otp?.code) throw new Error("no OTP");
  const signedIn = await auth.api.signInEmailOTP({
    body: { email: "u@test.com", otp: otp.code },
    headers: new Headers(),
  });
  return { token: signedIn.token, userId: signedIn.user.id };
}

/**
 * Every column on the account row that must never reach the trail, each planted with a value nothing
 * else in the fixture could produce.
 *
 * **All five, because four of them were null.** The first cut of the no-token gate planted `accessToken`
 * alone and asserted the serialized payload against all five — so the four that were never written
 * passed whatever the emitter did with them. A gate whose subject is absent is not a gate.
 */
const SENSITIVE_COLUMNS = {
  accessToken: "ya29-provider-access-token",
  refreshToken: "1ff-provider-refresh-token",
  idToken: "eyJ-provider-id-token",
  scope: "openid email profile https://www.googleapis.com/auth/drive",
  password: "argon2-hash-that-should-not-exist-here",
} as const;

/** Create one account row the way the OAuth callback does — through `internalAdapter`, over real D1. */
async function createAccountRow(
  emit: AuditEmit,
  row: {
    userId: string;
    providerId: string;
    accountId: string;
    issuer: string;
    sensitive?: boolean;
  },
): Promise<{ id: string }> {
  const ctx = await instance(emit).auth.$context;
  const created = await ctx.internalAdapter.createAccount({
    userId: row.userId,
    providerId: row.providerId,
    accountId: row.accountId,
    issuer: row.issuer,
    ...(row.sensitive ? SENSITIVE_COLUMNS : {}),
  });
  if (!created) throw new Error("account row not created");
  return { id: String(created.id) };
}

/** Sign in over HTTP so the response carries a session cookie — the only credential `/sign-out` reads. */
async function signInForCookie(emit: AuditEmit): Promise<{ cookie: string; userId: string }> {
  const { auth, mailbox } = instance(emit);
  await auth.api.sendVerificationOTP({ body: { email: "c@test.com", type: "sign-in" }, headers: new Headers() });
  const otp = mailbox.find((m) => m.template === "otp");
  if (!otp?.code) throw new Error("no OTP");
  const res = await buildApp(emit).request(
    "/auth/sign-in/email-otp",
    {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ email: "c@test.com", otp: otp.code }),
    },
    appEnv(),
  );
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error(`no session cookie on sign-in (${res.status})`);
  const cookie = setCookie
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0]?.trim())
    .filter((c): c is string => Boolean(c))
    .join("; ");
  const body = await res.json<{ user?: { id?: string } }>();
  if (!body.user?.id) throw new Error("no user on sign-in");
  return { cookie, userId: body.user.id };
}

async function accountRows(): Promise<{ id: string; provider_id: string }[]> {
  const result = await env.DB.prepare("select id, provider_id from pithy_auth_accounts").all<{
    id: string;
    provider_id: string;
  }>();
  return result.results;
}

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
    { database: "app", namespace: "email", order: 200, migrations: { "0001_init": email_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  configureSharedSecrets({ registry: authSecretsRegistry });
  await seedSecrets(env, authSecretsRegistry, SECRETS);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("the provider-link trail", () => {
  test("minting a redirect is not a link: /link-social writes no oauth_linked row", async () => {
    // **The defect, stated as a request.** `/link-social` mints the provider redirect and nothing else;
    // whether an account row is ever created depends on a consent screen this Worker does not control.
    // Somebody who closes that tab has linked nothing, and the trail must not say otherwise.
    const { emit, events } = capturingEmit();
    const { token } = await signIn(emit);
    const res = await buildApp(emit).request(
      "/auth/link-social",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "http://localhost/cb" }),
      },
      appEnv(),
    );

    // The redirect was minted — this is the abandoned-consent case, not a refusal.
    expect(res.status).toBe(200);
    expect((await res.json<{ url: string }>()).url).toContain("accounts.google.com");
    // And the table agrees with the (absent) row: nothing was linked.
    expect(await accountRows()).toHaveLength(0);
    expect(events.map((e) => e.action)).not.toContain("auth/oauth_linked");
  });

  test("the row is the event: creating the account emits oauth_linked, naming the provider", async () => {
    const { emit, events } = capturingEmit();
    const { userId } = await signIn(emit);
    const account = await createAccountRow(emit, {
      userId,
      providerId: "google",
      accountId: "google-sub-1",
      issuer: "https://accounts.google.com",
    });

    expect(await accountRows()).toHaveLength(1);
    const linked = events.find((e) => e.action === "auth/oauth_linked");
    expect(linked).toMatchObject({
      outcome: "success",
      resourceType: "account",
      resourceId: account.id,
      // Whose link it is. Not `actorId`: the two answer different questions and are allowed to disagree.
      metadata: { provider: "google", userId },
    });
  });

  test("a first social sign-up is a link, and the trail says so", async () => {
    // **A decision, pinned rather than left to the reading.** The code #627 replaced refused to map
    // `/callback/:id` because "mapping it here would mislabel every first sign-up as a link" — true of a
    // *path*, which cannot tell a sign-up from a link. From the row it stops mattering: `oauth_linked`
    // claims a provider can now sign in as this user, and a first social sign-up is exactly when that
    // becomes true. So the first account row a brand-new user ever gets emits it, like any other.
    const { emit, events } = capturingEmit();
    const ctx = await instance(emit).auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: "first@test.com", name: "First", emailVerified: true },
      { method: "oauth", oauth: { providerId: "google", profile: {} } },
    );
    expect(events.map((e) => e.action)).not.toContain("auth/oauth_linked");

    const account = await createAccountRow(emit, {
      userId: String(user.id),
      providerId: "google",
      accountId: "google-sub-first",
      issuer: "https://accounts.google.com",
    });

    expect(events.filter((e) => e.action === "auth/oauth_linked")).toHaveLength(1);
    expect(events.find((e) => e.action === "auth/oauth_linked")).toMatchObject({
      outcome: "success",
      resourceId: account.id,
      metadata: { provider: "google", userId: String(user.id) },
    });
  });

  test("a credential account is not an OAuth link", async () => {
    // Passwordless-only, so this row should never exist here at all — but `oauth_linked` claims a
    // provider can now sign somebody in, and a credential row is not that claim.
    const { emit, events } = capturingEmit();
    const { userId } = await signIn(emit);
    await createAccountRow(emit, {
      userId,
      providerId: "credential",
      accountId: userId,
      issuer: "local:credential",
    });

    expect(await accountRows()).toHaveLength(1);
    expect(events.map((e) => e.action)).not.toContain("auth/oauth_linked");
  });

  test("unlinking writes oauth_unlinked, and the account table agrees", async () => {
    const { emit, events } = capturingEmit();
    const { token, userId } = await signIn(emit);
    const account = await createAccountRow(emit, {
      userId,
      providerId: "google",
      accountId: "google-sub-1",
      issuer: "https://accounts.google.com",
    });

    const res = await buildApp(emit).request(
      "/auth/unlink-account",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      },
      appEnv(),
    );
    expect(res.status).toBe(200);

    // The row is gone…
    expect(await accountRows()).toHaveLength(0);
    // …and the trail says so, naming which provider can no longer sign this person in.
    const unlinked = events.find((e) => e.action === "auth/oauth_unlinked");
    expect(unlinked).toMatchObject({
      outcome: "success",
      actorType: "user",
      actorId: userId,
      resourceType: "account",
      resourceId: account.id,
      metadata: { provider: "google" },
    });
  });

  test("neither event carries anything sensitive off the row", async () => {
    // The account row holds the provider's access, refresh and id tokens, the granted scopes and Better
    // Auth's password column. The trail is longer-lived and queryable, and must not become a second
    // place any of them is kept — so every one of them is on the row when the events are written.
    const { emit, events } = capturingEmit();
    const { token, userId } = await signIn(emit);
    const account = await createAccountRow(emit, {
      userId,
      providerId: "google",
      accountId: "google-sub-1",
      issuer: "https://accounts.google.com",
      sensitive: true,
    });

    // The plant is on the row, not only in this test's intention — otherwise four of the five
    // assertions below pass because the column was never written.
    const stored = await env.DB.prepare(
      "select access_token, refresh_token, id_token, scope, password from pithy_auth_accounts where id = ?",
    )
      .bind(account.id)
      .first<Record<string, string | null>>();
    expect(Object.values(stored ?? {}).filter((v) => typeof v === "string")).toHaveLength(
      Object.keys(SENSITIVE_COLUMNS).length,
    );

    await buildApp(emit).request(
      "/auth/unlink-account",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      },
      appEnv(),
    );

    const provider = events.filter((e) => e.action === "auth/oauth_linked" || e.action === "auth/oauth_unlinked");
    expect(provider).toHaveLength(2);
    const serialized = JSON.stringify(provider);
    for (const planted of Object.values(SENSITIVE_COLUMNS)) expect(serialized).not.toContain(planted);
    expect(serialized).not.toContain("u@test.com");
    expect(serialized).not.toContain(token);
  });
});

describe("who the trail says did it", () => {
  test("an unlink the account owner drove is theirs, with the request they made it from", async () => {
    const { emit, events } = capturingEmit();
    const { token, userId } = await signIn(emit);
    const account = await createAccountRow(emit, {
      userId,
      providerId: "google",
      accountId: "google-sub-1",
      issuer: "https://accounts.google.com",
    });

    const res = await buildApp(emit).request(
      "/auth/unlink-account",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.9",
          "user-agent": "owners-browser/1",
        },
        body: JSON.stringify({ accountId: account.id }),
      },
      appEnv(),
    );
    expect(res.status).toBe(200);

    expect(events.find((e) => e.action === "auth/oauth_unlinked")).toMatchObject({
      actorType: "user",
      actorId: userId,
      ip: "198.51.100.9",
      userAgent: "owners-browser/1",
      metadata: { provider: "google", userId },
    });
  });

  test("the user-delete cascade is not the account owner's own action", async () => {
    // **The cascade this change advertises, driven rather than described.** `delete.after` fires on
    // every removal, and `internalAdapter.deleteUser` drops every account a user holds. Recorded as the
    // owner's action it says that person detached their own providers — from whatever address the
    // operator who deleted them was calling from. An audit trail that misattributes an actor is worse
    // than one that is silent, because it reads as evidence.
    const { emit, events } = capturingEmit();
    const { userId } = await signIn(emit);
    const account = await createAccountRow(emit, {
      userId,
      providerId: "google",
      accountId: "google-sub-1",
      issuer: "https://accounts.google.com",
    });
    events.length = 0;

    const ctx = await instance(emit).auth.$context;
    await ctx.internalAdapter.deleteUser(userId);

    // The cascade happened…
    expect(await accountRows()).toHaveLength(0);
    // …and the trail records it, which it did not before #627.
    const unlinked = events.filter((e) => e.action === "auth/oauth_unlinked");
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatchObject({
      outcome: "success",
      actorType: "system",
      resourceType: "account",
      resourceId: account.id,
      metadata: { provider: "google", userId },
    });
    // Nobody called, so nobody is named and no request is borrowed to stand in for one.
    expect(unlinked[0]?.actorId ?? null).toBeNull();
    expect(unlinked[0]?.ip ?? null).toBeNull();
    expect(unlinked[0]?.userAgent ?? null).toBeNull();
  });

  test("a cascade an operator drove through an endpoint is the operator's action", async () => {
    // **A1, and the reason two docblocks changed.** `deleteWithHooks` resolves its context from
    // `getCurrentAuthContext()`, which is async-scoped to the dispatch — so a cascade reached from an
    // endpoint carries *that endpoint's* context, session and all. The operator is named, correctly:
    // they caused every removal the cascade made. `system` is not what a cascade is; it is what *no
    // request* is, and the two had been written down as the same thing.
    const { emit, events } = capturingEmit();
    const operator = await signIn(emit);
    const victim = await victimWithAccount(emit);
    events.length = 0;

    const { auth } = instance(emit, [operatorConsole()] as const);
    await auth.api.operatorDeleteUser({
      body: { userId: victim.userId },
      headers: new Headers({
        authorization: `Bearer ${operator.token}`,
        "cf-connecting-ip": "198.51.100.77",
        "user-agent": "operator-console/1",
      }),
    });

    expect(await accountRows()).toHaveLength(0);
    const unlinked = events.filter((e) => e.action === "auth/oauth_unlinked");
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatchObject({
      outcome: "success",
      actorType: "user",
      actorId: operator.userId,
      ip: "198.51.100.77",
      userAgent: "operator-console/1",
      resourceId: victim.accountId,
      // Whose link it was. The operator acted; the victim owned it, and the columns disagree on purpose.
      metadata: { provider: "google", userId: victim.userId },
    });
    expect(unlinked[0]?.actorId).not.toBe(victim.userId);
  });

  test("a cascade a server-to-server call drove is anonymous, with that call's address", async () => {
    // **A2.** The same endpoint with no session middleware and no credential: somebody was calling, so
    // the request's address is a fact about the row, and nobody was signed in, so no id is. Still not
    // `system` — that is reserved for a cascade with no request behind it at all, which the case above
    // this pair already pins.
    const { emit, events } = capturingEmit();
    const victim = await victimWithAccount(emit);
    events.length = 0;

    const { auth } = instance(emit, [operatorConsole()] as const);
    await auth.api.machineDeleteUser({
      body: { userId: victim.userId },
      headers: new Headers({ "cf-connecting-ip": "203.0.113.44", "user-agent": "provisioner/3" }),
    });

    expect(await accountRows()).toHaveLength(0);
    const unlinked = events.filter((e) => e.action === "auth/oauth_unlinked");
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatchObject({
      outcome: "success",
      actorType: "anonymous",
      ip: "203.0.113.44",
      userAgent: "provisioner/3",
      metadata: { provider: "google", userId: victim.userId },
    });
    expect(unlinked[0]?.actorId ?? null).toBeNull();
  });

  test("two concurrent unlinks of one account emit oauth_unlinked once", async () => {
    // Better Auth's `deleteWithHooks` reads the row, deletes it, then runs `delete.after` gated on the
    // row it *read* — so both callers reach the hook and one removal is recorded twice. A trail that
    // double-counts is one somebody will reconcile against and lose an afternoon to.
    const { emit, events } = capturingEmit();
    const { userId } = await signIn(emit);
    const account = await createAccountRow(emit, {
      userId,
      providerId: "google",
      accountId: "google-sub-1",
      issuer: "https://accounts.google.com",
    });
    events.length = 0;

    const ctx = await instance(emit).auth.$context;
    await Promise.all([ctx.internalAdapter.deleteAccount(account.id), ctx.internalAdapter.deleteAccount(account.id)]);

    expect(await accountRows()).toHaveLength(0);
    expect(events.filter((e) => e.action === "auth/oauth_unlinked")).toHaveLength(1);
  });
});

describe("a refused request is never recorded as a success", () => {
  test("GET /token with no credential answers 401 and records a denial", async () => {
    const { emit, events } = capturingEmit();
    const res = await buildApp(emit).request("/auth/token", { method: "GET" }, appEnv());

    expect(res.status).toBe(401);
    const written = events.filter((e) => e.action === "auth/token_refresh");
    expect(written.map((e) => e.outcome)).toEqual(["denied"]);
  });

  test("an invalid address answers 400 and records the send as denied", async () => {
    const { emit, events } = capturingEmit();
    const res = await buildApp(emit).request(
      "/auth/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email", type: "sign-in" }),
      },
      appEnv(),
    );

    expect(res.status).toBe(400);
    const written = events.filter((e) => e.action === "auth/otp_sent");
    expect(written.map((e) => e.outcome)).toEqual(["denied"]);
  });

  test("POST /sign-out with no session signs nobody out and records nothing", async () => {
    // This one answers 200. The endpoint is not lying — it deleted every session it found, which was
    // none. `auth/signout success` was the lie, and the evidence against it is a session row going away.
    const { emit, events } = capturingEmit();
    const res = await buildApp(emit).request(
      "/auth/sign-out",
      { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: "{}" },
      appEnv(),
    );

    expect(res.status).toBe(200);
    expect(events.map((e) => e.action)).not.toContain("auth/signout");
  });

  test("GET /token with a session answers 200 and records the refresh", async () => {
    // The other half of the 401 case above, and the one that stops "record nothing" from being the fix.
    // It is also what drives `token-minted`: the row is written because the response carried a token.
    const { emit, events } = capturingEmit();
    const { token } = await signIn(emit);
    events.length = 0;

    const res = await buildApp(emit).request(
      "/auth/token",
      { method: "GET", headers: { authorization: `Bearer ${token}` } },
      appEnv(),
    );

    expect(res.status).toBe(200);
    expect((await res.json<{ token?: string }>()).token).toBeTruthy();
    expect(events.filter((e) => e.action === "auth/token_refresh").map((e) => e.outcome)).toEqual(["success"]);
  });

  test("a real sign-out still records one", async () => {
    // The other half, and the one that stops "record nothing" from being the fix.
    const { emit, events } = capturingEmit();
    const { cookie, userId } = await signInForCookie(emit);
    const before = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
    expect(before?.n).toBe(1);
    events.length = 0;

    const res = await buildApp(emit).request(
      "/auth/sign-out",
      {
        method: "POST",
        headers: { origin: "http://localhost", cookie, "content-type": "application/json" },
        body: "{}",
      },
      appEnv(),
    );

    expect(res.status).toBe(200);
    const after = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
    expect(after?.n).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ action: "auth/signout", outcome: "success", actorId: userId }),
    );
  });
});

/**
 * **A non-2xx is sufficient evidence of a refusal and is nowhere near necessary.**
 *
 * `/email-otp/send-verification-otp` declines to send and answers `200 {"success":true}` — deliberately,
 * twice over. Better Auth refuses to confirm or deny that an address is registered
 * (`plugins/email-otp/routes.mjs`: no user and `shouldSendOTP` false, so it drops the verification row
 * and returns success), and the kit's own `sendVerificationOTP` returns without queuing anything for a
 * `type` other than `sign-in`. Reading the status alone, both look exactly like a send.
 *
 * So the claim `auth/otp_sent` is a claim about a **message**, and the evidence is the message: a row in
 * `pithy_email_jobs`, written by the email capability, read here from its own table. Nothing below is
 * asserted against the marker the emitter reads — a gate derived from its own subject proves only that
 * two copies of one value agree.
 *
 * **The wire does not change, and that is the point of the endpoint.** Every case here checks the status
 * *and* the body of the declined call against a call that really sent, because a caller who can tell a
 * registered address from an unregistered one is the defect that 200 exists to prevent. The trail may
 * know; the response may not say.
 */
describe("a refusal expressed as a success", () => {
  const SEND = "/auth/email-otp/send-verification-otp";

  /** POST the send endpoint over HTTP, handing back exactly what a caller can observe. */
  async function send(
    app: Hono<PithyHonoEnv>,
    body: { email: string; type: "sign-in" | "email-verification" },
  ): Promise<{ status: number; body: string }> {
    const res = await app.request(
      SEND,
      {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      appEnv(),
    );
    return { status: res.status, body: await res.text() };
  }

  test("a send that reached the queue is the success", async () => {
    // The half that stops "record nothing" from being the fix, and the control every case below is read
    // against: this is what a real send looks like on the wire and in both tables.
    const { emit, events } = capturingEmit();
    const answer = await send(buildApp(emit), { email: "sends@test.com", type: "sign-in" });

    expect(answer).toEqual({ status: 200, body: '{"success":true}' });
    expect(await queuedEmails()).toEqual([{ to_address: "sends@test.com", template: "otp" }]);
    expect(events.filter((e) => e.action === "auth/otp_sent").map((e) => e.outcome)).toEqual(["success"]);
  });

  test("an address nobody registered is declined, and a decline is not a send", async () => {
    // Better Auth's user-enumeration guard: no user, and `sign-in` is not the type, so the OTP row is
    // deleted and the caller is told `success`. Nothing was queued, and `auth/otp_sent outcome=success`
    // was the lie — recorded for a send the endpoint had refused to make.
    const { emit, events } = capturingEmit();
    const answer = await send(buildApp(emit), { email: "nobody@test.com", type: "email-verification" });

    expect(answer).toEqual({ status: 200, body: '{"success":true}' });
    expect(await queuedEmails()).toEqual([]);
    const written = events.filter((e) => e.action === "auth/otp_sent");
    expect(written.map((e) => e.outcome)).toEqual(["denied"]);
  });

  test("a registered address the kit will not mail for is declined the same way", async () => {
    // The second decline on the same endpoint, and it is the kit's own: `sendVerificationOTP` returns
    // without queuing for any `type` but `sign-in`. Better Auth's guard does not fire here — the user
    // exists — so this case is only reachable by asking whether a message was queued.
    const { emit, events } = capturingEmit();
    await signIn(emit);
    events.length = 0;

    const answer = await send(buildApp(emit), { email: "u@test.com", type: "email-verification" });

    expect(answer).toEqual({ status: 200, body: '{"success":true}' });
    expect(await queuedEmails()).toEqual([]);
    expect(events.filter((e) => e.action === "auth/otp_sent").map((e) => e.outcome)).toEqual(["denied"]);
  });

  test("the trail may know which address is registered; the response may not say", async () => {
    // **The tension, resolved and pinned.** With sign-up off, Better Auth's guard fires for an
    // unregistered address and not for a registered one — so this is the configuration where the two
    // calls genuinely differ, and the whole point of the 200 is that a caller cannot see it. The audit
    // trail records the difference (a send, and a decline); the wire carries the same status and the
    // same bytes for both, and the audit row names neither address.
    const { emit, events } = capturingEmit();
    await signIn(emit);
    events.length = 0;
    const app = buildApp(emit, wiring({ disableSignUp: true }));

    const registered = await send(app, { email: "u@test.com", type: "sign-in" });
    const unregistered = await send(app, { email: "stranger@test.com", type: "sign-in" });

    expect(unregistered).toEqual(registered);
    expect(await queuedEmails()).toEqual([{ to_address: "u@test.com", template: "otp" }]);
    const written = events.filter((e) => e.action === "auth/otp_sent");
    expect(written.map((e) => e.outcome)).toEqual(["success", "denied"]);
    expect(JSON.stringify(written)).not.toContain("stranger@test.com");
    expect(JSON.stringify(written)).not.toContain("u@test.com");
  });

  test("a magic link that reached the queue is a success", async () => {
    // The fourth audited path, driven for the same reason: `auth/magic_link_sent` claims a message, and
    // its evidence is the queued job rather than the 200 the endpoint would answer either way.
    const { emit, events } = capturingEmit();
    const res = await buildApp(emit).request(
      "/auth/sign-in/magic-link",
      {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ email: "link@test.com", callbackURL: "http://localhost/cb" }),
      },
      appEnv(),
    );

    expect(res.status).toBe(200);
    expect(await queuedEmails()).toEqual([{ to_address: "link@test.com", template: "magicLink" }]);
    expect(events.filter((e) => e.action === "auth/magic_link_sent").map((e) => e.outcome)).toEqual(["success"]);
  });
});
