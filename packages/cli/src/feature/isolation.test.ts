// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { type FeatureIdentity, featureWorkerName } from "@pithy-sh/core/src/naming/feature";
import { email } from "@pithy-sh/email/src/capability";
import { media } from "@pithy-sh/media/src/capability";
import { payments } from "@pithy-sh/payments/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { storage } from "@pithy-sh/storage/src/capability";
import { support } from "@pithy-sh/support/src/capability";
import { testers } from "@pithy-sh/testers/src/capability";
import { vector } from "@pithy-sh/vector/src/capability";
import { parse } from "comment-json";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { HOST_WORKERS } from "../capabilities/hostRegistry";
import { CloudflareSecretsProvisioner } from "../capabilities/secretsProvisioner";
import { deployKitWorkers } from "../project/deployKit";
import { featureConfigPath } from "../provision/featureConfig";
import type { ResourceProvisioner, ResourceProvisioners } from "../provision/resources";
import type { SecretsStore } from "../provision/store";
import { featureHostCapabilities, featureHostScripts, featureOwnedIds } from "./hosts";
import { provisionFeature } from "./provision";

/**
 * **The isolation gate (#643): nothing a feature binds is anybody else's.**
 *
 * The maintainer's invariant, as a test: a feature shares nothing with any other feature, with staging, or with
 * production. The Cloudflare account and its one Secrets Store are the only containers that cannot be split, and
 * everything inside them — every database, namespace, bucket, index, Worker, Workflow and store entry — is the
 * feature's own. **One exception, by decision:** a rate-limit namespace is shared by every feature and never by a
 * declared environment — each limiter's is fixed, the same in every feature, and in the range no config declares.
 *
 * A project composing **every host-owning capability the registry knows** is provisioned for a feature, through
 * the real `provisionFeature` and the real kit-host pass (`deployKitWorkers`, resolving each host's committed
 * template through the kit's own registry); only Cloudflare stands in. Then every binding of the generated
 * feature stanza and of every host config `wrangler deploy` was handed is walked — **the list of bindings is read
 * off each config, never written here**, and a key the walk cannot classify fails it, so a binding kind added
 * tomorrow has to be classified before this passes again. Each binding is followed to the resource it reaches
 * (an id, through the stand-in account, to the name it was created under) and that name must be the feature's.
 *
 * The same pass is the host coverage gate: the hosts deployed are compared with the hosts the composition
 * declares — the registry intersected with the composed capabilities, `featureHostCapabilities` — and the
 * composition is checked to cover the whole registry, so a host added to the kit is added here or fails here.
 */

const PROJECT = "replay";
const identity: FeatureIdentity = { project: PROJECT, issue: "643", slug: "feature-address" };
/** A branch of the same issue whose slug the feature's is a hyphen-prefix of — the sibling a prefix check passed. */
const sibling: FeatureIdentity = { project: PROJECT, issue: "643", slug: "feature-address-2" };
/** Another project in the same account, whose name the feature's project is a prefix of. */
const neighbor: FeatureIdentity = { project: `${PROJECT}-two`, issue: "643", slug: "feature-address" };

/**
 * **What the feature owns, stated here and not borrowed from the namers or the runtime gate**: every name it
 * composes starts `<project>-f<issue>-<slug>--`, the double hyphen ending the slug. Nothing is truncated at this
 * identity's length, so the literal is exact, and a sibling's `…-feature-address-2--` does not match it.
 */
const OWN = `${PROJECT}-f643-feature-address--`;
const isOurs = (name: string): boolean => name.startsWith(OWN);
const TOP_LIMITER = { name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 20, period: 60 } };
const PROD_LIMITER = { ...TOP_LIMITER, namespace_id: "2001" };
/**
 * **The feature namespace each limiter must bind, stated here and not borrowed from `featureNamespaceId`**: the
 * limiter's top-level namespace plus 1000000000, inside the range no staging or production config may declare.
 * Every feature binds it, so sharing it with another feature is allowed; binding anything else is a finding.
 */
const FEATURE_LIMITERS: ReadonlyMap<string, string> = new Map([
  [TOP_LIMITER.name, String(1_000_000_000 + Number(TOP_LIMITER.namespace_id))],
]);

/** Every host-owning capability the registry knows, configured. The gate below checks this covers the registry. */
const COMPOSED: Record<string, Capability> = {
  email: email({ fromAddress: "hello@replay.example", fromName: "Replay", baseUrl: "https://replay.example" }),
  media: media({ recordStore: "kv" }),
  storage: storage({}),
  payments: payments({ billingSubject: "user" }),
  // A mail-only inbox: the in-app channel needs auth in this Worker, and this fixture composes none (#645).
  support: support({ inboundAddresses: ["help@support.replay.example"], submission: { enabled: false } }),
  testers: testers({}),
  vector: vector({ indexes: { notes: { model: "@cf/baai/bge-base-en-v1.5", dimensions: 768 } } }),
  secrets: secrets({ registry: {} }),
};
const capabilities = Object.values(COMPOSED);

/**
 * **The adopter's own app capability — a Workflow of its own, and a Durable Object beside it (#650).**
 *
 * The fixture composed only kit capabilities, so neither of the writes #650 added was walked by the gate that
 * exists to prove a feature binds nothing of anybody else's: the app's own `workflows` entry, named for the
 * feature and same-script, and the `durable_objects` entry a feature now carries and retargets. Both are
 * followed by `shared()` below — a Workflow by its `name`, a Durable Object by the `script_name` it reaches.
 */
const app = defineCapability({
  name: "board",
  requiredBindings: [],
  workflows: {
    rotate: { binding: "CONNECTION_ROTATION", params: z.object({}), className: "ConnectionRotationWorkflow" },
  },
});

let dir: string;
let appDir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", "..", ".e2e-feature-isolation-"));
  appDir = join(dir, "apps", "app");
  await mkdir(appDir, { recursive: true });
  // The sibling `LOBBY` names, as far as this fixture needs one: a directory with a config of its own, so
  // provisioning can name it for the feature the way it names any other Worker.
  await mkdir(join(dir, "apps", "realtime"), { recursive: true });
  await writeFile(
    join(dir, "apps", "realtime", "wrangler.jsonc"),
    JSON.stringify({ name: "replay-realtime", main: "./src/index.ts", compatibility_date: "2026-06-01" }),
  );
  // A tracked config the way an adopter leaves one: `dev`'s ids and routes at the top level, a production stanza
  // with its own limiter, and a rate limiter whose namespace a feature must never reuse.
  await writeFile(
    join(appDir, "wrangler.jsonc"),
    JSON.stringify({
      name: "replay-app",
      main: "./src/index.ts",
      compatibility_date: "2026-06-01",
      routes: [{ pattern: "replay.example", custom_domain: true }],
      d1_databases: [{ binding: "DB", database_name: "replay-dev-db", database_id: "DB" }],
      ratelimits: [TOP_LIMITER],
      // One class in this Worker's own main, one in a sibling this project deploys: the two shapes a feature
      // must answer for, copied and retargeted (#650).
      durable_objects: {
        bindings: [
          { name: "ROOM", class_name: "Room" },
          { name: "LOBBY", class_name: "Lobby", script_name: "replay-realtime" },
        ],
      },
      vars: { ENVIRONMENT: "dev", PROJECT, WORKER: "app" },
      env: {
        prod: {
          name: "replay-prod-app",
          ratelimits: [PROD_LIMITER],
          d1_databases: [{ binding: "DB", database_name: "replay-prod-db", database_id: "prod-db-id" }],
          kv_namespaces: [{ binding: "CACHE", id: "prod-kv-id" }],
          services: [{ binding: "API", service: "replay-prod-api" }],
          queues: { producers: [{ binding: "JOBS", queue: "replay-prod-jobs" }] },
        },
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in account: every resource it creates is remembered by id, so a binding can be followed to its name. */
function account() {
  /** id → the name it was created under, across every kind. */
  const names = new Map<string, string>();
  let seq = 0;
  const kind = (label: string): ResourceProvisioner => {
    const byName = new Map<string, string>();
    return {
      find: async (name) => (byName.has(name) ? { id: byName.get(name) as string } : null),
      create: async (name) => {
        seq += 1;
        const id = label === "r2" ? name : `${label}-${seq}`;
        byName.set(name, id);
        names.set(id, name);
        return { id };
      },
      delete: async () => {},
    };
  };
  const provisioners = { d1: kind("d1"), kv: kind("kv"), r2: kind("r2") } as unknown as ResourceProvisioners;
  const entries = new Map<string, string>();
  const store: SecretsStore = {
    storeId: "store-1",
    exists: async (name) => entries.has(name),
    put: async (name, value) => void entries.set(name, value),
    create: async (name, value) => {
      if (entries.has(name)) return "present";
      entries.set(name, value);
      return "created";
    },
    remove: async (name) => entries.delete(name),
  };
  const cf = {
    secrets: () => ({
      exists: async (name: string) => entries.has(name),
      putSecret: async (name: string, value: string) => void entries.set(name, value),
      createSecretIfAbsent: store.create,
    }),
    accountTokens: () => {
      throw new Error("a feature's provisioning reached for an account token");
    },
  } as unknown as CloudflareClients;
  return { names, provisioners, store, entries, cf };
}

/** One config's bindings, as a deploy reads them. */
type Config = Record<string, unknown>;

/**
 * Keys a Worker config carries that name no account resource — settings, code, or a service Cloudflare runs for
 * the whole account and that no environment owns a copy of (Workers AI, Email Sending). Everything else is walked.
 */
const NOT_A_RESOURCE = new Set([
  "$schema",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "vars",
  "workers_dev",
  "triggers",
  "observability",
  "ai",
  "send_email",
  "build",
  "assets",
  "placement",
  "limits",
  "minify",
  "keep_vars",
  "upload_source_maps",
  "rules",
  "no_bundle",
  "find_additional_modules",
]);

/**
 * **Walk one config and name everything in it that is not the feature's.** The keys come from the config; a key
 * that is neither a known non-resource nor a binding this walk can follow is itself a finding, so nothing can
 * slip past unclassified. `ids` follows a D1 or KV id to the name the stand-in account created it under.
 */
function shared(config: Config, ids: ReadonlyMap<string, string>): string[] {
  const findings: string[] = [];
  const own = (what: string, name: unknown): void => {
    if (typeof name !== "string" || !isOurs(name)) findings.push(`${what}: ${String(name)}`);
  };
  const byId = (what: string, id: unknown): void => own(what, ids.get(String(id)) ?? `unknown id ${String(id)}`);
  const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value : []);

  for (const [key, value] of Object.entries(config)) {
    if (NOT_A_RESOURCE.has(key)) continue;
    switch (key) {
      case "name":
        own("script", value);
        break;
      case "route":
        findings.push(`route: ${JSON.stringify(value)}`);
        break;
      case "routes":
        for (const route of list(value)) findings.push(`route: ${JSON.stringify(route)}`);
        break;
      case "d1_databases":
        for (const entry of list(value)) byId(`d1 ${entry.binding}`, entry.database_id);
        break;
      case "kv_namespaces":
        for (const entry of list(value)) byId(`kv ${entry.binding}`, entry.id);
        break;
      case "r2_buckets":
        for (const entry of list(value)) own(`r2 ${entry.binding}`, entry.bucket_name);
        break;
      case "vectorize":
        for (const entry of list(value)) own(`vectorize ${entry.binding}`, entry.index_name);
        break;
      case "services":
        for (const entry of list(value)) own(`service ${entry.binding}`, entry.service);
        break;
      case "workflows":
        for (const entry of list(value)) {
          own(`workflow ${entry.binding}`, entry.name);
          if (entry.script_name !== undefined) own(`workflow ${entry.binding} script`, entry.script_name);
        }
        break;
      case "secrets_store_secrets":
        for (const entry of list(value)) own(`store entry ${entry.binding}`, entry.secret_name);
        break;
      case "ratelimits":
        // A namespace is allowed when it is the fixed feature namespace of the limiter the entry binds — shared
        // with every other feature, by decision — and nothing else: not the top level's, not production's, not
        // another limiter's.
        for (const entry of list(value)) {
          const id = String(entry.namespace_id);
          if (id !== FEATURE_LIMITERS.get(String(entry.name)))
            findings.push(`ratelimit ${entry.name}: namespace ${id}`);
        }
        break;
      case "durable_objects":
        for (const entry of list((value as { bindings?: unknown } | undefined)?.bindings)) {
          if (entry.script_name !== undefined) own(`durable object ${entry.name}`, entry.script_name);
        }
        break;
      case "queues":
        for (const entry of [
          ...list((value as { producers?: unknown })?.producers),
          ...list((value as { consumers?: unknown })?.consumers),
        ]) {
          own(`queue ${entry.binding ?? ""}`, entry.queue);
        }
        break;
      case "analytics_engine_datasets":
        for (const entry of list(value)) own(`dataset ${entry.binding}`, entry.dataset);
        break;
      default:
        findings.push(`unclassified key ${key}`);
    }
  }
  return findings;
}

/** Provision the feature, and return what the account now holds. */
async function provisioned() {
  const stand = account();
  const hosts: Config[] = [];
  const report = await provisionFeature({
    projectDir: dir,
    capabilities,
    identity,
    provisioners: stand.provisioners,
    store: stand.store,
    administersItself: false,
    resolveWorkers: async () => [
      { name: "replay-app", dir: appDir, capabilities, config: { capabilities, app } },
      // The sibling the `LOBBY` binding names. It has no config of its own here; only its name is read.
      { name: "replay-realtime", dir: join(dir, "apps", "realtime"), capabilities: [] },
    ],
    migrate: async () => {},
    seed: async () => {},
    workersSubdomain: async () => "acme",
    secrets: new CloudflareSecretsProvisioner({
      cf: stand.cf,
      account: { accountId: "acct-1", confirmation: "pinned" },
      project: PROJECT,
      storeId: "store-1",
      deploy: async () => {},
      feature: identity,
    }),
    managers: {
      dispatch: async () => {},
      probe: async () => false,
    },
    indexes: { ensure: async () => {}, remove: async () => false },
    deployHosts: () =>
      deployKitWorkers({
        projectDir: dir,
        project: PROJECT,
        env: "feature",
        account: null,
        feature: identity,
        featureOwned: (feature, composed) => featureOwnedIds(stand.provisioners, feature, composed),
        workers: [{ name: "replay-app", dir: appDir, hasWrangler: true }],
        capabilitiesFor: async () => capabilities,
        ids: { storeId: "store-1", accountId: "acct-1" },
        readVars: async () => null,
        runDeploy: async (args) => {
          hosts.push(JSON.parse(await readFile(args[args.indexOf("--config") + 1] as string, "utf8")) as Config);
        },
      }),
  });
  const generated = parse(await readFile(featureConfigPath(appDir), "utf8")) as unknown as {
    env: { feature: Config };
  };
  return { stand, hosts, report, stanza: generated.env.feature };
}

describe("a feature composing every host-owning capability", () => {
  let result: Awaited<ReturnType<typeof provisioned>>;

  beforeAll(async () => {
    result = await provisioned();
  }, 120_000);

  test("the composition covers every host the registry knows", () => {
    expect(Object.keys(COMPOSED).sort()).toEqual(HOST_WORKERS.map((spec) => spec.capability).sort());
  });

  /**
   * **Every composed host is deployed for the feature, and only under the feature's name.** The expected set is
   * derived from the declarations — the registry intersected with what the project composes — never listed.
   */
  test("deploys every composed host, each under the feature's own name", () => {
    const expected = featureHostCapabilities(capabilities);
    const names = new Map(featureHostScripts(identity).map((host) => [host.capability, host.script]));
    expect(expected.length).toBe(HOST_WORKERS.length);
    expect(result.report.hosts?.map((row) => [row.capability, row.outcome])).toEqual(
      expected.map((capability) => [capability, "deployed"]),
    );
    expect(result.hosts.map((config) => config.name)).toEqual(expected.map((capability) => names.get(capability)));
  });

  test("the feature's app stanza binds nothing anybody else has", () => {
    expect(shared(result.stanza, result.stand.names)).toEqual([]);
  });

  test("no feature host binds anything anybody else has", () => {
    for (const config of result.hosts) {
      expect({ host: config.name, shared: shared(config, result.stand.names) }).toEqual({
        host: config.name,
        shared: [],
      });
    }
  });

  test("every store entry the run wrote is the feature's own", () => {
    expect([...result.stand.entries.keys()].filter((name) => !isOurs(name))).toEqual([]);
    expect(result.stand.entries.size).toBeGreaterThan(0);
  });

  test("the feature's manager holds no Cloudflare API token, rotates nothing, and nothing minted one", () => {
    const manager = result.hosts.find((config) => config.name === `${OWN}secrets`) as
      | (Config & { secrets_store_secrets?: { binding: string }[]; workflows?: { binding: string }[] })
      | undefined;
    expect(manager?.secrets_store_secrets?.map((entry) => entry.binding)).toEqual(["SECRETS_ENCRYPTION_KEYS"]);
    expect(manager?.workflows?.map((entry) => entry.binding)).toEqual(["SECRETS_WRITE"]);
    expect((manager?.triggers as { crons?: string[] } | undefined)?.crons ?? []).toEqual([]);
    expect([...result.stand.entries.keys()].filter((name) => name.includes("cf-api-token"))).toEqual([]);
  });

  /**
   * **The gate can fail.** The defects it exists for, planted back into a copy of what provisioning wrote, and the
   * walk names each one: the top level's rate-limit namespace (bound in a feature, it is production's), a store entry bound to the project's `global` copy,
   * a same-issue sibling's host and Workflow (a prefix check passed both), another project's, production's D1 and
   * KV by id, production's service and queue, and a binding kind the walk has never seen.
   */
  test("a planted shared resource fails the walk", () => {
    const planted = structuredClone(result.stanza) as Config & {
      ratelimits: { namespace_id: string }[];
      secrets_store_secrets: { binding: string; secret_name: string }[];
      workflows?: { binding: string; name: string; class_name: string; script_name: string }[];
    };
    const [limiter] = planted.ratelimits;
    if (limiter) limiter.namespace_id = TOP_LIMITER.namespace_id;
    planted.secrets_store_secrets = [
      ...planted.secrets_store_secrets,
      { binding: "RELEASE_INGEST_SECRET", secret_name: `${PROJECT}-global-release-ingest-secret` },
    ];
    planted.workflows = [
      {
        binding: "SIBLING_SEND",
        name: `${featureWorkerName(sibling, "email")}-send`,
        class_name: "X",
        script_name: featureWorkerName(sibling, "email"),
      },
    ];
    planted.d1_databases = [{ binding: "DB", database_name: "replay-prod-db", database_id: "prod-db-id" }];
    planted.kv_namespaces = [{ binding: "CACHE", id: "prod-kv-id" }];
    planted.services = [
      { binding: "API", service: "replay-prod-api" },
      { binding: "NEIGHBOR", service: featureWorkerName(neighbor, "api") },
    ];
    planted.queues = { producers: [{ binding: "JOBS", queue: "replay-prod-jobs" }] };
    planted.hyperdrive = [{ binding: "PG", id: "shared" }];
    // Sorted: which key the walk meets first is the stanza's order, and not what is being proven.
    expect(shared(planted, result.stand.names).sort()).toEqual(
      [
        "d1 DB: unknown id prod-db-id",
        `ratelimit AUTH_RATE_LIMITER: namespace ${TOP_LIMITER.namespace_id}`,
        `store entry RELEASE_INGEST_SECRET: ${PROJECT}-global-release-ingest-secret`,
        `workflow SIBLING_SEND: ${featureWorkerName(sibling, "email")}-send`,
        `workflow SIBLING_SEND script: ${featureWorkerName(sibling, "email")}`,
        "kv CACHE: unknown id prod-kv-id",
        "service API: replay-prod-api",
        `service NEIGHBOR: ${featureWorkerName(neighbor, "api")}`,
        "queue JOBS: replay-prod-jobs",
        "unclassified key hyperdrive",
      ].sort(),
    );
  });

  /** The runtime gate `deployKitWorkers` runs is held to the same plants: it passes every real host and fails each plant. */
  test("the runtime host gate refuses the same plants", async () => {
    const { featureHostNameLeaks } = await import("./hosts");
    const owned = await featureOwnedIds(result.stand.provisioners, identity, capabilities);
    for (const host of result.hosts)
      expect({ host: host.name, leaks: featureHostNameLeaks(host, identity, owned) }).toEqual({
        host: host.name,
        leaks: [],
      });
    const planted = {
      name: featureWorkerName(sibling, "email"),
      workflows: [
        {
          binding: "SEND",
          name: `${featureWorkerName(sibling, "email")}-send`,
          class_name: "X",
          script_name: featureWorkerName(sibling, "email"),
        },
      ],
      d1_databases: [{ binding: "DB", database_name: "replay-prod-db", database_id: "prod-db-id" }],
      kv_namespaces: [{ binding: "CACHE", id: "prod-kv-id" }],
      services: [
        { binding: "API", service: "replay-prod-api" },
        { binding: "NEIGHBOR", service: featureWorkerName(neighbor, "api") },
      ],
      queues: { producers: [{ binding: "JOBS", queue: "replay-prod-jobs" }] },
      hyperdrive: [{ binding: "PG", id: "shared" }],
    };
    expect(featureHostNameLeaks(planted, identity, owned)).toEqual([
      `script: ${featureWorkerName(sibling, "email")}`,
      `workflow SEND: ${featureWorkerName(sibling, "email")}-send`,
      `workflow SEND script: ${featureWorkerName(sibling, "email")}`,
      "d1 DB: id prod-db-id is not one this feature created",
      "kv CACHE: id prod-kv-id is not one this feature created",
      "service API: replay-prod-api",
      `service NEIGHBOR: ${featureWorkerName(neighbor, "api")}`,
      "queue JOBS: replay-prod-jobs",
      "unclassified key hyperdrive",
    ]);
  });

  /**
   * **Shared with every feature, never with a declared environment (#643).** The feature binds its limiter's fixed
   * namespace, which is in the reserved range and is neither the top level's nor production's. And the walk still
   * fails the ids it exists for: production's, and another limiter's feature namespace.
   */
  test("every rate-limit namespace the feature binds is its limiter's fixed one, and never a declared one", () => {
    const bound = (result.stanza.ratelimits as { name: string; namespace_id: string }[]).map((entry) => [
      entry.name,
      entry.namespace_id,
    ]);
    expect(bound).toEqual([["AUTH_RATE_LIMITER", "1000001001"]]);
    expect(["1001", "2001"]).not.toContain("1000001001");
    for (const [id, finding] of [
      [PROD_LIMITER.namespace_id, "ratelimit AUTH_RATE_LIMITER: namespace 2001"],
      ["1000002001", "ratelimit AUTH_RATE_LIMITER: namespace 1000002001"],
    ] as const) {
      const planted = structuredClone(result.stanza) as Config & { ratelimits: { namespace_id: string }[] };
      const [limiter] = planted.ratelimits;
      if (limiter) limiter.namespace_id = id;
      expect(shared(planted, result.stand.names)).toEqual([finding]);
    }
    // Nothing account-wide was made for rate limiting: no registry, no store entry.
    expect([...result.stand.entries.keys()].filter((name) => name.includes("ratelimit"))).toEqual([]);
    expect([...result.stand.names.values()].filter((name) => name.includes("registry"))).toEqual([]);
  });
});
