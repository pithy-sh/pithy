// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { MAX_STORED_IMAGE_CHARS } from "@pithy-sh/core/src/image/storedImage";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getUsers } from "../admin/users";
import { AuthConfig, type AuthWiring } from "../capability";
import { authDatabase } from "../data/tables";
import { publishSameOrigin } from "../http/csrf";
import { createSessionMiddleware } from "../http/middleware";
import { createAuthRoutes } from "../http/routes";
import { makeAuth } from "../instance/auth";
import { NO_SOCIAL_PROVIDERS } from "../instance/providers";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { userImageSource } from "./profile";

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

/** "Pithy" as base64 — five bytes, so the served body can be compared exactly. */
const RASTER = "data:image/png;base64,UGl0aHk=";
const VECTOR = "data:image/svg+xml;base64,UGl0aHk=";

function wiring(): AuthWiring {
  return {
    config: AuthConfig.parse({ baseURL: "http://localhost", basePath: "/auth", trustedOrigins: ["http://localhost"] }),
    resolveGithubUserInfo: undefined,
    // The instance will not build without the email seam — it is what a magic link is sent through.
    enqueueEmail: email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" }).enqueue,
    turnstile: undefined,
  };
}

/** The request env, spread the way the capability's own suites do — `env` itself does not enumerate. */
function appEnv(): Record<string, unknown> {
  return { ...(env as unknown as Record<string, unknown>) };
}

function buildApp(): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    if (c.get("emit") === undefined) c.set("emit", noopEmit);
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  publishSameOrigin(wiring())(app);
  createSessionMiddleware(wiring())(app);
  createAuthRoutes(wiring())(app);
  return app;
}

function instance() {
  const mailbox: { template: string; code?: string }[] = [];
  const auth = makeAuth({
    db: authDatabase(env.DB),
    secret: SECRET,
    baseURL: "http://localhost",
    basePath: "/auth",
    trustedOrigins: ["http://localhost"],
    ...NO_SOCIAL_PROVIDERS,
    sendEmail: async (m) => {
      mailbox.push(m.template === "otp" ? { template: "otp", code: m.code } : { template: m.template });
    },
    sessionExpiresIn: 604800,
    sessionUpdateAge: 86400,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    providerSignUp: { google: true, apple: true, facebook: true, github: true },
    emit: noopEmit,
    plugins: [],
  });
  return { auth, mailbox };
}

/** Sign somebody in through the real OTP flow and hand back a usable bearer token. */
async function signIn(email: string): Promise<{ token: string; userId: string }> {
  const { auth, mailbox } = instance();
  await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" }, headers: new Headers() });
  const otp = mailbox.find((m) => m.template === "otp");
  if (!otp?.code) throw new Error("no OTP");
  const signedIn = await auth.api.signInEmailOTP({ body: { email, otp: otp.code }, headers: new Headers() });
  return { token: signedIn.token, userId: signedIn.user.id };
}

/** Read one user's stored picture straight out of D1, past every projection. */
async function storedImageOf(userId: string): Promise<string | null> {
  const row = await authDatabase(env.DB)
    .selectFrom("pithyAuthUsers")
    .select(["image"])
    .where("id", "=", userId)
    .executeTakeFirst();
  return row?.image ?? null;
}

/** Post to Better Auth's own `/update-user`, which is the one door the kit gates rather than replaces. */
async function updateUser(token: string, body: Record<string, unknown>): Promise<Response> {
  return buildApp().request(
    "/auth/update-user",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify(body),
    },
    appEnv(),
  );
}

beforeEach(async () => {
  for (const t of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${t}`).run();
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

describe("the write gate — every door, not one", () => {
  test("a stored raster is accepted and lands in the column", async () => {
    const { token, userId } = await signIn("ada@test.com");
    expect((await updateUser(token, { image: RASTER })).status).toBe(200);
    expect(await storedImageOf(userId)).toBe(RASTER);
  });

  test("`data:text/html` is refused with a 400, and the column keeps its old value", async () => {
    // The way in this gate exists to close. Better Auth's own `/update-user` passes `image` straight
    // to the adapter — `parseUserInput` reaches the *additional* fields only — so without the database
    // hook this write would have succeeded.
    const { token, userId } = await signIn("ada@test.com");
    await updateUser(token, { image: RASTER });
    const res = await updateUser(token, { image: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" });
    expect(res.status).toBe(400);
    expect(await storedImageOf(userId)).toBe(RASTER);
  });

  test("a media type outside the allowlist is refused", async () => {
    const { token } = await signIn("ada@test.com");
    expect((await updateUser(token, { image: "data:image/gif;base64,UGl0aHk=" })).status).toBe(400);
  });

  test("a payload over the ceiling is refused", async () => {
    const { token } = await signIn("ada@test.com");
    const over = `data:image/png;base64,${"A".repeat(MAX_STORED_IMAGE_CHARS)}`;
    expect((await updateUser(token, { image: over })).status).toBe(400);
  });

  test("a `javascript:` payload wearing a URL's clothes is refused", async () => {
    const { token } = await signIn("ada@test.com");
    expect((await updateUser(token, { image: "javascript:alert(1)" })).status).toBe(400);
  });

  test("a provider URL is still accepted, so an existing row's shape keeps working", async () => {
    const { token, userId } = await signIn("ada@test.com");
    const link = "https://avatars.githubusercontent.com/u/1?v=4";
    expect((await updateUser(token, { image: link })).status).toBe(200);
    expect(await storedImageOf(userId)).toBe(link);
  });

  test("clearing the picture is expressible — `null` is a 200, not a 400", async () => {
    const { token, userId } = await signIn("ada@test.com");
    await updateUser(token, { image: RASTER });
    expect((await updateUser(token, { image: null })).status).toBe(200);
    expect(await storedImageOf(userId)).toBeNull();
  });

  test("an over-long name is refused rather than stored", async () => {
    const { token } = await signIn("ada@test.com");
    expect((await updateUser(token, { name: "a".repeat(300) })).status).toBe(400);
  });

  test("there is no request shape that sets somebody else's picture", async () => {
    // Not a permission this capability declines to grant — one that cannot be expressed. The subject
    // is the session, so every spelling of "and also them" is ignored rather than refused.
    const ada = await signIn("ada@test.com");
    const grace = await signIn("grace@test.com");
    for (const body of [
      { userId: grace.userId, image: RASTER },
      { id: grace.userId, image: RASTER },
      { user: { id: grace.userId }, image: RASTER },
    ]) {
      await updateUser(ada.token, body);
      expect(await storedImageOf(grace.userId), JSON.stringify(body)).toBeNull();
    }
    expect(await storedImageOf(ada.userId)).toBe(RASTER);
  });
});

describe("the serving route", () => {
  async function fetchImage(token?: string): Promise<Response> {
    return buildApp().request(
      "/auth/profile/image?v=1",
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
      appEnv(),
    );
  }

  test("serves a stored raster as bytes, with the type from the allowlist and no sniffing", async () => {
    const { token } = await signIn("ada@test.com");
    await updateUser(token, { image: RASTER });
    const res = await fetchImage(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("Pithy");
  });

  test("refuses to serve a vector, so no navigation can run script in this origin", async () => {
    // The gate rather than a caution: the bytes are in the column and the route still will not hand
    // them over by URL. Nothing here depends on a header being right.
    const { token } = await signIn("ada@test.com");
    expect((await updateUser(token, { image: VECTOR })).status).toBe(200);
    expect(await storedImageOf((await signIn("ada@test.com")).userId)).toBe(VECTOR);
    expect((await fetchImage(token)).status).toBe(404);
  });

  test("refuses to serve a provider link — it is a URL somewhere else already", async () => {
    const { token } = await signIn("ada@test.com");
    await updateUser(token, { image: "https://avatars.githubusercontent.com/u/1?v=4" });
    expect((await fetchImage(token)).status).toBe(404);
  });

  test("no picture is a 404, not an error", async () => {
    const { token } = await signIn("ada@test.com");
    expect((await fetchImage(token)).status).toBe(404);
  });

  test("an unauthenticated request is refused before anything is read", async () => {
    expect((await fetchImage()).status).toBe(401);
  });

  test("the path carries no id, so there is nothing to enumerate", async () => {
    // The whole reason this capability serves only the caller's own face: it has no notion of who may
    // see whom, so any id-addressed route it invented would be an existence oracle.
    const ada = await signIn("ada@test.com");
    const grace = await signIn("grace@test.com");
    await updateUser(grace.token, { image: RASTER });
    const res = await fetchImage(ada.token);
    // Ada gets her own answer — nothing — rather than Grace's face.
    expect(res.status).toBe(404);
  });
});

describe("the person's own read", () => {
  test("hands back the column's value, not a URL, so a restating write round-trips", async () => {
    // `/get-session` is the read. A URL here would have the next name change POST that URL back as the
    // picture, and the column refuses it.
    const { token } = await signIn("ada@test.com");
    await updateUser(token, { image: RASTER, name: "Ada" });
    const session = await buildApp().request(
      "/auth/get-session",
      { headers: { authorization: `Bearer ${token}` } },
      appEnv(),
    );
    const body = await session.json<{ user: { name: string; image: string } }>();
    expect(body.user.image).toBe(RASTER);

    // Read, change the name, write the whole record back. The picture survives.
    expect((await updateUser(token, { name: "Ada Lovelace", image: body.user.image })).status).toBe(200);
    expect(await storedImageOf((await signIn("ada@test.com")).userId)).toBe(RASTER);
  });
});

describe("a row the rule would not accept today", () => {
  // **The regression this pins, found by the tenancy capability's roster (#563).** The gate makes it
  // impossible for the kit to *write* an unacceptable picture. It says nothing about one that is
  // already there — a provider wrote it before the rule existed, a repair script put it there, a backup
  // restored it. If the column refused such a value on read, `getUsers` would throw for a whole page of
  // rows because of one of them, and every operator would lose the roster over somebody else's row.
  //
  // So the column is permissive and the *projection* is where the value stops. A bad row draws initials.
  test("does not take the roster down with it", async () => {
    const ada = await signIn("ada@test.com");
    const grace = await signIn("grace@test.com");
    await updateUser(grace.token, { image: RASTER });
    // Straight past every validator, the way a repair script would.
    await env.DB.prepare("update pithy_auth_users set image = ? where id = ?")
      .bind("data:text/html;base64,PHNjcmlwdD4=", ada.userId)
      .run();

    const roster = await getUsers(authDatabase(env.DB), [ada.userId, grace.userId]);
    expect(roster.size).toBe(2);
    expect(roster.get(ada.userId)?.image).toBe("data:text/html;base64,PHNjcmlwdD4=");
  });

  test("and the projection is what refuses it, so nothing renders it", async () => {
    // The second half, and the half that matters: permissive at the column only buys a readable roster
    // if the value cannot reach a page from there.
    expect(userImageSource("data:text/html;base64,PHNjcmlwdD4=", "/auth/profile/image", new Date(1))).toBeNull();
  });

  test("the write still refuses the same value, so the column cannot gain another", async () => {
    const { token } = await signIn("ada@test.com");
    expect((await updateUser(token, { image: "data:text/html;base64,PHNjcmlwdD4=" })).status).toBe(400);
  });
});
