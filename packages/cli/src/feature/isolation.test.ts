// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import {
  type FeatureIdentity,
  featureNamePrefix,
  featureRatelimitNamespaceId,
} from "@pithy-sh/core/src/naming/feature";
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
import { HOST_WORKERS } from "../capabilities/hostRegistry";
import { CloudflareSecretsProvisioner } from "../capabilities/secretsProvisioner";
import { deployKitWorkers } from "../project/deployKit";
import { featureConfigPath } from "../provision/featureConfig";
import type { ResourceProvisioner, ResourceProvisioners } from "../provision/resources";
import type { SecretsStore } from "../provision/store";
import { featureHostCapabilities, featureHostScripts } from "./hosts";
import { provisionFeature } from "./provision";

/**
 * **The isolation gate (#643): nothing a feature binds is anybody else's.**
 *
 * The maintainer's invariant, as a test: a feature shares nothing with any other feature, with staging, or with
 * production. The Cloudflare account and its one Secrets Store are the only containers that cannot be split, and
 * everything inside them — every database, namespace, bucket, index, Worker, Workflow, rate-limit namespace and
 * store entry — is the feature's own.
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
const sibling: FeatureIdentity = { project: PROJECT, issue: "644", slug: "feature-address" };
const TOP_LIMITER = { name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 20, period: 60 } };
const PROD_LIMITER = { ...TOP_LIMITER, namespace_id: "2001" };

/** Every host-owning capability the registry knows, configured. The gate below checks this covers the registry. */
const COMPOSED: Record<string, Capability> = {
  email: email({ fromAddress: "hello@replay.example", fromName: "Replay", baseUrl: "https://replay.example" }),
  media: media({ recordStore: "kv" }),
  storage: storage({}),
  payments: payments({ billingSubject: "user" }),
  support: support({ inboundAddresses: ["help@support.replay.example"] }),
  testers: testers({}),
  vector: vector({ indexes: { notes: { model: "@cf/baai/bge-base-en-v1.5", dimensions: 768 } } }),
  secrets: secrets({ registry: {} }),
};
const capabilities = Object.values(COMPOSED);

let dir: string;
let appDir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", "..", ".e2e-feature-isolation-"));
  appDir = join(dir, "apps", "app");
  await mkdir(appDir, { recursive: true });
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
      vars: { ENVIRONMENT: "dev", PROJECT, WORKER: "app" },
      env: {
        prod: {
          name: "replay-prod-app",
          ratelimits: [PROD_LIMITER],
          d1_databases: [{ binding: "DB", database_name: "replay-prod-db", database_id: "prod-db-id" }],
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
    accountTokens: () => ({ rollToken: async (name: string) => ({ id: `tk-${name}`, value: `token-${name}` }) }),
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
function shared(config: Config, ids: ReadonlyMap<string, string>, tracked: ReadonlySet<string>): string[] {
  const prefix = featureNamePrefix(identity);
  const findings: string[] = [];
  const own = (what: string, name: unknown): void => {
    if (typeof name !== "string" || !name.startsWith(prefix)) findings.push(`${what}: ${String(name)}`);
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
        for (const entry of list(value)) {
          const id = String(entry.namespace_id);
          const expected = featureRatelimitNamespaceId(identity, 0);
          if (tracked.has(id) || id !== expected || id === featureRatelimitNamespaceId(sibling, 0)) {
            findings.push(`ratelimit ${entry.name}: namespace ${id}`);
          }
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
    resolveWorkers: async () => [{ name: "replay-app", dir: appDir, capabilities }],
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

/** Every rate-limit namespace the tracked config declares, anywhere but a feature stanza. */
const TRACKED_NAMESPACES = new Set([TOP_LIMITER.namespace_id, PROD_LIMITER.namespace_id]);

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
    expect(shared(result.stanza, result.stand.names, TRACKED_NAMESPACES)).toEqual([]);
  });

  test("no feature host binds anything anybody else has", () => {
    for (const config of result.hosts) {
      expect({ host: config.name, shared: shared(config, result.stand.names, TRACKED_NAMESPACES) }).toEqual({
        host: config.name,
        shared: [],
      });
    }
  });

  test("every store entry the run wrote is the feature's own", () => {
    const prefix = featureNamePrefix(identity);
    expect([...result.stand.entries.keys()].filter((name) => !name.startsWith(prefix))).toEqual([]);
    expect(result.stand.entries.size).toBeGreaterThan(0);
  });

  /**
   * **The gate can fail.** The defect it exists for — the top level's rate-limit namespace copied into the
   * feature stanza — planted back into a copy of what provisioning wrote, and the walk names it. So does a store
   * entry bound to the project's `global` copy, and a binding kind the walk has never seen.
   */
  test("a planted shared resource fails the walk", () => {
    const planted = structuredClone(result.stanza) as Config & {
      ratelimits: { namespace_id: string }[];
      secrets_store_secrets: { binding: string; secret_name: string }[];
    };
    const [limiter] = planted.ratelimits;
    if (limiter) limiter.namespace_id = TOP_LIMITER.namespace_id;
    planted.secrets_store_secrets = [
      ...planted.secrets_store_secrets,
      { binding: "RELEASE_INGEST_SECRET", secret_name: `${PROJECT}-global-release-ingest-secret` },
    ];
    planted.hyperdrive = [{ binding: "PG", id: "shared" }];
    expect(shared(planted, result.stand.names, TRACKED_NAMESPACES)).toEqual([
      `ratelimit AUTH_RATE_LIMITER: namespace ${TOP_LIMITER.namespace_id}`,
      `store entry RELEASE_INGEST_SECRET: ${PROJECT}-global-release-ingest-secret`,
      "unclassified key hyperdrive",
    ]);
  });
});
