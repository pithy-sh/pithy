// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { DEV_LOGIN_ROUTE } from "@pithy-sh/core/src/seed/devLogin";
import { EXAMPLE_ADA } from "@pithy-sh/core/src/seed/exampleIdentities";
import { parse } from "comment-json";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { runAdd } from "./capabilities/flow";
import { devLoginUrl, readDevLogin, seededLoginLines } from "./dev/devLogin";
import { provisionFeature } from "./feature/provision";
import { featureSecretsPath } from "./feature/secrets";
import { migrateProject } from "./migrations/run";
import { resolveWorkersFor } from "./project/composeFor";
import { loadWorkerConfig } from "./project/config";
import { scaffoldProject } from "./project/scaffold";
import { projectCapabilities } from "./project/workerScope";
import { featureConfigPath } from "./provision/featureConfig";
import type { ResourceProvisioner, ResourceProvisioners } from "./provision/resources";
import { devPreferencesPath } from "./seed/prepare";
import { seedProject } from "./seed/run";

/**
 * **The goal of #643, run end to end: after `pithy provision --feature`, `pithy deploy --env feature` and
 * `pithy seed --env feature`, a person can sign in to the feature deployment.**
 *
 * ## What is real, and what stands in
 *
 * Real: a scaffolded project that composes `auth` (and its prerequisites `secrets` and `email`) exactly as
 * `pithy add auth --with-prerequisites` writes it; `provisionFeature`, with the real migrations and the real seed
 * behind it; the generated feature config; the Worker, composed from its own `pithy.config.ts` through
 * `createEntrypoint`, with an env built **only from the generated feature stanza** — every var, every D1 id,
 * every Secrets Store binding — the way `wrangler deploy --env feature` hands a script its bindings.
 *
 * Standing in for Cloudflare, at its seams and nowhere else: the resource provisioners hand out ids, each D1 id
 * is a Miniflare database, and the Secrets Store is a map whose entries the Worker's bindings resolve. No account
 * is reached; the credentials are unset for every unit test.
 *
 * Node-side, like `project/scaffoldBoot.test.ts` and for its reason: a Worker composing `better-auth` pulls an
 * optional `@opentelemetry/api` import no bundler in this repository resolves. So the one runtime fact workerd
 * adds is stated here instead — under `nodejs_compat`, a deployed Worker's `process.env` is its vars, which is
 * where `ENVIRONMENT`, `BASE_URL` and `CI` are read at composition.
 *
 * ## The sign-in, both ways
 *
 * - **dev-login**: the link `pithy seed --env feature` prints answers `302` with the `__Secure-` session cookie
 *   Better Auth reads over https, and `get-session` with that cookie answers the seeded user.
 * - **magic link**: a request is accepted, not `404 secrets/not_found`.
 *
 * And the plant: the same run with the secret handoff broken — nothing sealed into the feature's database —
 * signs nobody in, by either route.
 */

const PROJECT = "replay";
const WORKER = "board";
const identity: FeatureIdentity = { project: PROJECT, issue: "643", slug: "feature-address" };
const SCRIPT = "replay-f643-feature-address-board";
const ORIGIN = `https://${SCRIPT}.acme.workers.dev`;

/** Every kit package the composed Worker imports, linked the way a working checkout is. */
const LINKED = ["core", "auth", "email", "secrets", "turnstile", "audit", "cloudflare"];
const REPO = resolve(import.meta.dirname, "..", "..", "..");

/** More ids than any run here asks for. Miniflare binds databases by name up front, so the pool is fixed. */
const D1_POOL = ["D1_1", "D1_2", "D1_3", "D1_4", "D1_5", "D1_6"];

let dir: string;
let workerDir: string;

/**
 * Scaffolded **inside `packages/cli`**, as `scaffoldBoot.test.ts` is: vitest transforms a TypeScript config only
 * under the project root, and this test loads the scaffolded `pithy.config.ts` for real.
 */
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", ".e2e-feature-signin-"));
  await scaffoldProject({ targetDir: dir, appName: PROJECT, worker: WORKER });
  workerDir = join(dir, "apps", WORKER);
  const scope = join(dir, "node_modules", "@pithy-sh");
  await rm(scope, { recursive: true, force: true });
  await mkdir(scope, { recursive: true });
  for (const pkg of LINKED) await symlink(join(REPO, "packages", pkg), join(scope, pkg));
  await runAdd({
    account: null,
    projectDir: dir,
    workerDir,
    worker: WORKER,
    project: PROJECT,
    capability: "auth",
    withPrerequisites: true,
    migrate: async () => [],
  });
  // The opt-in the dev-session set reads, per machine: sign in as Ada.
  const preferences = devPreferencesPath(PROJECT);
  await mkdir(dirname(preferences), { recursive: true });
  await writeFile(preferences, JSON.stringify({ user: EXAMPLE_ADA.email }));
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** An in-memory provisioner handing out ids from the pool, as the real adapter finds or creates by name. */
function provisioner(pool: string[]): ResourceProvisioner {
  const names = new Map<string, string>();
  return {
    find: async (name) => (names.has(name) ? { id: names.get(name) as string } : null),
    create: async (name) => {
      const id = pool.shift();
      if (id === undefined) throw new Error("the D1 pool is exhausted");
      names.set(name, id);
      return { id };
    },
    delete: async () => {},
  };
}

/** One feature environment on the stand-in account: its databases, its store, and the three commands. */
async function featureEnvironment(options: { handoff: boolean }) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: Object.fromEntries(D1_POOL.map((id) => [id, id])),
  });
  const databases = new Map<string, D1Database>();
  for (const id of D1_POOL) databases.set(id, (await miniflare.getD1Database(id)) as unknown as D1Database);
  const database = (id: string): D1Database => {
    const found = databases.get(id);
    if (!found) throw new Error(`no stand-in database ${id}`);
    return found;
  };
  const remoteD1 = ({ databaseId }: { databaseId: string }) => database(databaseId);
  const entries = new Map<string, string>();
  const store = {
    storeId: "store-1",
    exists: async (name: string) => entries.has(name),
    put: async (name: string, value: string) => void entries.set(name, value),
    remove: async (name: string) => entries.delete(name),
  };
  const kv = provisioner([]);
  const provisioners = { d1: provisioner([...D1_POOL]), kv, r2: kv } as unknown as ResourceProvisioners;

  /** `pithy seed --env feature`, with the account's subdomain answered and nothing else reached. */
  const seed = () =>
    seedProject({
      account: null,
      project: PROJECT,
      projectDir: dir,
      env: "feature",
      yes: true,
      json: true,
      includeExamples: true,
      remoteD1,
      workersSubdomain: async () => "acme",
      featureIdentity: async () => identity,
    });

  // `pithy provision --feature`: resources, the generated config, the feature's own secrets, migrate, seed.
  await provisionFeature({
    projectDir: dir,
    capabilities: projectCapabilities(await resolveWorkersFor("feature", { projectDir: dir })),
    identity,
    provisioners,
    store,
    administersItself: false,
    workersSubdomain: async () => "acme",
    migrate: async ({ env, projectDir }) => {
      await migrateProject({ env, projectDir, project: PROJECT, account: null, remoteD1 });
    },
    seed: async () => {
      await seed();
    },
    // The planted failure: with no database handed over, nothing is sealed where the Worker reads it.
    ...(options.handoff ? { secretsDatabase: database } : {}),
  });

  // `pithy seed --env feature`, after the deploy, as the goal runs it.
  await seed();

  return { miniflare, entries, database };
}

/**
 * The Worker `wrangler deploy --env feature` would run: its own config, composed, with an env built from the
 * generated feature stanza and nothing else.
 */
async function deployedWorker(env: { entries: Map<string, string>; database: (id: string) => D1Database }) {
  const generated = parse(await readFile(featureConfigPath(workerDir), "utf8")) as unknown as {
    env: {
      feature: {
        name: string;
        vars: Record<string, string>;
        d1_databases: { binding: string; database_id: string }[];
        secrets_store_secrets: { binding: string; secret_name: string }[];
        ratelimits?: { name: string }[];
        workflows?: { binding: string }[];
      };
    };
  };
  const stanza = generated.env.feature;
  expect(stanza.name).toBe(SCRIPT);
  expect(stanza.vars.BASE_URL).toBe(ORIGIN);

  const bindings: Record<string, unknown> = { ...stanza.vars };
  for (const entry of stanza.d1_databases) bindings[entry.binding] = env.database(entry.database_id);
  for (const entry of stanza.secrets_store_secrets) {
    bindings[entry.binding] = {
      get: async () => {
        const value = env.entries.get(entry.secret_name);
        if (value === undefined) throw new Error(`no store entry ${entry.secret_name}`);
        return value;
      },
    };
  }
  for (const entry of stanza.ratelimits ?? []) bindings[entry.name] = { limit: async () => ({ success: true }) };
  const started: unknown[] = [];
  for (const entry of stanza.workflows ?? []) {
    bindings[entry.binding] = { create: async (options: unknown) => void started.push(options) };
  }
  // **Not from the stanza, and said so.** A generated feature stanza starts every list of entries empty and
  // nothing writes a feature's `workflows` or `ratelimits` back in, so it binds neither `EMAIL_SENDER` nor
  // `AUTH_RATE_LIMITER`, and `validateBindings` refuses every request. That gap is outside #643 and reported
  // there; these two stand in for it so the sign-in path itself is what this test exercises.
  bindings.EMAIL_SENDER ??= { create: async (options: unknown) => void started.push(options) };
  bindings.AUTH_RATE_LIMITER ??= { limit: async () => ({ success: true }) };

  // Under `nodejs_compat` a deployed Worker's `process.env` is its vars — and there is no `CI` in Cloudflare.
  for (const [name, value] of Object.entries(stanza.vars)) vi.stubEnv(name, value);
  vi.stubEnv("CI", "");
  // Fresh: the config computes its origin as it loads, from the environment just stated.
  const worker = createEntrypoint(await loadWorkerConfig(workerDir, { fresh: true }));
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return {
    fetch: (request: Request) => worker.fetch(request, bindings, ctx),
    started,
  };
}

describe("a feature deployment, after provision, deploy and seed", () => {
  test("signs a person in: dev-login sets a session, and a magic link is accepted", async () => {
    const env = await featureEnvironment({ handoff: true });
    try {
      const worker = await deployedWorker(env);

      // The login `pithy seed --env feature` wrote, and the link it prints.
      const login = await readDevLogin(dir, "feature");
      expect(login?.origin).toBe(ORIGIN);
      if (!login) throw new Error("no feature dev login was seeded");
      const url = devLoginUrl(ORIGIN, login.claim);
      expect(seededLoginLines(login, new Date())).toEqual([
        `Dev login: ${EXAMPLE_ADA.email} — open ${url} to sign in.`,
      ]);
      expect(url.startsWith(`${ORIGIN}${DEV_LOGIN_ROUTE}?`)).toBe(true);

      const opened = await worker.fetch(new Request(url));
      expect(opened.status).toBe(302);
      const cookie = (opened.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
      expect(cookie.startsWith("__Secure-better-auth.session_token=")).toBe(true);

      // Signed in: the deployment's own session endpoint knows who this is.
      const session = await worker.fetch(new Request(`${ORIGIN}/auth/get-session`, { headers: { cookie } }));
      expect(session.status).toBe(200);
      expect(((await session.json()) as { user?: { email?: string } } | null)?.user?.email).toBe(EXAMPLE_ADA.email);

      // And the other way in: a magic link is accepted, and its email is on its way.
      const magic = await worker.fetch(
        new Request(`${ORIGIN}/auth/sign-in/magic-link`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ email: EXAMPLE_ADA.email }),
        }),
      );
      expect({ status: magic.status, body: await magic.json() }).toEqual({ status: 200, body: { status: true } });
      expect(worker.started.length).toBe(1);

      // The value the Worker checked is the one kept at provision, in the file keyed by project and feature.
      expect(await readFile(featureSecretsPath(identity), "utf8")).toContain("auth-session-secret");
    } finally {
      await env.miniflare.dispose();
    }
  }, 240_000);

  test("with the secret handoff broken, nobody signs in — by either route", async () => {
    const env = await featureEnvironment({ handoff: false });
    try {
      const worker = await deployedWorker(env);
      const login = await readDevLogin(dir, "feature");
      if (!login) throw new Error("no feature dev login was seeded");

      const opened = await worker.fetch(new Request(devLoginUrl(ORIGIN, login.claim)));
      expect(opened.status).not.toBe(302);
      expect(opened.headers.get("Set-Cookie")).toBeNull();

      const magic = await worker.fetch(
        new Request(`${ORIGIN}/auth/sign-in/magic-link`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ email: EXAMPLE_ADA.email }),
        }),
      );
      expect(magic.status).toBe(404);
      expect(((await magic.json()) as { error?: { code?: string } }).error?.code).toBe("secrets/not_found");
    } finally {
      await env.miniflare.dispose();
    }
  }, 240_000);
});
