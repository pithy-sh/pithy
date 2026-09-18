// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { publishSameOrigin } from "../http/csrf";
import { createSessionMiddleware } from "../http/middleware";
import { NEUTRAL_PROVIDER_REFUSAL, PROVIDER_REFUSAL_CODES } from "../http/providerRefusal";
import { createRateLimitMiddleware } from "../http/rateLimit";
import { createAuthRoutes } from "../http/routes";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { PROVIDER_SIGN_IN_REFUSAL_REASONS } from "./providerSignInGate";
import { authSecretsRegistry } from "./secrets";

/**
 * The four rows of provider sign-in, driven end to end against a real instance over real D1 (#625).
 *
 * **Rows 1 and 2 are the thing this change must not break, so they are asserted first and per provider.**
 * A magic-link user who presses Google — or GitHub, or Facebook — and whose provider-verified address
 * matches their account is linked and signed in on the first attempt. Rows 3 and 4 must become one
 * answer, decided before Better Auth branches, and the proof of *that* is a byte diff of two full
 * responses that differ in exactly one thing: whether a user row exists at the address.
 *
 * ## How four providers are driven without four OAuth apps
 *
 * Real everything except the third party:
 *
 * - **Real state.** `POST /auth/sign-in/social` is dispatched first and the `state` is taken off the
 *   authorize URL it answers with, with the signed state cookie carried back exactly as a browser would.
 *   A hand-built state does not survive `parseState`, which is the point of the round trip.
 * - **Real routes, real D1, real encrypted secrets, real migrations.**
 * - **The providers' own resolvers.** `globalThis.fetch` answers each provider's token endpoint and its
 *   profile endpoints and nothing else — any other host throws, so a resolver quietly reaching the
 *   network fails the case rather than passing it slowly. Google's id-token decode, Facebook's
 *   access-token-owner check against `debug_token`, GitHub's `/user` + `/user/emails` pair all run for
 *   real, which is what makes the effective `emailVerified` this suite reads the effective one.
 *
 * **All four the kit serves, and not a list of two.** The gate wraps whatever is on `ctx.socialProviders`,
 * so the claim "every provider" is only worth what it is driven against — google, apple, facebook and
 * github, each through its own resolver, each with its own account subject and issuer.
 *
 * **Facebook is the case that would not survive a shortcut.** Its `/me` profile carries no
 * `email_verified` field at all — the stub omits it deliberately, because Facebook's really does — so a
 * gate reading the raw payload would conclude unverified and refuse. It signs in only because
 * `mapProfileToUser` forces the flag inside the provider's own `getUserInfo`, which is what the wrapper
 * reads. Facebook's row-2 case is that plant, standing — reverting the predicate to the raw payload
 * reddens it, and GitHub's with it, since GitHub's profile carries no such field either.
 */

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
  "auth-google-credentials": { clientId: "google-client", clientSecret: "google-secret" },
  "auth-facebook-credentials": { clientId: "facebook-client", clientSecret: "facebook-secret" },
  "auth-github-credentials": { clientId: "github-client", clientSecret: "github-secret" },
  "auth-apple-credentials": { clientId: "apple-client", clientSecret: "apple-secret" },
};

/** Where a sign-in lands, and where a refusal lands. Distinct, so a redirect says which happened. */
const CALLBACK_URL = "http://localhost/app";
const ERROR_CALLBACK = "http://localhost/sign-in";

/** The address the whole suite turns on. One constant, so two runs differ in exactly one thing: the row. */
const ADDRESS = "member@example.test";

/** What the caller's browser says it is. Asserted on the denial row, never on the wire. */
const CALLER_AGENT = "pithy-suite/625";

/** An identity a provider asserts on one callback. */
interface Identity {
  /** The provider's own stable subject — what `accountSubject` reads and the account row is keyed on. */
  subject: string;
  /** The address the provider hands over. */
  address: string;
  /**
   * Whether the provider reports the address as verified.
   *
   * Facebook has no such field to report; see {@link ProviderUnderTest.reachesRowThree}. The value is
   * still honored wherever the provider has somewhere to put it, so one table drives all four.
   */
  verified: boolean;
}

/** One stubbed third party: which endpoints it answers, and what it says on each. */
interface ProviderUnderTest {
  /** The provider id, as Better Auth and the config both spell it. */
  id: string;
  /**
   * Whether an unverified address at this provider can reach row 3 at all — the issue's own matrix, as
   * an executable claim rather than a table in prose.
   *
   * `false` for three of the four, for two different reasons. **Google and Apple** are in
   * `trustedProviders` (`./auth.ts`), which short-circuits the verified half of the linking gate.
   * **Facebook** is not, and behaves as though it were: `mapProfileToUser` forces `emailVerified: true`
   * with the reason written beside it, because its OAuth response carries no such claim and its Graph
   * API exposes no such field. Each is asserted below rather than assumed, so the day one of those two
   * mechanisms is removed this suite says which.
   */
  reachesRowThree: boolean;
  /** The endpoints this provider's own resolver calls, and the bodies they answer with. */
  routes: (identity: Identity) => { prefix: string; body: unknown }[];
}

/** base64url of a JSON value, for the unsigned id token Google's resolver decodes (it never verifies it). */
function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PROVIDERS: readonly ProviderUnderTest[] = [
  {
    id: "github",
    reachesRowThree: true,
    routes: (identity) => [
      {
        prefix: "https://github.com/login/oauth/access_token",
        body: { access_token: "gho_test", token_type: "bearer", scope: "user:email" },
      },
      {
        prefix: "https://api.github.com/user/emails",
        body: [{ email: identity.address, primary: true, verified: identity.verified }],
      },
      {
        prefix: "https://api.github.com/user",
        body: { id: identity.subject, name: "Someone", login: "someone", avatar_url: null },
      },
    ],
  },
  {
    id: "google",
    reachesRowThree: false,
    routes: (identity) => [
      {
        prefix: "https://oauth2.googleapis.com/token",
        body: {
          access_token: "ya29.test",
          token_type: "bearer",
          id_token: [
            b64url({ alg: "RS256", kid: "k" }),
            b64url({
              sub: identity.subject,
              email: identity.address,
              email_verified: identity.verified,
              name: "Someone",
              picture: "https://example.test/avatar.png",
            }),
            "not-a-signature",
          ].join("."),
        },
      },
    ],
  },
  {
    id: "apple",
    reachesRowThree: false,
    routes: (identity) => [
      {
        prefix: "https://appleid.apple.com/auth/token",
        body: {
          access_token: "apple.test",
          token_type: "bearer",
          id_token: [
            b64url({ alg: "RS256", kid: "k" }),
            b64url({
              sub: identity.subject,
              email: identity.address,
              email_verified: identity.verified,
              name: "Someone",
            }),
            "not-a-signature",
          ].join("."),
        },
      },
    ],
  },
  {
    id: "facebook",
    // The trap. Its OAuth response carries no `email_verified` claim and the Graph API exposes no such
    // field, so the stub below omits it exactly as Facebook does — and the kit asserts the address as
    // verified in `mapProfileToUser` instead.
    reachesRowThree: false,
    routes: (identity) => [
      {
        prefix: "https://graph.facebook.com/v24.0/oauth/access_token",
        body: { access_token: "fb-test", token_type: "bearer" },
      },
      {
        prefix: "https://graph.facebook.com/debug_token",
        body: { data: { is_valid: true, app_id: "facebook-client", user_id: identity.subject } },
      },
      {
        prefix: "https://graph.facebook.com/me",
        body: {
          id: identity.subject,
          name: "Someone",
          email: identity.address,
          picture: { data: { url: "https://example.test/avatar.png" } },
        },
      },
    ],
  },
];

function appEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) } satisfies RateLimit,
  };
}

/** What a suite run varies about the app it builds. Everything else is the capability's own default. */
interface AppOptions {
  /** The per-provider sign-up policy, applied to all three. `true` is the kit's default. */
  allowSignUp?: boolean;
  /**
   * An adopter's own GitHub resolver, or `undefined` for the kit's.
   *
   * The kit's own resolver drops the address entirely when GitHub reports the primary unverified, so it
   * cannot express row 3 — `#554`'s documented seam is what an adopter uses to build a wider ladder, and
   * it is the shape that reaches the linking gate with an unverified address.
   */
  githubUserInfo?: AuthWiring["resolveGithubUserInfo"];
}

function buildWiring(options: AppOptions): AuthWiring {
  const emailCap = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" });
  const toggle = { enabled: true, allowSignUp: options.allowSignUp ?? true };
  return {
    config: AuthConfig.parse({
      baseURL: "http://localhost",
      basePath: "/auth",
      trustedOrigins: ["http://localhost"],
      google: toggle,
      apple: toggle,
      facebook: toggle,
      github: toggle,
      plugins: [],
    }),
    resolveGithubUserInfo: options.githubUserInfo,
    enqueueEmail: emailCap.enqueue,
    turnstile: undefined,
  };
}

/** One booted app: the Hono stack `capability.ts` composes, plus the trail it wrote. */
interface App {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  events: AuditEventInput[];
}

function buildApp(options: AppOptions = {}): App {
  const wiring = buildWiring(options);
  const events: AuditEventInput[] = [];
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    if (c.get("emit") === undefined) {
      c.set("emit", async (event) => {
        events.push(event);
      });
    }
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  publishSameOrigin(wiring)(app);
  app.use(`${wiring.config.basePath}/*`, createRateLimitMiddleware(wiring.config.rateLimiterBinding));
  createSessionMiddleware(wiring)(app);
  createAuthRoutes(wiring)(app);
  return {
    request: async (path, init) => await app.request(path, init, appEnv()),
    events,
  };
}

/** Answer this provider's endpoints for this identity, and throw on every other host. */
function stubProvider(provider: ProviderUnderTest, identity: Identity): void {
  const routes = provider.routes(identity);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const route = routes.find((candidate) => url.startsWith(candidate.prefix));
    if (!route) throw new Error(`the callback reached ${url}; this suite stubs ${provider.id} and nothing else`);
    return Response.json(route.body);
  });
}

/** Everything a browser could read off one callback, plus what the Worker recorded about it. */
interface Outcome {
  status: number;
  location: string | null;
  /** Every response header, lowercased and sorted, with `set-cookie` listed separately. */
  headers: [string, string][];
  cookies: string[];
  body: string;
  events: AuditEventInput[];
}

/** Cookie header value from a response's `Set-Cookie` list — name=value pairs only, as a browser sends. */
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function outcomeOf(response: Response, body: string, events: AuditEventInput[]): Outcome {
  const headers: [string, string][] = [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") headers.push([name.toLowerCase(), value]);
  }
  headers.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    status: response.status,
    location: response.headers.get("location"),
    headers,
    cookies: response.headers.getSetCookie(),
    body,
    events,
  };
}

/**
 * Drive one whole provider sign-in: start it, take the state, come back with a code.
 *
 * `redirect: "manual"` is not decoration — both the answer and the oracle live in the `Location` header,
 * and a followed redirect would leave the case asserting on the adopter's screen instead.
 */
async function signInWith(
  app: App,
  provider: ProviderUnderTest,
  identity: Identity,
  options: { additionalData?: Record<string, unknown>; errorCallbackURL?: string } = {},
): Promise<Outcome> {
  stubProvider(provider, identity);
  const before = app.events.length;
  const started = await app.request("/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({
      provider: provider.id,
      callbackURL: CALLBACK_URL,
      errorCallbackURL: options.errorCallbackURL ?? ERROR_CALLBACK,
      ...(options.additionalData ? { additionalData: options.additionalData } : {}),
    }),
  });
  if (started.status !== 200) throw new Error(`sign-in/social answered ${started.status}: ${await started.text()}`);
  const authorize = (await started.json<{ url?: string }>()).url;
  if (!authorize) throw new Error("sign-in/social answered no authorize URL");
  const state = new URL(authorize).searchParams.get("state");
  if (!state) throw new Error("the authorize URL carried no state");

  const response = await app.request(`/auth/callback/${provider.id}?code=the-code&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    // A user agent on every callback, because a denial row that cannot be counted per caller is most of
    // what a trail of refused sign-ins is for — and `getUserInfo` has no request to read one from.
    headers: { cookie: cookieHeader(started), "user-agent": CALLER_AGENT },
  });
  return outcomeOf(response, await response.text(), app.events.slice(before));
}

/** Seed one user row, as passwordless sign-up writes it unless `verified` says otherwise. */
async function seedUser(address: string, verified = true): Promise<string> {
  const id = `user-${address}-${verified ? "v" : "u"}`;
  await env.DB.prepare(
    "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, "Member", address, verified ? 1 : 0, Date.now(), Date.now())
    .run();
  return id;
}

/** The account rows this provider identity owns, for asserting a link actually happened. */
async function accountsFor(providerId: string): Promise<{ user_id: string; account_id: string }[]> {
  const rows = await env.DB.prepare("select user_id, account_id from pithy_auth_accounts where provider_id = ?")
    .bind(providerId)
    .all();
  return rows.results as { user_id: string; account_id: string }[];
}

/** How many sessions exist. A sign-in mints one; a refusal mints none. */
async function sessionCount(): Promise<number> {
  const row = await env.DB.prepare("select count(*) as n from pithy_auth_sessions").first<{ n: number }>();
  return row?.n ?? -1;
}

/** Empty every table a run writes to, without dropping and re-migrating between cases. */
async function clearRows(): Promise<void> {
  for (const table of ["pithy_auth_sessions", "pithy_auth_accounts", "pithy_auth_users", "pithy_auth_verifications"]) {
    await env.DB.prepare(`delete from ${table}`).run();
  }
}

/** The reason the trail recorded for a refusal, or `undefined` when no denial was recorded at all. */
function deniedReason(outcome: Outcome): unknown {
  const denial = outcome.events.find((event) => event.action === "auth/signin" && event.outcome === "denied");
  return (denial?.metadata as { reason?: unknown } | undefined)?.reason;
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
  vi.unstubAllGlobals();
  resetSharedSecrets();
});

/**
 * Rows 1 and 2, per provider. **The most important thing in this file.**
 *
 * Breaking either is a regression rather than a hardening, and the reason it is driven per provider is
 * that the flag each one reports comes from a different place: Google's id-token claim, GitHub's
 * per-address flag from the emails API, and Facebook's — which does not exist, and is asserted by the kit.
 */
describe.each(PROVIDERS)("$id, the two rows that sign somebody in", (provider) => {
  test("row 2: a magic-link user whose provider-verified address matches is linked and signed in, first attempt", async () => {
    const userId = await seedUser(ADDRESS);
    const app = buildApp();

    const outcome = await signInWith(app, provider, { subject: "subject-1", address: ADDRESS, verified: true });

    // Sent to the application, not to the refusal screen, with a session cookie on it.
    expect(outcome.location).toBe(CALLBACK_URL);
    expect(outcome.cookies.join("\n")).toContain("session_token");
    expect(await sessionCount()).toBe(1);
    // Linked to the account that already existed — not a second, empty user beside it (#554).
    expect(await accountsFor(provider.id)).toEqual([{ user_id: userId, account_id: "subject-1" }]);
  });

  test("row 1: the second press signs in on the identity alone, at an address with no account here", async () => {
    const userId = await seedUser(ADDRESS);
    const app = buildApp();
    await signInWith(app, provider, { subject: "subject-1", address: ADDRESS, verified: true });

    // A different address, and one no user row holds — so without row 1 this would be a *sign-up*
    // minting a second, empty user beside the real account, which is #554 exactly. Row 1 reads the
    // identity and never the address, which is what keeps an `allowDifferentEmails` link signing in
    // once it has been made.
    const again = await signInWith(app, provider, {
      subject: "subject-1",
      address: "moved@example.test",
      verified: true,
    });

    expect(again.location).toBe(CALLBACK_URL);
    expect(await accountsFor(provider.id)).toEqual([{ user_id: userId, account_id: "subject-1" }]);
    const users = await env.DB.prepare("select count(*) as n from pithy_auth_users").first<{ n: number }>();
    expect(users?.n).toBe(1);
  });

  test("a verified address with no account and sign-up permitted is still an ordinary sign-up", async () => {
    // The fatal mispredict, planted against: a gate that refused whenever neither row 1 nor row 2 held
    // would turn every first provider sign-up into a refusal on the kit's default configuration.
    const app = buildApp();

    const outcome = await signInWith(app, provider, { subject: "subject-new", address: ADDRESS, verified: true });

    expect(outcome.location).toBe(CALLBACK_URL);
    const users = await env.DB.prepare("select email from pithy_auth_users").all();
    expect(users.results).toEqual([{ email: ADDRESS }]);
  });
});

/**
 * Row 1 again, with the flag the gate is *not* allowed to read.
 *
 * GitHub only, and not because the rule is GitHub's: the kit's own resolver answers with no address at
 * all when GitHub reports the primary unverified (`./githubUserInfo.ts`), so the other two providers
 * cannot express "attached identity, unverified address" without an adopter's seam. This one can, and it
 * is the case that separates "row 1 reads the account row" from "row 1 reads the address too".
 */
describe("github, an attached identity whose address the provider will not vouch for", () => {
  test("still signs in — row 1 reads neither the address nor the flag", async () => {
    const github = PROVIDERS[0];
    if (!github) throw new Error("expected the github provider descriptor");
    const userId = await seedUser(ADDRESS);
    const attached = buildApp({ allowSignUp: false });
    await signInWith(attached, github, { subject: "subject-1", address: ADDRESS, verified: true });

    const unverified = buildApp({
      allowSignUp: false,
      githubUserInfo: async () => ({
        user: { email: "moved@example.test", emailVerified: false, name: "Someone" },
        data: { id: "subject-1", name: "Someone", login: "someone", avatar_url: null },
      }),
    });
    const again = await signInWith(unverified, github, {
      subject: "subject-1",
      address: "moved@example.test",
      verified: false,
    });

    expect(again.location).toBe(CALLBACK_URL);
    expect(await accountsFor("github")).toEqual([{ user_id: userId, account_id: "subject-1" }]);
  });
});

/**
 * The issue's provider matrix, asserted rather than restated.
 *
 * Three of the four cannot reach row 3, and it matters that they cannot: if one of them *did*, the
 * predicate would have to refuse a sign-in that works today. Google and Apple are trusted, so the
 * verified half of the linking gate is short-circuited; Facebook is not trusted and behaves as though it
 * were, because `./auth.ts` forces the flag through `mapProfileToUser`. Either way the answer is a
 * sign-in, not a refusal, on an address the provider will not vouch for.
 */
describe.each(PROVIDERS.filter((provider) => !provider.reachesRowThree))(
  "$id cannot reach row 3, and this is what that means",
  (provider) => {
    test("an unverified address still links and signs in when an account matches", async () => {
      const userId = await seedUser(ADDRESS);
      const outcome = await signInWith(buildApp({ allowSignUp: false }), provider, {
        subject: "subject-unverified",
        address: ADDRESS,
        verified: false,
      });

      expect(outcome.location).toBe(CALLBACK_URL);
      expect(await accountsFor(provider.id)).toEqual([{ user_id: userId, account_id: "subject-unverified" }]);
    });
  },
);

/**
 * Rows 3 and 4, and the whole acceptance criterion: **one answer, whether or not the account exists.**
 *
 * The two shapes that reach the fork are driven per provider where they can be:
 *
 * - **A local row the provider cannot vouch for.** `requireLocalEmailVerified` defaults true, so a user
 *   row with `emailVerified: false` fails row 2 for *every* provider, trusted ones included — which is
 *   the corner the issue names and the only one that puts Google and Facebook on this fork at all.
 * - **An address the provider reports unverified**, which only GitHub can report and only through an
 *   adopter's own resolver, since the kit's drops the address entirely rather than return it unverified.
 */
const REFUSALS = [
  {
    label: "a local row the provider cannot vouch for",
    allowSignUp: false,
    providers: PROVIDERS,
    githubUserInfo: undefined,
    verified: true,
    localVerified: false,
  },
  {
    label: "an address the provider reports unverified",
    allowSignUp: true,
    providers: PROVIDERS.filter((provider) => provider.reachesRowThree),
    githubUserInfo: async () => ({
      user: { email: ADDRESS, emailVerified: false, name: "Someone" },
      data: { id: 4242, name: "Someone", login: "someone", avatar_url: null },
    }),
    verified: false,
    localVerified: true,
  },
] as const;

describe.each(REFUSALS)("$label", ({ allowSignUp, providers, githubUserInfo, verified, localVerified }) => {
  /** One refusal, driven with the row and then without it, on a database cleared in between. */
  async function bothSides(provider: ProviderUnderTest): Promise<{ matched: Outcome; unmatched: Outcome }> {
    const options: AppOptions = { allowSignUp, githubUserInfo };
    await seedUser(ADDRESS, localVerified);
    const matched = await signInWith(buildApp(options), provider, {
      subject: "subject-x",
      address: ADDRESS,
      verified,
    });
    await clearRows();
    const unmatched = await signInWith(buildApp(options), provider, {
      subject: "subject-x",
      address: ADDRESS,
      verified,
    });
    return { matched, unmatched };
  }

  test.each(providers)("$id answers byte-identically either way — status, every header, body", async (provider) => {
    const { matched, unmatched } = await bothSides(provider);

    // Both really were refusals sent to the refusal screen, and neither minted a session.
    expect(matched.location).toContain(ERROR_CALLBACK);
    expect(unmatched.location).toContain(ERROR_CALLBACK);
    expect(await sessionCount()).toBe(0);

    expect(unmatched.status).toBe(matched.status);
    expect(unmatched.headers).toEqual(matched.headers);
    expect(unmatched.cookies).toEqual(matched.cookies);
    expect(unmatched.body).toEqual(matched.body);
    expect(unmatched.body.length).toBe(matched.body.length);
  });

  test.each(providers)("$id never produces either revealing code at all", async (provider) => {
    const { matched, unmatched } = await bothSides(provider);

    for (const [label, outcome] of [
      ["an address with an account", matched],
      ["an address with none", unmatched],
    ] as const) {
      expect(outcome.location).toBe(`${ERROR_CALLBACK}?error=${NEUTRAL_PROVIDER_REFUSAL}`);
      for (const leaked of PROVIDER_REFUSAL_CODES) {
        expect(`${label}: ${outcome.location}`).not.toContain(leaked);
      }
      expect(outcome.location).not.toContain("error_description");
      // **The proof that the codes were never produced, rather than scrubbed afterwards.** If Better
      // Auth had reached its branch, `../http/providerRefusal` would have collapsed the header *and*
      // recorded the dependency's own code as the reason. The trail carries the gate's own word instead,
      // which only the gate can write, and it is written before the branch is reachable.
      expect(deniedReason(outcome)).not.toBe("account_not_linked");
      expect(deniedReason(outcome)).not.toBe("signup_disabled");
    }
  });

  test.each(providers)("$id keeps the true reason server-side, where it belongs", async (provider) => {
    const { matched, unmatched } = await bothSides(provider);

    // The half an adopter's own middleware could only have thrown away: the browser gets one code, and
    // the trail still says which of the two refusals it really was.
    expect([deniedReason(matched), deniedReason(unmatched)]).toEqual([
      PROVIDER_SIGN_IN_REFUSAL_REASONS.accountExists,
      PROVIDER_SIGN_IN_REFUSAL_REASONS.noAccount,
    ]);

    // And it is attributable. `getUserInfo` is handed the OAuth tokens and nothing else, so this only
    // arrives because `../http/resolve.ts` threads the request's headers into the instance it builds.
    for (const outcome of [matched, unmatched]) {
      const denial = outcome.events.find((event) => event.action === "auth/signin" && event.outcome === "denied");
      expect(denial?.userAgent).toBe(CALLER_AGENT);
    }
  });
});

/**
 * The redirect the gate builds, measured against one the dependency builds.
 *
 * `getUserInfo` is not handed the endpoint context, so the gate constructs the `FOUND` APIError that
 * `ctx.redirect` would have constructed. That is a mirror of `oauth2/errors.mjs`'s concatenation, and a
 * mirror nobody checks is the second definition this repo keeps being bitten by. So it is checked: a
 * refusal the dependency still emits on the same route — `email_not_found`, from `callback.mjs:205`,
 * which the kit's own GitHub resolver fails closed to — is driven beside one the gate emits, and the two
 * `Location` headers must differ in nothing but the code.
 */
describe("the refusal leaves by the same door the dependency's own refusals leave by", () => {
  test("the Location differs from a dependency-built one in the error code and nothing else", async () => {
    const github = PROVIDERS[0];
    if (!github) throw new Error("expected the github provider descriptor");

    // The dependency's: the kit's own resolver returns no address for an unverified primary, so
    // `callback.mjs` answers `email_not_found` through `redirectOnError`.
    const dependency = await signInWith(buildApp(), github, {
      subject: "subject-a",
      address: ADDRESS,
      verified: false,
    });

    // The gate's: a local row it cannot vouch for, so rows 3/4 are reached.
    await seedUser(ADDRESS, false);
    const gate = await signInWith(buildApp({ allowSignUp: false }), github, {
      subject: "subject-b",
      address: ADDRESS,
      verified: true,
    });

    expect(dependency.location).toBe(`${ERROR_CALLBACK}?error=email_not_found`);
    expect(gate.location).toBe(`${ERROR_CALLBACK}?error=${NEUTRAL_PROVIDER_REFUSAL}`);
    expect(gate.status).toBe(dependency.status);
    // The same headers by name, and the same cookies — a refusal built without the endpoint context must
    // not quietly drop something the dependency's own redirect carries.
    expect(gate.headers.map(([name]) => name)).toEqual(dependency.headers.map(([name]) => name));
    expect(gate.cookies).toEqual(dependency.cookies);
  });

  test("an errorCallbackURL that already carries a query is appended to, not overwritten", async () => {
    // The `?`/`&` half of the same mirror. `../http/errorCallbackUrl` guarantees the value the state
    // holds is one the kit would have produced, so this is the shape that actually arrives.
    await seedUser(ADDRESS, false);
    const github = PROVIDERS[0];
    if (!github) throw new Error("expected the github provider descriptor");
    const outcome = await signInWith(
      buildApp({ allowSignUp: false }),
      github,
      { subject: "subject-c", address: ADDRESS, verified: true },
      { errorCallbackURL: `${ERROR_CALLBACK}?provider=github` },
    );

    expect(outcome.location).toBe(`${ERROR_CALLBACK}?provider=github&error=${NEUTRAL_PROVIDER_REFUSAL}`);
  });
});

/**
 * The gate keys on `state.link`, and that field is the caller's to try to forge.
 *
 * `generateState` spreads the caller's `additionalData` onto the state object **first** and assigns
 * `link` afterwards (`oauth2/state.mjs:22-32`), so a sign-in overwrites an injected `link` with
 * `undefined` and `JSON.stringify` drops it. That is one line of a dependency holding up a security
 * property, so it is planted against rather than cited.
 */
describe("a forged link in the caller's own additionalData", () => {
  test("does not buy a pass through the gate", async () => {
    const userId = await seedUser(ADDRESS, false);
    const github = PROVIDERS[0];
    if (!github) throw new Error("expected the github provider descriptor");

    const outcome = await signInWith(
      buildApp({ allowSignUp: false }),
      github,
      { subject: "subject-forged", address: ADDRESS, verified: true },
      { additionalData: { link: { email: ADDRESS, userId } } },
    );

    expect(outcome.location).toBe(`${ERROR_CALLBACK}?error=${NEUTRAL_PROVIDER_REFUSAL}`);
    expect(await accountsFor("github")).toEqual([]);
    expect(await sessionCount()).toBe(0);
  });
});

/**
 * Flow 1, unchanged: linking from inside the account, where the address is irrelevant.
 *
 * Signed in as one address, press "connect GitHub", GitHub certifies another. Both sides are proven at
 * that moment — they authenticated as the account and they just authenticated with the provider — and
 * `allowDifferentEmails` is the deliberate hold that permits it (`./auth.ts`). The gate must not touch
 * it, and the mechanism it does not touch it by is the `state.link` branch above.
 */
describe("linking from inside the account", () => {
  test("still links a provider whose address does not match the account's", async () => {
    const app = buildApp({ allowSignUp: false });
    const github = PROVIDERS[0];
    if (!github) throw new Error("expected the github provider descriptor");
    await seedUser(ADDRESS);

    // A session the way a reader gets one: ask for a code, read it out of the enqueued job, post it back.
    const sent = await app.request("/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: ADDRESS, type: "sign-in" }),
    });
    expect(sent.status).toBe(200);
    const job = await env.DB.prepare(
      "select payload from pithy_email_jobs where to_address = ? and template = 'otp' order by rowid desc limit 1",
    )
      .bind(ADDRESS)
      .first<{ payload: string }>();
    const code = (JSON.parse(job?.payload ?? "{}") as { code?: string }).code;
    expect(typeof code).toBe("string");

    const signedIn = await app.request("/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: ADDRESS, otp: code }),
    });
    expect(signedIn.status).toBe(200);
    const session = cookieHeader(signedIn);

    // Now link a GitHub identity whose address is somebody else's entirely. Verified at GitHub, because
    // that is the boundary `./githubUserInfo.ts` holds on *both* flows — the address is irrelevant here,
    // the flag is not, and Better Auth's own `if (link)` branch refuses an untrusted provider that did
    // not vouch for one (`callback.mjs:164`). What this case is about is the address.
    stubProvider(github, { subject: "subject-link", address: "other@example.test", verified: true });
    const started = await app.request("/auth/link-social", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost", cookie: session },
      body: JSON.stringify({ provider: "github", callbackURL: CALLBACK_URL }),
    });
    expect(started.status).toBe(200);
    const authorize = (await started.json<{ url?: string }>()).url ?? "";
    const state = new URL(authorize).searchParams.get("state") ?? "";

    const linked = await app.request(`/auth/callback/github?code=the-code&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: [session, cookieHeader(started)].filter(Boolean).join("; ") },
    });

    expect(linked.headers.get("location")).toBe(CALLBACK_URL);
    expect(await accountsFor("github")).toEqual([
      { user_id: "user-member@example.test-v", account_id: "subject-link" },
    ]);
  });
});

/**
 * The corner the issue asked to be handled or proven unreachable: a local row with `emailVerified: false`.
 *
 * It is handled — the gate mirrors `requireLocalEmailVerified`, which is what the refusal table above
 * drives for all three providers. This asserts the other half of the answer: the kit's own doors cannot
 * create such a row, so the mirror is belt to the argument's braces rather than the only thing holding it.
 */
describe("a local row the provider cannot vouch for is not something the kit's own doors can write", () => {
  test("a passwordless sign-up writes a verified row", async () => {
    const app = buildApp();
    const address = "fresh@example.test";
    await app.request("/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: address, type: "sign-in" }),
    });
    const job = await env.DB.prepare(
      "select payload from pithy_email_jobs where to_address = ? and template = 'otp' order by rowid desc limit 1",
    )
      .bind(address)
      .first<{ payload: string }>();
    const code = (JSON.parse(job?.payload ?? "{}") as { code?: string }).code;
    const signedIn = await app.request("/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: address, otp: code }),
    });
    expect(signedIn.status).toBe(200);

    const row = await env.DB.prepare("select email_verified from pithy_auth_users where email = ?")
      .bind(address)
      .first<{ email_verified: number }>();
    expect(row?.email_verified).toBe(1);
  });

  test("a social sign-up cannot write an unverified one either — the kit's create hook refuses it", async () => {
    // `isUnverifiedSignup` (`./auth.ts`) is the guard. With the gate in front of it the attempt is
    // refused earlier, which is the point: either way no unverified row is created.
    const github = PROVIDERS[0];
    if (!github) throw new Error("expected the github provider descriptor");
    const outcome = await signInWith(
      buildApp({
        githubUserInfo: async () => ({
          user: { email: "unverified@example.test", emailVerified: false, name: "Someone" },
          data: { id: 99, name: "Someone", login: "someone", avatar_url: null },
        }),
      }),
      github,
      { subject: "subject-unverified", address: "unverified@example.test", verified: false },
    );

    expect(outcome.location).toBe(`${ERROR_CALLBACK}?error=${NEUTRAL_PROVIDER_REFUSAL}`);
    const users = await env.DB.prepare("select count(*) as n from pithy_auth_users").first<{ n: number }>();
    expect(users?.n).toBe(0);
  });
});
