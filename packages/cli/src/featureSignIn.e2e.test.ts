// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";
import { type FeatureIdentity, featureNamePrefix } from "@pithy-sh/core/src/naming/feature";
import { WorkflowSecretDispatcher } from "@pithy-sh/secrets/src/manager/dispatcher";
import { runWriteWorkflow, type WriteWorkflowPayload } from "@pithy-sh/secrets/src/manager/writeWorkflow";
import { configureSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { parse } from "comment-json";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { runAdd } from "./capabilities/flow";
import { CloudflareSecretsProvisioner } from "./capabilities/secretsProvisioner";
import { featureHostCapabilities, featureHostScripts } from "./feature/hosts";
import { deprovisionFeature, provisionFeature } from "./feature/provision";
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
 * **The goal of #643, run end to end: `pithy provision --feature` stands up every kit Worker the project composes,
 * named for the feature, through the path staging and production take; the feature's app Worker sends a magic
 * link, opening it signs the person in; and `pithy feature destroy` takes every one of those Workers, and every
 * Workflow they host, back off the account.**
 *
 * ## What is real, and what stands in
 *
 * Real: a scaffolded project composing `auth` (and its prerequisites `secrets` and `email`), `storage` and
 * `testers`, exactly as `pithy add` writes them — four kit hosts: the secrets manager, email, storage and testers.
 * `provisionFeature`, with the real migrations, the real seed, the real secrets provisioner
 * (`CloudflareSecretsProvisioner`, handed the feature), the real kit-host pass (`deployKitWorkers`, resolving each
 * committed template through the kit's own registry) and the real manager dispatcher (`WorkflowSecretDispatcher`,
 * bound to the feature), which reaches the feature's own manager and runs its write Workflow
 * (`runWriteWorkflow`) against the database and key its deployed config binds. The app Worker, composed from its
 * own `pithy.config.ts` through `createEntrypoint`; and the email host's own send path.
 *
 * **No binding is supplied by this test.** Every Worker's env is built from the config provisioning produced and
 * nothing else, the way `wrangler deploy` hands a script its bindings. What stands in is Cloudflare itself, at
 * its seams: provisioners hand out ids, each D1 id is a Miniflare database, the Secrets Store is a map the
 * bindings resolve by entry name, `wrangler deploy` keeps the config it was given, the Workflows API runs a
 * dispatched instance against the host that script names, a rate limiter always allows, and the email host's
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
const EMAIL_HOST = "replay-f643-feature-address-email";
const ORIGIN = `https://${SCRIPT}.acme.workers.dev`;
const PERSON = "ada@example.com";

/** Every kit package the composed Worker imports, linked the way a working checkout is. */
const LINKED = ["core", "auth", "email", "secrets", "turnstile", "audit", "cloudflare", "storage", "testers"];
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
  for (const capability of ["auth", "storage", "testers"]) {
    await runAdd({
      account: null,
      projectDir: dir,
      workerDir,
      worker: WORKER,
      project: PROJECT,
      capability,
      withPrerequisites: true,
      migrate: async () => [],
    });
  }
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** An in-memory provisioner handing out ids from the pool, as the real adapter finds or creates by name. */
function provisioner(pool: string[] | null): ResourceProvisioner {
  const names = new Map<string, string>();
  return {
    find: async (name) => (names.has(name) ? { id: names.get(name) as string } : null),
    create: async (name) => {
      // An R2 bucket's id is its name; a database's comes from the Miniflare pool.
      const id = pool === null ? name : pool.shift();
      if (id === undefined) throw new Error("the D1 pool is exhausted");
      names.set(name, id);
      return { id };
    },
    delete: async () => {},
  };
}

/** A wrangler config, as far as this test turns one into bindings. */
interface Stanza {
  name: string;
  vars?: Record<string, string>;
  d1_databases?: { binding: string; database_id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  secrets_store_secrets?: { binding: string; secret_name: string }[];
  ratelimits?: { name: string }[];
  workflows?: { binding: string; name: string; class_name: string; script_name?: string }[];
  send_email?: { name: string }[];
}

/** What can go wrong once, on purpose, in a run of the stand-in account. */
interface Faults {
  /** Fail the first migration — after the master key and the manager token are created. */
  migrateOnce?: boolean;
  /** Fail the first deploy of this host script. */
  deployOnce?: string;
}

/** The stand-in Cloudflare account: databases, the Secrets Store, deployed scripts and the Workflows API. */
async function standInAccount() {
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
  const entries = new Map<string, string>();
  const store: SecretsStore = {
    storeId: "store-1",
    exists: async (name) => entries.has(name),
    put: async (name) => {
      throw new Error(`overwrote ${name}`);
    },
    create: async (name, value) => {
      if (entries.has(name)) return "present";
      entries.set(name, value);
      return "created";
    },
    remove: async (name) => entries.delete(name),
  };
  // The Cloudflare `pithy secrets provision` talks to, as far as it does for a feature: the store, and the
  // account tokens its manager's own token is rolled from. A write over an entry that is there fails the test.
  const cf = {
    secrets: () => ({
      exists: store.exists,
      createSecretIfAbsent: store.create,
      putSecret: async (name: string, value: string) => {
        if (entries.has(name)) throw new Error(`overwrote ${name}`);
        entries.set(name, value);
      },
    }),
    accountTokens: () => ({ rollToken: async (name: string) => ({ id: `tk-${name}`, value: `token-for-${name}` }) }),
  } as unknown as CloudflareClients;
  const d1 = provisioner([...D1_POOL]);
  const provisioners = { d1, kv: provisioner([]), r2: provisioner(null) } as unknown as ResourceProvisioners;
  /** Every script `wrangler deploy` was handed, by name — what the account now runs. */
  const hosts = new Map<string, Stanza>();
  return { miniflare, database, entries, store, cf, provisioners, hosts };
}

type Account = Awaited<ReturnType<typeof standInAccount>>;

/**
 * The Workflows REST API, as far as a dispatcher uses it: an instance of a named Workflow runs in the script that
 * hosts it, against that script's deployed config. Only the secrets manager's write Workflow is run here.
 */
function workflowsApi(account: Account) {
  return {
    dispatchAndPoll: async (workflow: string, params: unknown): Promise<unknown> => {
      for (const host of account.hosts.values()) {
        const hosted = host.workflows?.find((entry) => entry.name === workflow);
        if (!hosted) continue;
        if (hosted.class_name !== "SecretsWriteWorkflow") throw new Error(`not run here: ${hosted.class_name}`);
        const env = envFromConfig(host, account, []) as unknown as Parameters<typeof runWriteWorkflow>[0];
        return runWriteWorkflow(env, params as WriteWorkflowPayload);
      }
      throw new Error(`no Workflow ${workflow} on the account`);
    },
  };
}

/** Provision the feature exactly as `pithy provision --feature` does, over the stand-in account. */
async function provision(account: Account, faults: Faults = {}) {
  const remoteD1 = ({ databaseId }: { databaseId: string }) => account.database(databaseId);
  return provisionFeature({
    projectDir: dir,
    capabilities: projectCapabilities(await resolveWorkersFor("feature", { projectDir: dir })),
    identity,
    provisioners: account.provisioners,
    store: account.store,
    administersItself: false,
    workersSubdomain: async () => "acme",
    migrate: async ({ env, projectDir }) => {
      if (faults.migrateOnce) {
        faults.migrateOnce = false;
        throw new Error("a transient 503 from D1");
      }
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
    secrets: new CloudflareSecretsProvisioner({
      cf: account.cf,
      account: { accountId: "acct-replay", confirmation: "pinned" },
      project: PROJECT,
      storeId: account.store.storeId,
      deploy: async () => {
        throw new Error("a feature's manager deploys with its kit hosts");
      },
      feature: identity,
    }),
    managers: new WorkflowSecretDispatcher(workflowsApi(account), PROJECT, identity),
    // The real kit-host pass, named for the feature, over every host the project composes. Only `wrangler
    // deploy` and the account's stamp read stand in.
    deployHosts: () =>
      deployKitWorkers({
        projectDir: dir,
        project: PROJECT,
        env: "feature",
        account: null,
        feature: identity,
        ids: { storeId: account.store.storeId, accountId: "acct-replay" },
        readVars: async () => null,
        runDeploy: async (args) => {
          const config = JSON.parse(await readFile(args[args.indexOf("--config") + 1] as string, "utf8")) as Stanza;
          if (faults.deployOnce === config.name) {
            faults.deployOnce = undefined;
            throw new Error(`wrangler deploy ${config.name}: exited 1`);
          }
          account.hosts.set(config.name, config);
        },
      }),
  });
}

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
function envFromConfig(stanza: Stanza, account: Account, dispatched: Dispatch[]): Record<string, unknown> {
  const bindings: Record<string, unknown> = { ...stanza.vars };
  for (const entry of stanza.d1_databases ?? []) bindings[entry.binding] = account.database(entry.database_id);
  // A bucket, by the name the config binds. Nothing in the sign-in path reads one; a Worker only checks it is bound.
  for (const entry of stanza.r2_buckets ?? []) bindings[entry.binding] = { bucket: entry.bucket_name };
  for (const entry of stanza.secrets_store_secrets ?? []) {
    bindings[entry.binding] = {
      get: async () => {
        const value = account.entries.get(entry.secret_name);
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
        const host = account.hosts.get(script);
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

/** The generated feature stanza `wrangler deploy --env feature` reads. */
async function featureStanza(): Promise<Stanza> {
  const generated = parse(await readFile(featureConfigPath(workerDir), "utf8")) as unknown as {
    env: { feature: Stanza };
  };
  return generated.env.feature;
}

/**
 * The app Worker `wrangler deploy --env feature` would run: its own config, composed fresh — a new isolate — with
 * an env built from the generated feature stanza and nothing else.
 */
async function appWorker(account: Account, dispatched: Dispatch[]) {
  const stanza = await featureStanza();
  expect(stanza.name).toBe(SCRIPT);
  const env = envFromConfig(stanza, account, dispatched);
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
async function hostSends(account: Account, dispatch: Dispatch): Promise<{ to: string; text: string }[]> {
  const host = account.hosts.get(dispatch.script);
  if (!host) throw new Error(`no host deployed as ${dispatch.script}`);
  const sent: { to: string; text: string }[] = [];
  const env = envFromConfig(host, account, []);
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

/** The whole flow: ask for a link, let the host send it, open it, and ask who is signed in. */
async function signsIn(account: Account): Promise<void> {
  const dispatched: Dispatch[] = [];
  const requested = await requestMagicLink(await appWorker(account, dispatched));
  expect({ status: requested.status, body: await requested.json() }).toEqual({ status: 200, body: { status: true } });
  expect(dispatched.map((dispatch) => [dispatch.script, dispatch.workflow])).toEqual([
    [EMAIL_HOST, "replay-f643-feature-address-email-send"],
  ]);

  // The host sends it. The link in it is the feature's own origin.
  const sent = await hostSends(account, dispatched[0] as Dispatch);
  expect(sent.map((message) => message.to)).toEqual([PERSON]);
  const link = /https:\/\/\S+\/auth\/magic-link\/verify\?\S+/.exec(sent[0]?.text ?? "")?.[0];
  expect(link?.startsWith(`${ORIGIN}/auth/magic-link/verify?`)).toBe(true);

  // Open it: a new isolate of the app Worker verifies the token and sets the session.
  const worker = await appWorker(account, []);
  const opened = await worker.fetch(new Request(link as string, { headers: { origin: ORIGIN } }));
  expect(opened.status).toBe(302);
  const cookie = (opened.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  expect(cookie.startsWith("__Secure-better-auth.session_token=")).toBe(true);

  // Signed in: the deployment's own session endpoint knows who this is.
  const session = await worker.fetch(new Request(`${ORIGIN}/auth/get-session`, { headers: { cookie } }));
  expect(session.status).toBe(200);
  expect(((await session.json()) as { user?: { email?: string } } | null)?.user?.email).toBe(PERSON);
}

/** The host scripts this project composes, named for the feature — derived from the registry, never listed. */
async function composedHostScripts(): Promise<string[]> {
  const composed = featureHostCapabilities(
    projectCapabilities(await resolveWorkersFor("feature", { projectDir: dir })),
  );
  const scripts = new Map(featureHostScripts(identity).map((host) => [host.capability, host.script]));
  return composed.map((capability) => scripts.get(capability) as string);
}

describe("a feature deployment, after provision and deploy", () => {
  test("stands up every composed host, sends a magic link that signs the person in, and destroy takes it all", async () => {
    const account = await standInAccount();
    try {
      const report = await provision(account);

      // Every kit host the project composes — the manager, email, storage, testers — named for the feature.
      const expected = await composedHostScripts();
      expect(expected).toEqual([
        "replay-f643-feature-address-email",
        "replay-f643-feature-address-storage",
        "replay-f643-feature-address-testers",
        "replay-f643-feature-address-secrets",
      ]);
      expect(report.hosts?.map((row) => [row.worker, row.outcome])).toEqual(
        expected.map((script) => [script, "deployed"]),
      );
      expect([...account.hosts.keys()].sort()).toEqual([...expected].sort());
      expect(account.hosts.get(EMAIL_HOST)?.vars?.BASE_URL).toBe(ORIGIN);

      // The feature's `d1` secrets, created by its own manager — the path a declared environment's take.
      expect(report.featureSecrets?.find((secret) => secret.name === "auth-session-secret")).toEqual({
        name: "auth-session-secret",
        environments: ["feature"],
        created: ["feature"],
      });
      // Every store entry is the feature's own.
      const prefix = featureNamePrefix(identity);
      expect([...account.entries.keys()].filter((name) => !name.startsWith(prefix))).toEqual([]);

      await signsIn(account);

      // `pithy feature destroy`: every host and every Workflow it hosts, and every store entry, gone.
      const hostedWorkflows = [...account.hosts.values()].flatMap((host) =>
        (host.workflows ?? []).map((workflow) => ({ name: workflow.name, script: host.name })),
      );
      expect(hostedWorkflows.length).toBeGreaterThan(expected.length);
      const deletedWorkflows: string[] = [];
      const revoked: string[] = [];
      const destroyed = await deprovisionFeature({
        projectDir: dir,
        identity,
        capabilities: projectCapabilities(await resolveWorkersFor("feature", { projectDir: dir })),
        env: "feature",
        provisioners: account.provisioners,
        workers: [{ name: `${PROJECT}-${WORKER}`, dir: workerDir }],
        store: account.store,
        scripts: {
          exists: async (name) => account.hosts.has(name) || name === SCRIPT,
          delete: async (name) => void account.hosts.delete(name),
        },
        workflows: {
          hostedBy: async (scripts) =>
            hostedWorkflows.filter((workflow) => scripts.has(workflow.script)).map((workflow) => workflow.name),
          delete: async (name) => void deletedWorkflows.push(name),
        },
        tokens: {
          deleteByName: async (name) => {
            revoked.push(name);
            return 1;
          },
        },
      });
      expect(account.hosts.size).toBe(0);
      expect(deletedWorkflows.sort()).toEqual(hostedWorkflows.map((workflow) => workflow.name).sort());
      expect(destroyed.deleted.filter((entry) => entry.kind === "worker").map((entry) => entry.name)).toEqual(
        expect.arrayContaining([SCRIPT, ...expected]),
      );
      expect([...account.entries.keys()]).toEqual([]);
      expect(revoked).toEqual(["replay-f643-feature-address-secrets-manager"]);
    } finally {
      await account.miniflare.dispose();
    }
  }, 300_000);

  /**
   * **F1: a failure after the master key is created is finished by the next run.** The key and the manager token
   * are created before the first migration; the migration fails. Nothing was sealed and nothing needs the run
   * that created the key: the re-run finds the key, deploys the manager, and the manager creates every `d1`
   * secret under whatever key the store holds. The feature signs people in.
   */
  test("a run that fails after the master key exists is completed by the next one", async () => {
    const account = await standInAccount();
    try {
      await expect(provision(account, { migrateOnce: true })).rejects.toThrow("a transient 503 from D1");
      expect(account.entries.has("replay-f643-feature-address-secrets-encryption-keys")).toBe(true);
      const key = account.entries.get("replay-f643-feature-address-secrets-encryption-keys");

      const report = await provision(account);
      expect(account.entries.get("replay-f643-feature-address-secrets-encryption-keys")).toBe(key);
      expect(report.featureSecrets?.find((secret) => secret.name === "auth-session-secret")?.created).toEqual([
        "feature",
      ]);
      await signsIn(account);

      // And a third run changes nothing: every secret is there, so nothing is minted or overwritten.
      const again = await provision(account);
      expect(again.featureSecrets?.every((secret) => secret.created.length === 0)).toBe(true);
      await signsIn(account);
    } finally {
      await account.miniflare.dispose();
    }
  }, 300_000);

  /**
   * **F2: a host that failed to deploy leaves no binding to it.** The email host's deploy fails once: the run
   * fails, and the app stanza it wrote binds no `EMAIL_SENDER` — so a magic link request is refused rather than
   * dispatched to a Workflow on a script that does not exist. The re-run deploys it, binds it, and signs in.
   */
  test("a failed host deploy leaves no binding to it, and the re-run binds it", async () => {
    const account = await standInAccount();
    try {
      await expect(provision(account, { deployOnce: EMAIL_HOST })).rejects.toThrow(
        "Not every kit Worker this feature composes deployed",
      );
      expect(account.hosts.has(EMAIL_HOST)).toBe(false);
      const stanza = await featureStanza();
      expect(stanza.workflows?.some((entry) => entry.script_name === EMAIL_HOST)).toBe(false);
      // The hosts that did deploy are bound.
      expect(stanza.workflows?.some((entry) => entry.script_name === "replay-f643-feature-address-storage")).toBe(true);

      const dispatched: Dispatch[] = [];
      const refused = await requestMagicLink(await appWorker(account, dispatched));
      expect(refused.status).toBeGreaterThanOrEqual(500);
      expect(dispatched).toEqual([]);

      await provision(account);
      await signsIn(account);
    } finally {
      await account.miniflare.dispose();
    }
  }, 300_000);
});
