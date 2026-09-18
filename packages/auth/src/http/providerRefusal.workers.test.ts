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
import type { BetterAuthPlugin } from "better-auth";
import { oauthPopup } from "better-auth/plugins";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { PROVIDER_SIGN_IN_REFUSAL_REASONS } from "../instance/providerSignInGate";
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

function buildWiring(onResolved: () => void, allowSignUp: boolean, plugins: BetterAuthPlugin[] = []): AuthWiring {
  const emailCap = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" });
  return {
    config: AuthConfig.parse({
      baseURL: "http://localhost",
      basePath: "/auth",
      trustedOrigins: ["http://localhost"],
      // The provider's sign-up policy is the suite's one variable. See `POLICIES`.
      github: { enabled: true, allowSignUp },
      // Empty for every case but the popup one, which composes the adopter seam the guard has to cover.
      plugins,
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
async function refusedCallback(allowSignUp: boolean, errorCallbackURL: string = ERROR_CALLBACK): Promise<Refusal> {
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
        errorCallbackURL,
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
async function bothRefusals(
  allowSignUp: boolean,
  errorCallbackURL: string = ERROR_CALLBACK,
): Promise<{ matched: Refusal; unmatched: Refusal }> {
  await seedUser();
  const matched = await refusedCallback(allowSignUp, errorCallbackURL);
  await env.DB.prepare("delete from pithy_auth_users").run();
  await env.DB.prepare("delete from pithy_auth_verifications").run();
  const unmatched = await refusedCallback(allowSignUp, errorCallbackURL);
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
 * The two sign-up policies, run over the identical assertions so this is a gate on the rule rather than
 * on the strings any one configuration happens to produce.
 *
 * **They used to produce two different pairs, and now they produce none.** With sign-up refused the pair
 * was Better Auth's own `account_not_linked` / `signup_disabled`, which is what #625 reports; with
 * sign-up permitted — the default — the no-row side never reached `signup_disabled` at all but went on
 * to create a user, where the kit's own `user.create.before` hook refused it with `EMAIL_NOT_VERIFIED`
 * and a whole sentence of `error_description`. Same question, same two answers, different spelling.
 *
 * `../instance/providerSignInGate` now decides both before Better Auth branches, so on either policy
 * neither half of either pair is produced anywhere and the trail carries the gate's own word instead.
 * That is what {@link REASONS} is, and `../instance/providerSignInGate.workers.test.ts` is where the
 * claim "never produced at all" is asserted rather than inferred from a header.
 */
const REASONS = [PROVIDER_SIGN_IN_REFUSAL_REASONS.accountExists, PROVIDER_SIGN_IN_REFUSAL_REASONS.noAccount] as const;

const POLICIES = [
  {
    label: "sign-up refused (#554's recommended configuration)",
    allowSignUp: false,
    /** What the trail must still be able to tell apart, matched row first. */
    reasons: REASONS,
  },
  {
    label: "sign-up permitted (the default)",
    allowSignUp: true,
    reasons: REASONS,
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
    // away: it sees the one code this Worker now sends, and has nothing left to record. Neither
    // refusal had ever reached `pithy_audit_events` before — a 302 is not a `DENIED_STATUSES` status —
    // and the words are now the gate's, because the dependency's two codes are no longer produced.
    expect([deniedReason(matched), deniedReason(unmatched)]).toEqual([...reasons]);
  });
});

/** The reason the trail recorded for a refusal, or `undefined` if no denial was recorded at all. */
function deniedReason(refusal: Refusal): unknown {
  const denial = refusal.events.find((event) => event.action === "auth/signin" && event.outcome === "denied");
  return (denial?.metadata as { reason?: unknown } | undefined)?.reason;
}

/**
 * The two `errorCallbackURL` shapes that walked straight past the first fix.
 *
 * Both are the caller's own input — `POST /sign-in/social` takes the value and Better Auth stores it in
 * the state verbatim — so neither needed anything but a different request body. They are driven here
 * rather than only against the unit because the claim they refute is about what leaves the Worker: the
 * first version of this suite drove exactly one shape of `errorCallbackURL` and was green throughout.
 *
 * `allowSignUp: false` is #554's recommended configuration and the pair the issue names. One policy is
 * enough here — the policy axis is already covered above; what varies here is the header's shape.
 */
const BYPASSES = [
  {
    label: "a relative errorCallbackURL",
    // Permitted: `origin-check.mjs` passes `allowRelativePaths: true`, and `oauth2/state.mjs` keeps the
    // value as a plain string. The Location that comes back is relative, and a collapse that only
    // understood absolute URLs answered `undefined` — no rewrite, and no audit row either.
    errorCallbackURL: "/sign-in?provider=github",
    location: `/sign-in?provider=github&error=${NEUTRAL_PROVIDER_REFUSAL}`,
  },
  {
    label: "an errorCallbackURL normalized on the way in",
    // Round 3 (`./errorCallbackUrl`): this value never reaches Better Auth as sent. A trailing `?` is an
    // empty query the kit does not produce, so the guard hands on `http://localhost/sign-in` and the
    // refusal is appended to that. Driving it here is what proves the *rebuilt request* — new body, new
    // headers, same everything else — survives the whole round trip and still refuses correctly.
    errorCallbackURL: "http://localhost/sign-in?",
    location: `http://localhost/sign-in?error=${NEUTRAL_PROVIDER_REFUSAL}`,
  },
] as const;

describe.each(BYPASSES)("a refused social sign-in through $label", ({ errorCallbackURL, location }) => {
  test("still answers identically, still says nothing, and still reaches the trail", async () => {
    const { matched, unmatched } = await bothRefusals(false, errorCallbackURL);

    for (const [label, refusal] of [
      ["an address with an account", matched],
      ["an address with none", unmatched],
    ] as const) {
      // The exact header, not a substring: this is the shape the fix has to preserve as well as clean.
      expect(refusal.location, `${label} answered the wrong Location`).toBe(location);
      for (const leaked of PROVIDER_REFUSAL_CODES) {
        expect(`${label}: ${refusal.location}`).not.toContain(leaked);
      }
      expect(refusal.location).not.toContain("error_description");
    }

    expect({ status: unmatched.status, body: unmatched.body }).toEqual({ status: matched.status, body: matched.body });
    // The half a header rewrite loses. On the relative path nothing had been recorded at all.
    expect([deniedReason(matched), deniedReason(unmatched)]).toEqual([...REASONS]);
  });
});

/**
 * Round 3: the shape that walked past the output-side collapse, and the door that now stops it (#625).
 *
 * `errorCallbackURL: http://localhost/sign-in#x` answered
 * `…/sign-in#x?error=account_not_linked` for a seeded address and `…?error=signup_disabled` for an
 * unseeded one — the whole oracle, restored by one character. `redirectOnError` concatenates without
 * parsing, so the appended code landed inside the fragment, `collapseProviderRefusal` read
 * `searchParams` and found no `error`, and the header went out untouched with no audit row behind it.
 *
 * **That is a diagnosis, not a fourth entry for the bypass table.** Every input shape where the
 * dependency's concatenation and our parsing disagree is another one, and the parser cannot be patched
 * into knowing which shapes those are. So the value is guarded on the way *in*
 * (`./errorCallbackUrl`), and what cannot be normalized to a shape the kit would have produced is
 * refused at the door — before any state is minted, before the provider is contacted, before anything
 * is looked up.
 *
 * The cases are driven against the real instance and real D1, twice each, because "refused identically"
 * is a claim about what an attacker can observe and not about what a function returns.
 */
const DOOR = [
  {
    label: "a fragment, which swallowed the appended code whole",
    errorCallbackURL: "http://localhost/sign-in#x",
  },
  {
    label: "a bare trailing `#`, whose URL.hash reads empty and which does the same thing",
    errorCallbackURL: "http://localhost/sign-in#",
  },
  {
    label: "a fragment after a query",
    errorCallbackURL: "http://localhost/sign-in?p=github#x",
  },
  {
    label: "an `error` parameter planted ahead of the appended one",
    // Round 2 caught this at the other end, by putting every `error` value to the roster. It is closed
    // here too now: a URL that already answers this question is not one the kit would have produced.
    errorCallbackURL: "http://localhost/sign-in?error=access_denied",
  },
  {
    label: "a bare-relative path — round 2's own open question, answered end to end",
    // Unit-covered only until now. `matchesOriginPattern` rules on it at
    // `trusted-origins.mjs`: it does not start with `/`, so the relative branch is skipped;
    // `getProtocol` throws and returns null, `getOrigin` likewise, and `pattern === null` is false. So
    // Better Auth refused it 403 `INVALID_ERROR_CALLBACK_URL` — the right outcome reached by an origin
    // check that had no origin to check. The door refuses it first now, and says why.
    errorCallbackURL: "sign-in?provider=github",
  },
  {
    label: "a protocol-relative URL, which is another origin wearing a path's clothes",
    errorCallbackURL: "//evil.example/x",
  },
] as const;

/** What the caller can see of a started sign-in, plus whether any state was minted. */
interface Started {
  status: number;
  body: string;
  states: number;
}

/**
 * Start a social sign-in from a body written out by hand, and report only what the caller can see.
 *
 * The raw text matters: `startSignIn` below serializes an object, which can express neither of round
 * 4's shapes — a key spelled with a `\u` escape is the same key to `JSON.parse` and a different one to
 * `JSON.stringify`, and a form encoding is not JSON at all.
 */
async function startSignInWithBody(contentType: string, body: BodyInit): Promise<Started> {
  const wiring = buildWiring(() => {}, false);
  const app = buildApp(wiring, async () => {});
  const response = await app.request(
    "/auth/sign-in/social",
    { method: "POST", headers: { "content-type": contentType, origin: "http://localhost" }, body },
    appEnv(),
  );
  const states = await env.DB.prepare("select count(*) as n from pithy_auth_verifications").first<{ n: number }>();
  return { status: response.status, body: await response.text(), states: states?.n ?? -1 };
}

/** Start a social sign-in carrying one `errorCallbackURL`, in the ordinary JSON body a client sends. */
async function startSignIn(errorCallbackURL: string): Promise<Started> {
  return startSignInWithBody(
    "application/json",
    JSON.stringify({ provider: "github", callbackURL: "http://localhost/app", errorCallbackURL }),
  );
}

describe.each(DOOR)("an errorCallbackURL carrying $label", ({ errorCallbackURL }) => {
  test("is refused at the door, identically whether or not the address has an account", async () => {
    await seedUser();
    const matched = await startSignIn(errorCallbackURL);
    await env.DB.prepare("delete from pithy_auth_users").run();
    await env.DB.prepare("delete from pithy_auth_verifications").run();
    const unmatched = await startSignIn(errorCallbackURL);

    expect(matched.status).toBe(400);
    expect(unmatched).toEqual(matched);
    // Nothing was looked up, so nothing could have been said. The refusal names the field and no code.
    expect(matched.body).toContain("errorCallbackURL");
    for (const leaked of PROVIDER_REFUSAL_CODES) {
      expect(matched.body).not.toContain(leaked);
    }
  });

  test("never mints the state the callback would have carried it back in", async () => {
    // The strongest form of the claim: the flow does not start. There is no round trip to attack,
    // no provider redirect, and no stored `errorURL` for `redirectOnError` to concatenate onto.
    expect((await startSignIn(errorCallbackURL)).states).toBe(0);
  });
});

describe("the door narrows what reaches Better Auth without widening it", () => {
  test("an untrusted absolute origin is still refused, normalization or not", async () => {
    // Normalizing has to leave the origin check something to check. `https://evil.example/x` parses
    // cleanly and survives the guard unchanged — and Better Auth then refuses it, as it always did.
    const refused = await startSignIn("https://evil.example/x");
    expect(refused.status).toBe(403);
  });

  test("a shape the kit would have produced is passed through untouched and still works", async () => {
    // The guard must not be a second origin check, and must not cost a working configuration.
    const started = await startSignIn(ERROR_CALLBACK);
    expect(started.status).toBe(200);
    expect(started.states).toBeGreaterThan(0);
  });
});

/**
 * Round 4: the guard was reading the wrong bytes, so the door had a second entrance (#625).
 *
 * The value was guarded, but only for requests the guard recognized as carrying one — and it decided
 * that by looking at the **raw body text** for the literal field name and at the `content-type` for the
 * literal string `application/json`. Two spellings of the same request walked past both:
 *
 * - **A `\u` escape in the key.** JSON permits `\uXXXX` anywhere in a string, keys included, so
 *   `"errorCallbackURL"` is `errorCallbackURL` after `JSON.parse` and shares not one byte with it
 *   before. The substring test said no, the request went through untouched, and the fragment arrived
 *   at `redirectOnError` intact — the whole of round 3's oracle, restored by six characters.
 * - **Another media type better-call parses.** `getBody` reads a keyed body from `application/json`
 *   *and* from the `+json` structured-suffix family, from `application/x-www-form-urlencoded` and from
 *   `multipart/form-data`. A `content-type` test written as one substring covers one of the four.
 *
 * **These are the same defect in two places**: a cheap test standing in for the parse it was supposed
 * to precede. `errorCallbackUrlReach.workers.test.ts` holds the gate on the class — it measures the
 * dependency's reach and the guard's against each other, rather than listing today's two spellings.
 * These cases are the two spellings, driven the whole way, because the claim is about what an attacker
 * can send and not about what a function returns.
 */
const MULTIPART_BOUNDARY = "----pithy625";

function multipartBody(fields: Record<string, string>): string {
  const parts = Object.entries(fields).map(
    ([name, value]) => `--${MULTIPART_BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return `${parts.join("")}--${MULTIPART_BOUNDARY}--\r\n`;
}

/** The fragment of round 3, carried by a request the round-3 guard did not look inside. */
const SMUGGLED = "http://localhost/sign-in#";

const SMUGGLED_BODIES = [
  {
    label: "a JSON key spelled with a `\\u` escape, which is the same key after parsing",
    contentType: "application/json",
    body: `{"provider":"github","callbackURL":"http://localhost/app","\\u0065rrorCallbackURL":"${SMUGGLED}"}`,
  },
  {
    label: "a `+json` media type, which better-call parses as JSON by its structured suffix",
    contentType: "application/vnd.api+json",
    body: JSON.stringify({ provider: "github", callbackURL: "http://localhost/app", errorCallbackURL: SMUGGLED }),
  },
  {
    label: "a form-encoded body, whose fields better-call hands over as the same object",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      provider: "github",
      callbackURL: "http://localhost/app",
      errorCallbackURL: SMUGGLED,
    }).toString(),
  },
  {
    label: "a multipart body, likewise",
    contentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
    body: multipartBody({ provider: "github", callbackURL: "http://localhost/app", errorCallbackURL: SMUGGLED }),
  },
] as const;

describe.each(SMUGGLED_BODIES)("a fragment smuggled in $label", ({ contentType, body }) => {
  test("is refused at the door, naming the field, with no state minted", async () => {
    const refused = await startSignInWithBody(contentType, body);

    // A 400 from the guard, not a 415 from the dependency's media-type list. Three of these four are
    // media types Better Auth's own router happens to reject today, at the version pinned today, on
    // the routes it ships today — a plugin that widens `allowedMediaTypes` (its own
    // `device-authorization` does exactly that) makes them reachable without touching this package.
    // The guard is not permitted to depend on that list; this asserts it does not.
    expect({ status: refused.status, states: refused.states }).toEqual({ status: 400, states: 0 });
    expect(refused.body).toContain("errorCallbackURL");
    for (const leaked of PROVIDER_REFUSAL_CODES) {
      expect(refused.body).not.toContain(leaked);
    }
  });
});

describe("a body the guard now parses is still the body Better Auth is handed", () => {
  test("a form-encoded sign-in with a usable errorCallbackURL still starts, and still mints state", async () => {
    // The reach change must not cost a working request. Better Auth's router refuses this media type
    // on this route today, so what is asserted is that the *guard* let it past to be refused there —
    // not a 400 naming the field, and not a normalization that broke the encoding.
    const started = await startSignInWithBody(
      "application/x-www-form-urlencoded",
      new URLSearchParams({ provider: "github", callbackURL: "http://localhost/app", errorCallbackURL: "/sign-in" }),
    );
    expect(started.status).not.toBe(400);
    expect(started.body).not.toContain("errorCallbackURL cannot be used");
  });

  test("a JSON sign-in whose value needs normalizing still starts, and still mints state", async () => {
    const started = await startSignIn("http://localhost/sign-in?");
    expect({ status: started.status, minted: started.states > 0 }).toEqual({ status: 200, minted: true });
  });
});

/**
 * Round 5: the value also arrives in a query string, and the guard only read bodies (#625).
 *
 * `guardErrorCallbackURL` opened `if (!request.body) return request`. `better-auth/plugins`' own
 * `oauthPopup()` takes the field off a **GET** — `oauth-popup/index.mjs:143` stores
 * `errorURL: c.query.errorCallbackURL` — so the fragment walked in untouched and round 3's oracle came
 * back whole for anyone composing it.
 *
 * **The kit composes no such plugin, which is why this is driven rather than argued.** `AuthConfig.plugins`
 * is a documented seam and the plugin is the dependency's own. Composing it here is what an adopter does,
 * with the kit's real routes over real D1 either way — so what the cases assert is what that adopter's
 * Worker answers, not what a function returns.
 *
 * **Round 6 refuses this plugin at `auth()`, and these cases still stand.** They build their wiring from
 * `AuthConfig.parse` rather than `auth()`, so the composition gate is deliberately below them: what is
 * being measured here is the *query channel*, which belongs to better-call's router and not to one
 * plugin, and `oauthPopup()` is the readiest route in the tree that reads the field off a `GET`. Any
 * composed plugin may declare such a query. The reason that plugin is now refused is unrelated to this
 * one — it answers refusals through a response body — and lives in `../instance/refusalTransport`.
 */
const POPUP_ORIGIN = "http://localhost";

/** Start an OAuth popup through a composed `oauthPopup()`, with the field in the query where it reads it. */
async function startPopup(errorCallbackURL: string): Promise<Started> {
  const wiring = buildWiring(() => {}, false, [oauthPopup()]);
  const app = buildApp(wiring, async () => {});
  const query = new URLSearchParams({
    provider: "github",
    popupOrigin: POPUP_ORIGIN,
    callbackURL: "http://localhost/app",
    errorCallbackURL,
  });
  const response = await app.request(
    `/auth/oauth-popup/start?${query.toString()}`,
    { redirect: "manual", headers: { origin: POPUP_ORIGIN } },
    appEnv(),
  );
  const states = await env.DB.prepare("select count(*) as n from pithy_auth_verifications").first<{ n: number }>();
  return { status: response.status, body: await response.text(), states: states?.n ?? -1 };
}

describe("a fragment smuggled through the query, where an adopter's popup plugin reads it", () => {
  test("is refused at the door, naming the field, with no state minted", async () => {
    const refused = await startPopup("http://localhost/sign-in#");

    expect({ status: refused.status, states: refused.states }).toEqual({ status: 400, states: 0 });
    expect(refused.body).toContain("errorCallbackURL");
    for (const leaked of PROVIDER_REFUSAL_CODES) {
      expect(refused.body).not.toContain(leaked);
    }
  });

  test("a usable value in the same query still starts the flow, and still mints state", async () => {
    // The reach change must not cost a working request. This one goes the whole way: the plugin writes
    // its state row and answers the provider's authorize URL.
    const started = await startPopup("http://localhost/sign-in?provider=github");
    expect({ status: started.status, minted: started.states > 0 }).toEqual({ status: 302, minted: true });
  });

  test("a value needing only normalizing is normalized rather than refused", async () => {
    const started = await startPopup("http://localhost/sign-in?");
    expect({ status: started.status, minted: started.states > 0 }).toEqual({ status: 302, minted: true });
  });
});

/**
 * Round 5's other hole: two decoders where the dependency has one.
 *
 * better-call's branch predicates `includes()` the whole `content-type`, urlencoded first; the decode
 * that branch performs — `request.formData()` — dispatches on the media type's **essence**. A header
 * whose essence is multipart and which carries the urlencoded name in a parameter therefore sent both
 * programs into the urlencoded branch, where `formData()` found the field and the guard's
 * `new URLSearchParams(text)` did not.
 */
describe("a fragment smuggled behind a media type the two programs read differently", () => {
  test("is refused at the door, naming the field, with no state minted", async () => {
    const refused = await startSignInWithBody(
      `multipart/form-data; note=application/x-www-form-urlencoded; boundary=${MULTIPART_BOUNDARY}`,
      multipartBody({ provider: "github", callbackURL: "http://localhost/app", errorCallbackURL: SMUGGLED }),
    );
    expect({ status: refused.status, states: refused.states }).toEqual({ status: 400, states: 0 });
    expect(refused.body).toContain("errorCallbackURL");
    for (const leaked of PROVIDER_REFUSAL_CODES) {
      expect(refused.body).not.toContain(leaked);
    }
  });
});
