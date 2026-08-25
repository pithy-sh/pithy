// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { D1Database } from "@cloudflare/workers-types";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { turnstileSecretsRegistry } from "@pithy-sh/turnstile/src/secret/registry";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { AuthConfig, type AuthWiring } from "../capability";
import { publishSameOrigin } from "../http/csrf";
import { createSessionMiddleware } from "../http/middleware";
import { createRateLimitMiddleware } from "../http/rateLimit";
import { createAuthRoutes } from "../http/routes";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";

/**
 * A real auth Worker on a real port, for the live suites (#84).
 *
 * The live E2E questions this package has are about an **origin**: which `redirect_uri` Better Auth
 * hands Google, whether a token posted from a browser survives the humanity gate, whether a callback
 * arriving with a forged `state` sets a cookie. None of those are answerable inside the workers pool,
 * which has no listening socket and therefore no port a redirect URI could name; and none are
 * answerable against a hand-built Better Auth instance either, because the thing under test is the
 * route stack the capability composes — the turnstile gate on two paths and not a third, the CSRF
 * publication, the rate limiter — rather than the instance underneath it.
 *
 * So this boots the real stack in Node:
 *
 * - **Miniflare supplies D1**, from Node rather than from inside a worker. Two databases, as a deployed
 *   worker has: `DB` for the `pithy_auth_*` and `pithy_email_*` tables, `SECRETS` for the encrypted
 *   rows every secret is read from (#153). No plaintext binding stands in for either.
 * - **The migrations are the real ones**, run through the real registry and runner.
 * - **`node:http` gives the port.** Vitest's `fetch` reaches the app the way a browser would, so an
 *   `Origin` header is a real one and a `Set-Cookie` is a real one.
 *
 * It reaches Cloudflare for nothing. What is live in a suite built on this is the third party the suite
 * names — Google's token endpoint, Turnstile's siteverify — and nothing else.
 */

/** The registry these suites resolve through: auth's slice plus turnstile's, since one route stacks the gate. */
export const LIVE_REGISTRY = { ...authSecretsRegistry, ...turnstileSecretsRegistry };

/** Unconfigure the module-scoped shared secrets store. For the end of a file, never for one app's close. */
export function resetLiveSecrets(): void {
  resetSharedSecrets();
}

/** Tables the app database holds once both capabilities' migrations have run. */
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

/**
 * The session secret these suites sign with.
 *
 * A fixed throwaway rather than a random one, so a failure is reproducible; it authenticates nothing
 * anywhere, and it is not a value the fixture report or an error message ever carries.
 */
const SESSION_SECRET = "live-e2e-secret-please-rotate-000000";

/** An email job the app wrote: which template, and to whom. The body is never read — it carries a token. */
export interface EnqueuedEmail {
  /** The job's template — `magic-link`, `otp`, … as `pithy_email_jobs` recorded it. */
  template: string;
  /** The recipient address. */
  to: string;
}

/** What a suite may change about the app it boots. Everything else is the capability's own default. */
export interface LiveAppOptions {
  /**
   * The mount path, **always stated**.
   *
   * `AuthConfig` defaults it to `/auth`, and that default is precisely what a live suite must not lean
   * on: every `redirect_uri` registered with an OAuth provider embeds this path, so moving it silently
   * invalidates all of them at once, and a suite that took the default could not tell that it had moved.
   * Required here, so the pin is in the suite where its reader can see it.
   */
  basePath: string;
  /** Whether Google is enabled. When true, `google` credentials must be supplied. */
  google?: { clientId: string; clientSecret: string } | undefined;
  /** When set, the turnstile gate is composed at this widget mode, exactly as `auth.compose` stacks it. */
  turnstile?: { mode: "visible" | "invisible"; secretKey: string } | undefined;
  /**
   * The `ENVIRONMENT` var this Worker is stamped with, as `pithy init` writes into every wrangler
   * stanza. `dev` by default, because that is what these suites are: a developer's machine, running the
   * stack the way `pithy dev` does.
   *
   * It is an option because one thing now reads it — the turnstile gate refuses a Cloudflare test key
   * outside dev and staging (#374) — so a suite has to be able to say it is prod to prove that.
   */
  environment?: string;
}

/** A booted app: where it listens, what it was pinned to, and what it recorded. */
export interface LiveApp {
  /** The origin the app is actually serving on — `http://localhost:<port>`, port assigned by the OS. */
  origin: string;
  /** The mount path the suite pinned. Every asserted URL is composed from this, never from a literal. */
  basePath: string;
  /** The OAuth callback URL for a provider, composed from this run's origin and pinned base path. */
  callbackUrl(provider: string): string;
  /** Every audit event the app emitted, in order. */
  events: AuditEventInput[];
  /** Read the email jobs the app enqueued — the evidence a gated route did or did not reach its handler. */
  enqueued(): Promise<EnqueuedEmail[]>;
  /**
   * The one-time code this app last mailed to an address, read out of the job payload.
   *
   * **What it is for is a signed-in browser.** A suite about a route that needs a session has to get
   * one the way a reader does — ask for a code, then post it back — and the code exists nowhere a
   * browser can see it. Reading the enqueued job is the harness standing in for the mailbox, and it is
   * the only stand-in available: no Workflow runs here, so nothing is ever delivered or redacted.
   *
   * `null` when nothing was mailed to that address, which is a suite asserting on a send that never
   * happened rather than a code that was blank.
   */
  mailedOtp(to: string): Promise<string | null>;
  /** Stop the server and dispose the runtime. Always from a `finally` or an `afterAll`. */
  close(): Promise<void>;
}

/**
 * Boot the auth Worker on an ephemeral port.
 *
 * The caller owns the teardown: `close()` stops the listener and disposes Miniflare, and a suite that
 * forgets leaves a workerd process behind.
 */
export async function startLiveApp(options: LiveAppOptions): Promise<LiveApp> {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: "DB", SECRETS: "SECRETS" },
  });
  const db = (await miniflare.getD1Database("DB")) as unknown as D1Database;
  const secretsDb = (await miniflare.getD1Database("SECRETS")) as unknown as D1Database;

  const env: Record<string, unknown> = {
    DB: db,
    SECRETS: secretsDb,
    SECRETS_ENCRYPTION_KEYS: devEncryptionKeys(),
    // What a Worker knows about itself (`core/src/worker/identity`), stamped as the scaffold stamps it.
    ENVIRONMENT: options.environment ?? "dev",
    // The tier-1 edge limiter's binding. Always allows: these suites are about the gate below it, and a
    // limiter that denied would make a failure read as a bug in the thing under test.
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) } satisfies RateLimit,
  };

  await migrate(db);

  const fixture: SecretFixture<typeof LIVE_REGISTRY> = { "auth-session-secret": SESSION_SECRET };
  if (options.google) fixture["auth-google-credentials"] = options.google;
  if (options.turnstile) {
    fixture["turnstile-secret-keys"] = { [options.turnstile.mode]: { key: options.turnstile.secretKey } };
  }
  configureSharedSecrets({ registry: LIVE_REGISTRY });
  await seedSecrets(env as unknown as SecretsStoreEnv, LIVE_REGISTRY, fixture);

  const events: AuditEventInput[] = [];
  const server = createServer();
  const origin = await listen(server);

  const emailCapability = email({ fromAddress: "no@reply.test", fromName: "Live E2E", baseUrl: origin });
  const wiring: AuthWiring = {
    config: AuthConfig.parse({
      baseURL: origin,
      basePath: options.basePath,
      trustedOrigins: [origin],
      google: { enabled: Boolean(options.google) },
    }),
    enqueueEmail: emailCapability.enqueue,
    turnstile: options.turnstile ? { mode: options.turnstile.mode } : undefined,
  };

  const app = buildApp(wiring, events);
  server.on("request", (request, response) => {
    void serve(app, env, origin, request, response);
  });

  return {
    origin,
    basePath: options.basePath,
    callbackUrl: (provider) => `${origin}${options.basePath}/callback/${provider}`,
    events,
    enqueued: async () => {
      const rows = await db.prepare("select template, to_address from pithy_email_jobs order by rowid").all();
      return (rows.results as { template: string; to_address: string }[]).map((row) => ({
        template: row.template,
        to: row.to_address,
      }));
    },
    mailedOtp: async (to) => {
      const row = await db
        .prepare(
          "select payload from pithy_email_jobs where to_address = ? and template = 'otp' order by rowid desc limit 1",
        )
        .bind(to)
        .first<{ payload: string }>();
      if (!row) return null;
      const parsed: unknown = JSON.parse(row.payload);
      const code = typeof parsed === "object" && parsed !== null ? (parsed as { code?: unknown }).code : undefined;
      return typeof code === "string" ? code : null;
    },
    close: async () => {
      // Deliberately **not** `resetSharedSecrets()`. That configuration is module-scoped, as it is in a
      // worker isolate, so a suite running two apps at once — one pinned at `/auth`, one at `/identity`
      // — would have the second's teardown unconfigure the first, and every later request to it would
      // answer 500. The configuration holds a registry and no values; each app resolves its own secrets
      // from its own `SECRETS` D1 through its own env, so sharing it costs nothing. `resetLiveSecrets`
      // is there for a suite that wants the module clean at the end.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await miniflare.dispose();
    },
  };
}

/** Run auth's and email's real migrations against a fresh database. */
async function migrate(db: D1Database): Promise<void> {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await db.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: { "0001_init": auth_0001_init } },
    { database: "app", namespace: "email", order: 200, migrations: { "0001_init": email_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a migration provider for database "app"');
  await runMigrations(db, provider);
}

/**
 * The capability's middleware order, mirrored: same-origin publication, the tier-1 limiter, session
 * resolution, then the routes.
 *
 * Mirrored rather than obtained from `auth().compose()` because composing the capability needs a
 * `pithy.config.ts`, a project on disk and a CLI to resolve it. The order here is the order
 * `capability.ts` registers, and `routeContract.test.ts` is what holds that claim honest.
 */
function buildApp(wiring: AuthWiring, events: AuditEventInput[]): Hono<PithyHonoEnv> {
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
  return app;
}

/** Listen on an OS-assigned port and answer with the origin that names it. */
function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://localhost:${address.port}`);
    });
  });
}

/** Hand one Node request to the Hono app and write back what it answered. */
async function serve(
  app: Hono<PithyHonoEnv>,
  env: Record<string, unknown>,
  origin: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const answer = await app.fetch(await toRequest(request, origin), env);
    // `getSetCookie()` and not `headers.forEach`: a response carrying two cookies has two headers of
    // the same name, and folding them into one comma-joined value is how a session cookie arrives
    // unparseable at a client that would otherwise have accepted it.
    const headers: [string, string][] = [];
    for (const [key, value] of answer.headers) if (key.toLowerCase() !== "set-cookie") headers.push([key, value]);
    for (const cookie of answer.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
    response.writeHead(answer.status, headers);
    response.end(answer.body ? Buffer.from(await answer.arrayBuffer()) : undefined);
  } catch (cause) {
    // A throw here is a defect in the harness, never a result. Answering 500 silently would let a suite
    // read a harness crash as the app denying a request, which is the exact confusion these tests exist
    // to remove — so the reason goes on the wire.
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(`live harness failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** A Node request as a Web `Request`, body and all. */
async function toRequest(request: IncomingMessage, origin: string): Promise<Request> {
  const method = request.method ?? "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(key, one);
  }
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(request) : undefined;
  return new Request(new URL(request.url ?? "/", origin), { method, headers, body });
}

/** Collect a request body. */
function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
