// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { configureSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { parse } from "comment-json";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { runAdd } from "./capabilities/flow";
import { FEATURE_HOSTS } from "./feature/hosts";
import { provisionFeature } from "./feature/provision";
import { migrateProject } from "./migrations/run";
import { resolveWorkersFor } from "./project/composeFor";
import { loadWorkerConfig } from "./project/config";
import { deployKitWorkers } from "./project/deployKit";
import { scaffoldProject } from "./project/scaffold";
import { projectCapabilities } from "./project/workerScope";
import { featureConfigPath } from "./provision/featureConfig";
import type { ResourceProvisioner, ResourceProvisioners } from "./provision/resources";
import type { SecretsStore } from "./provision/store";
import { seedProject } from "./seed/run";

/**
 * **The goal of #643, run end to end: after `pithy provision --feature` and `pithy deploy --env feature`, a
 * feature deployment sends a magic link, and opening that link signs the person in.**
 *
 * ## What is real, and what stands in
 *
 * Real: a scaffolded project that composes `auth` (and its prerequisites `secrets` and `email`) exactly as
 * `pithy add auth --with-prerequisites` writes it; `provisionFeature`, with the real migrations, the real seed and
 * the real kit-host pass behind it (`deployKitWorkers`, resolving email's committed template through the kit's
 * own registry); the generated feature config; the app Worker, composed from its own `pithy.config.ts` through
 * `createEntrypoint`; and the email host's own send path — `buildSendDeps` reading the host's env, `runSendBatch`
 * rendering and sending.
 *
 * **No binding is supplied by this test.** Both Workers' envs are built from the configs provisioning produced and
 * nothing else — every var, D1 id, Secrets Store entry, rate limiter and Workflow comes from an entry in one of
 * them, the way `wrangler deploy` hands a script its bindings. What stands in is Cloudflare itself, at its seams:
 * provisioners hand out ids, each D1 id is a Miniflare database, the Secrets Store is a map the bindings resolve
 * by entry name, `wrangler deploy` is a function that keeps the config it was given, a rate limiter always
 * allows, a Workflow binding resolves its `script_name` to the host config deployed under it, and the host's
 * `send_email` binding keeps the message instead of mailing it. No account is reached.
 *
 * Node-side, like `project/scaffoldBoot.test.ts` and for its reason: a Worker composing `better-auth` pulls an
 * optional `@opentelemetry/api` import no bundler in this repository resolves. So the one runtime fact workerd
 * adds is stated here instead — under `nodejs_compat`, a deployed Worker's `process.env` is its vars.
 */

const PROJECT = "replay";
const WORKER = "board";
const identity: FeatureIdentity = { project: PROJECT, issue: "643", slug: "feature-address" };
const SCRIPT = "replay-f643-feature-address-board";
const HOST = "replay-f643-feature-address-email";
const ORIGIN = `https://${SCRIPT}.acme.workers.dev`;
const PERSON = "ada@example.com";

/** Every kit package the composed Worker imports, linked the way a working checkout is. */
const LINKED = ["core", "auth", "email", "secrets", "turnstile", "audit", "cloudflare"];
const REPO = resolve(import.meta.dirname, "..", "..", "..");

/** More ids than any run here asks for. Miniflare binds databases by name up front, so the pool is fixed. */
const D1_POOL = ["D1_1", "D1_2", "D1_3", "D1_4", "D1_5", "D1_6", "D1_7", "D1_8"];

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

/** A wrangler stanza, as far as this test turns one into bindings. */
interface Stanza {
  name: string;
  vars?: Record<string, string>;
  d1_databases?: { binding: string; database_id: string }[];
  secrets_store_secrets?: { binding: string; secret_name: string }[];
  ratelimits?: { name: string }[];
  workflows?: { binding: string; name: string; class_name: string; script_name?: string }[];
  send_email?: { name: string }[];
}

/** One feature environment on the stand-in account, provisioned exactly as `pithy provision --feature` does it. */
async function featureEnvironment() {
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
  const store: SecretsStore = {
    storeId: "store-1",
    exists: async (name) => entries.has(name),
    put: async (name) => {
      throw new Error(`overwrote ${name}`);
    },
    create: async (name, value) => {
      if (entries.has(name)) return false;
      entries.set(name, value);
      return true;
    },
    remove: async (name) => entries.delete(name),
  };
  const kv = provisioner([]);
  const provisioners = { d1: provisioner([...D1_POOL]), kv, r2: kv } as unknown as ResourceProvisioners;
  /** Every host `wrangler deploy` was handed, by script name — what the account now runs. */
  const hosts = new Map<string, Stanza>();

  const report = await provisionFeature({
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
    seed: async ({ env, projectDir }) => {
      await seedProject({
        account: null,
        project: PROJECT,
        projectDir,
        env,
        yes: true,
        json: true,
        remoteD1,
        workersSubdomain: async () => "acme",
      });
    },
    secretsDatabase: database,
    // The real kit-host pass, narrowed and named for the feature as `pithy provision --feature` calls it. Only
    // `wrangler deploy` and the account's stamp read stand in.
    deployHosts: () =>
      deployKitWorkers({
        projectDir: dir,
        project: PROJECT,
        env: "feature",
        account: null,
        feature: identity,
        only: FEATURE_HOSTS,
        ids: { storeId: store.storeId, accountId: "acct-replay" },
        readVars: async () => null,
        runDeploy: async (args) => {
          const config = JSON.parse(await readFile(args[args.indexOf("--config") + 1] as string, "utf8")) as Stanza;
          hosts.set(config.name, config);
        },
      }),
  });

  return { miniflare, entries, database, hosts, report };
}

type Environment = Awaited<ReturnType<typeof featureEnvironment>>;

/** A dispatched Workflow instance, as the stand-in runtime recorded it. */
interface Dispatch {
  script: string;
  workflow: string;
  params: unknown;
}

/**
 * A script's env, **from its config alone**: every binding is an entry the config declares, resolved the way the
 * platform resolves it. A Workflow binding records its dispatch against the host its `script_name` names — and
 * refuses one naming a host or a Workflow the account does not run, as a deploy would.
 */
function envFromConfig(stanza: Stanza, environment: Environment, dispatched: Dispatch[]): Record<string, unknown> {
  const bindings: Record<string, unknown> = { ...stanza.vars };
  for (const entry of stanza.d1_databases ?? []) bindings[entry.binding] = environment.database(entry.database_id);
  for (const entry of stanza.secrets_store_secrets ?? []) {
    bindings[entry.binding] = {
      get: async () => {
        const value = environment.entries.get(entry.secret_name);
        if (value === undefined) throw new Error(`no store entry ${entry.secret_name}`);
        return value;
      },
    };
  }
  for (const entry of stanza.ratelimits ?? []) bindings[entry.name] = { limit: async () => ({ success: true }) };
  for (const entry of stanza.workflows ?? []) {
    const script = entry.script_name ?? stanza.name;
    bindings[entry.binding] = {
      create: async (options: { id?: string; params?: unknown } = {}) => {
        const host = environment.hosts.get(script);
        const hosted = host?.workflows?.find((workflow) => workflow.name === entry.name);
        if (!hosted || hosted.class_name !== entry.class_name) {
          throw new Error(`no Workflow ${entry.name} (${entry.class_name}) on a script named ${script}`);
        }
        dispatched.push({ script, workflow: entry.name, params: options.params });
        return { id: options.id ?? "instance" };
      },
      get: async () => ({ status: async () => ({ status: "running" }) }),
    };
  }
  return bindings;
}

/**
 * The app Worker `wrangler deploy --env feature` would run: its own config, composed fresh — a new isolate — with
 * an env built from the generated feature stanza and nothing else.
 */
async function appWorker(environment: Environment, dispatched: Dispatch[]) {
  const generated = parse(await readFile(featureConfigPath(workerDir), "utf8")) as unknown as {
    env: { feature: Stanza };
  };
  const stanza = generated.env.feature;
  expect(stanza.name).toBe(SCRIPT);
  const env = envFromConfig(stanza, environment, dispatched);
  // Under `nodejs_compat` a deployed Worker's `process.env` is its vars — and there is no `CI` in Cloudflare.
  for (const [name, value] of Object.entries(stanza.vars ?? {})) vi.stubEnv(name, value);
  vi.stubEnv("CI", "");
  const worker = createEntrypoint(await loadWorkerConfig(workerDir, { fresh: true }));
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return { fetch: (request: Request) => worker.fetch(request, env, ctx) };
}

/**
 * What the feature's email host does with a dispatched batch: its own send path over an env built from the host
 * config provisioning deployed — its database ids, its store entries, its vars — with `send_email` keeping the
 * message. Configured the way the host's module scope configures it: its own isolate, its own registry.
 */
async function hostSends(environment: Environment, dispatch: Dispatch): Promise<{ to: string; text: string }[]> {
  const host = environment.hosts.get(dispatch.script);
  if (!host) throw new Error(`no host deployed as ${dispatch.script}`);
  const sent: { to: string; text: string }[] = [];
  const env = envFromConfig(host, environment, []);
  for (const entry of host.send_email ?? []) {
    env[entry.name] = {
      send: async (message: { to: string; text: string }) => {
        sent.push(message);
        return { messageId: `message-${sent.length}` };
      },
    };
  }
  const [{ buildSendDeps }, { runSendBatch }, { emailSigningRegistry }] = await Promise.all([
    import("@pithy-sh/email/src/workflows/sendDeps"),
    import("@pithy-sh/email/src/workflows/sendBatch"),
    import("@pithy-sh/email/src/crypto/signingKey"),
  ]);
  configureSharedSecrets({ registry: emailSigningRegistry });
  const deps = await buildSendDeps(env as unknown as Parameters<typeof buildSendDeps>[0]);
  const { jobIds } = dispatch.params as { jobIds: string[] };
  await runSendBatch(deps, { do: (_name, fn) => fn() }, jobIds);
  return sent;
}

/** Ask the feature deployment for a magic link. */
async function requestMagicLink(worker: Awaited<ReturnType<typeof appWorker>>): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: PERSON, callbackURL: "/" }),
    }),
  );
}

describe("a feature deployment, after provision and deploy", () => {
  test("sends a magic link, and opening it signs the person in", async () => {
    const environment = await featureEnvironment();
    try {
      // Provisioning stood up the feature's own email host, named for the feature and bound to its own keys.
      expect(environment.report.hosts?.map((row) => [row.worker, row.outcome])).toEqual([[HOST, "deployed"]]);
      const host = environment.hosts.get(HOST);
      expect(host?.vars?.BASE_URL).toBe(ORIGIN);
      expect(host?.vars?.ENVIRONMENT).toBe("feature");

      // 1. Ask for a magic link. The app Worker enqueues the message and dispatches it into the host's Workflow.
      const dispatched: Dispatch[] = [];
      const requested = await requestMagicLink(await appWorker(environment, dispatched));
      expect({ status: requested.status, body: await requested.json() }).toEqual({
        status: 200,
        body: { status: true },
      });
      expect(dispatched.map((dispatch) => [dispatch.script, dispatch.workflow])).toEqual([
        [HOST, "replay-f643-feature-address-email-send"],
      ]);

      // 2. The host sends it. The link in it is the feature's own origin.
      const sent = await hostSends(environment, dispatched[0] as Dispatch);
      expect(sent.map((message) => message.to)).toEqual([PERSON]);
      const link = /https:\/\/\S+\/auth\/magic-link\/verify\?\S+/.exec(sent[0]?.text ?? "")?.[0];
      expect(link?.startsWith(`${ORIGIN}/auth/magic-link/verify?`)).toBe(true);

      // 3. Open it: a new isolate of the app Worker verifies the token and sets the session.
      const worker = await appWorker(environment, []);
      const opened = await worker.fetch(new Request(link as string, { headers: { origin: ORIGIN } }));
      expect(opened.status).toBe(302);
      const cookie = (opened.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
      expect(cookie.startsWith("__Secure-better-auth.session_token=")).toBe(true);

      // Signed in: the deployment's own session endpoint knows who this is.
      const session = await worker.fetch(new Request(`${ORIGIN}/auth/get-session`, { headers: { cookie } }));
      expect(session.status).toBe(200);
      expect(((await session.json()) as { user?: { email?: string } } | null)?.user?.email).toBe(PERSON);
    } finally {
      await environment.miniflare.dispose();
    }
  }, 300_000);

  /**
   * **The plant: without the email host binding, the request fails.** The same provisioned feature with the
   * `EMAIL_SENDER` entry taken out of the generated stanza — what a feature config looked like before #643 — has
   * no way to send, and auth refuses the request rather than accept a link nobody will get.
   */
  test("without the email host binding, a magic link request fails", async () => {
    const environment = await featureEnvironment();
    try {
      const path = featureConfigPath(workerDir);
      const generated = parse(await readFile(path, "utf8")) as unknown as { env: { feature: Stanza } };
      generated.env.feature.workflows = (generated.env.feature.workflows ?? []).filter(
        (entry) => entry.binding !== "EMAIL_SENDER",
      );
      await writeFile(path, JSON.stringify(generated));

      const dispatched: Dispatch[] = [];
      const requested = await requestMagicLink(await appWorker(environment, dispatched));
      expect(requested.status).toBeGreaterThanOrEqual(500);
      expect(dispatched).toEqual([]);
    } finally {
      await environment.miniflare.dispose();
    }
  }, 300_000);
});
