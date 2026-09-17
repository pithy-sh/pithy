// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { publishSameOrigin } from "./csrf";
import { createSessionMiddleware } from "./middleware";
import { NEUTRAL_PROVIDER_REFUSAL, PROVIDER_REFUSAL_CODES } from "./providerRefusal";
import { createRateLimitMiddleware } from "./rateLimit";
import { createAuthRoutes } from "./routes";

/**
 * The enumeration oracle on the social callback, measured end to end (#625).
 *
 * **This suite refuses to look at a unit.** The claim is about what leaves the Worker on a real refusal,
 * and the two facts it separates are decided three modules down in a dependency — so the only honest
 * question is *drive a refused callback twice and diff the two responses*. Once with a seeded user row at
 * the provider-resolved address, once with none. Byte-identical, or the oracle is open.
 *
 * ## How a callback is driven without GitHub
 *
 * Three real things and one stub:
 *
 * - **Real state.** `POST /auth/sign-in/social` is dispatched first, and the `state` is read off the
 *   authorize URL it answers with. Better Auth wrote that state into `pithy_auth_verifications` in the
 *   real D1, so the callback parses it the way it parses a genuine one. A hand-built state does not
 *   survive `parseState`, which is the point of taking the round trip.
 * - **Real routes, real D1, real encrypted secrets.** The same stack `capability.ts` composes.
 * - **A stubbed token endpoint.** `globalThis.fetch` answers GitHub's `/login/oauth/access_token` and
 *   nothing else. A request to any other host throws, so a resolver quietly reaching the network would
 *   fail the case rather than pass it slowly.
 * - **The kit's own `resolveGithubUserInfo` seam** supplies the identity, exactly as an adopter's would.
 *   `emailVerified: false` is the issue's scenario verbatim: an address sitting unverified on somebody's
 *   GitHub, which is what routes the attempt to the linking gate instead of to a link.
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
  "auth-github-credentials": { clientId: "gh-client", clientSecret: "gh-secret" },
};

/** The address the provider asserts. One constant, so the two runs differ in exactly one thing: the row. */
const PROVIDER_EMAIL = "victim@example.test";

/** Where a refusal is sent — an adopter's own screen, as `#554` tells adopters to configure. */
const ERROR_CALLBACK = "http://localhost/sign-in?provider=github";

function appEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) } satisfies RateLimit,
  };
}

function buildWiring(onResolved: () => void, allowSignUp: boolean): AuthWiring {
  const emailCap = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" });
  return {
    config: AuthConfig.parse({
      baseURL: "http://localhost",
      basePath: "/auth",
      trustedOrigins: ["http://localhost"],
      // The provider's sign-up policy is the suite's one variable. See `POLICIES`.
      github: { enabled: true, allowSignUp },
    }),
    // The provider hands over one unverified address. Better Auth trusts a resolver verbatim, so this is
    // the whole of what the callback knows about the caller.
    resolveGithubUserInfo: async () => {
      onResolved();
      return {
        user: { email: PROVIDER_EMAIL, emailVerified: false, name: "Someone" },
        data: { id: 4242, name: "Someone", login: "someone", avatar_url: null },
      };
    },
    enqueueEmail: emailCap.enqueue,
    turnstile: undefined,
  };
}

function buildApp(wiring: AuthWiring, emit: AuditEmit): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    if (c.get("emit") === undefined) c.set("emit", emit);
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  publishSameOrigin(wiring)(app);
  app.use(`${wiring.config.basePath}/*`, createRateLimitMiddleware(wiring.config.rateLimiterBinding));
  createSessionMiddleware(wiring)(app);
  createAuthRoutes(wiring)(app);
  return app;
}

/** GitHub's token endpoint, and nothing else. Any other host is a defect in the case, so it throws. */
function stubTokenEndpoint(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return Response.json({ access_token: "gho_test", token_type: "bearer", scope: "user:email" });
    }
    throw new Error(`the callback reached out to ${url}; this suite calls nothing but the token endpoint`);
  });
}

/** Seed one user row at the provider-resolved address — the only difference between the two runs. */
async function seedUser(): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
  )
    .bind("user-seeded", "Someone", PROVIDER_EMAIL, 1, Date.now(), Date.now())
    .run();
}

/** What a refused callback actually put on the wire. Everything a browser could read. */
interface Refusal {
  status: number;
  location: string | null;
  body: string;
  events: AuditEventInput[];
  /**
   * How many times the callback asked the provider seam who signed in.
   *
   * **The precondition every case asserts, and it exists because this suite once passed without it.**
   * A callback driven without the state cookie is refused at `parseState` — before the token exchange,
   * before the identity, before the linking gate — and answers `?error=state_mismatch` for a seeded
   * address and an unseeded one alike. Byte-identical, and about nothing. Exactly one resolution is
   * what says the run got as far as the decision under test, and it is decided by neither side of the
   * fix, so it stays honest afterwards.
   */
  resolved: number;
}

/**
 * Drive one refused social sign-in the whole way round: start it, take the state, come back with a code.
 *
 * `redirect: "manual"` is not decoration — the oracle is in the `Location` header, and a followed
 * redirect would leave the case asserting on the adopter's screen instead of on what the Worker said.
 */
async function refusedCallback(allowSignUp: boolean): Promise<Refusal> {
  const events: AuditEventInput[] = [];
  let resolved = 0;
  const wiring = buildWiring(() => {
    resolved += 1;
  }, allowSignUp);
  const app = buildApp(wiring, async (event) => {
    events.push(event);
  });

  const started = await app.request(
    "/auth/sign-in/social",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        provider: "github",
        callbackURL: "http://localhost/app",
        errorCallbackURL: ERROR_CALLBACK,
      }),
    },
    appEnv(),
  );
  if (started.status !== 200) throw new Error(`sign-in/social answered ${started.status}`);
  const authorize = (await started.json<{ url?: string }>()).url;
  if (!authorize) throw new Error("sign-in/social answered no authorize URL");
  const state = new URL(authorize).searchParams.get("state");
  if (!state) throw new Error("the authorize URL carried no state");

  // The state cookie travels back, because a browser's would. Better Auth checks the signed `state`
  // cookie against the query parameter before it will parse the state at all (`state.mjs:133`), so a
  // callback driven without it never reaches the linking gate — it answers `state_mismatch`, which is
  // identical for both runs and would pass the diff while proving nothing.
  const cookies = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

  const response = await app.request(
    `/auth/callback/github?code=the-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers: { cookie: cookies } },
    appEnv(),
  );
  return {
    status: response.status,
    location: response.headers.get("location"),
    body: await response.text(),
    events,
    resolved,
  };
}

/** One run with a matching user row, one without — a fresh database between them. */
async function bothRefusals(allowSignUp: boolean): Promise<{ matched: Refusal; unmatched: Refusal }> {
  await seedUser();
  const matched = await refusedCallback(allowSignUp);
  await env.DB.prepare("delete from pithy_auth_users").run();
  await env.DB.prepare("delete from pithy_auth_verifications").run();
  const unmatched = await refusedCallback(allowSignUp);
  // Both runs reached the decision under test. See `Refusal.resolved`.
  expect({ matched: matched.resolved, unmatched: unmatched.resolved }).toEqual({ matched: 1, unmatched: 1 });
  return { matched, unmatched };
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
  stubTokenEndpoint();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSharedSecrets();
});

/**
 * The two sign-up policies, because they produce two different oracles out of the same attack.
 *
 * With sign-up refused the pair is Better Auth's own `account_not_linked` / `signup_disabled`, which is
 * what #625 reports. With sign-up permitted — the **default**, and the configuration most projects are
 * on — the no-row side never reaches `signup_disabled` at all: it goes on to create a user, and the
 * kit's own `user.create.before` hook refuses it with `EMAIL_NOT_VERIFIED` and a whole sentence of
 * `error_description`. Same question, same two answers, different spelling. The issue cleared that code
 * as "the provider's own state"; it is, and being able to read it is still ours.
 *
 * Running the identical assertions over both is what makes this a gate on the rule rather than on the
 * two strings the issue happened to name.
 */
const POLICIES = [
  {
    label: "sign-up refused (#554's recommended configuration)",
    allowSignUp: false,
    /** What the trail must still be able to tell apart, matched row first. */
    reasons: ["account_not_linked", "signup_disabled"],
  },
  {
    label: "sign-up permitted (the default)",
    allowSignUp: true,
    reasons: ["account_not_linked", "EMAIL_NOT_VERIFIED"],
  },
] as const;

describe.each(POLICIES)("a refused social sign-in, $label", ({ allowSignUp, reasons }) => {
  test("answers byte-identically whether or not the account exists — status, Location and body", async () => {
    const { matched, unmatched } = await bothRefusals(allowSignUp);

    // Both really were refusals sent to the adopter's screen, not a sign-in that happened to redirect.
    expect(matched.location).toContain(ERROR_CALLBACK);
    expect(unmatched.location).toContain(ERROR_CALLBACK);

    expect({ status: unmatched.status, location: unmatched.location, body: unmatched.body }).toEqual({
      status: matched.status,
      location: matched.location,
      body: matched.body,
    });
  });

  test("carries the neutral code and no rostered one, named individually so a regression says which", async () => {
    const { matched, unmatched } = await bothRefusals(allowSignUp);

    for (const [label, refusal] of [
      ["an address with an account", matched],
      ["an address with none", unmatched],
    ] as const) {
      for (const leaked of PROVIDER_REFUSAL_CODES) {
        expect(`${label}: ${refusal.location}`).not.toContain(leaked);
      }
      expect(refusal.location).toContain(`error=${NEUTRAL_PROVIDER_REFUSAL}`);
      // The description goes with the code. `EMAIL_NOT_VERIFIED` arrives carrying a full sentence of
      // `error_description`, and a sentence is a longer way to say the same thing the code did.
      expect(refusal.location).not.toContain("error_description");
    }
  });

  test("keeps the real reason server-side, where it belongs", async () => {
    const { matched, unmatched } = await bothRefusals(allowSignUp);

    // The trail tells the two apart, which is the half an adopter's own middleware could only throw
    // away: it sees the one code this Worker now sends, and has nothing left to record. Neither code
    // had ever reached `pithy_audit_events` before — a 302 is not a `DENIED_STATUSES` status.
    const reason = (refusal: Refusal): unknown => {
      const denial = refusal.events.find((event) => event.action === "auth/signin" && event.outcome === "denied");
      return (denial?.metadata as { reason?: unknown } | undefined)?.reason;
    };
    expect([reason(matched), reason(unmatched)]).toEqual([...reasons]);
  });
});
