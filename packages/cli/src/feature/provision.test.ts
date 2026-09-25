// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import {
  type FeatureIdentity,
  featureResourceName,
  featureWorkerName,
  isFeatureOwnedName,
} from "@pithy-sh/core/src/naming/feature";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { CliAuditEvent } from "../audit/cliAudit";
import { CloudflareSecretsProvisioner } from "../capabilities/secretsProvisioner";
import { sourceFiles } from "../ci/sourceFiles";
import type { ProvisionWorker } from "../provision/environment";
import { featureConfigPath } from "../provision/featureConfig";
import {
  cloudflareWorkerScripts,
  ProvisionAuditActions,
  type ResourceProvisioner,
  type ResourceProvisioners,
} from "../provision/resources";
import { emptyManifest, type FeatureResource, manifestPath, readManifest, writeManifest } from "./manifest";
import { deletedBeforeFailure, deprovisionFeature, provisionFeature } from "./provision";

/** An in-memory provisioner over a name→id map, mirroring the real find/create/delete semantics. */
function fakeKind(kind: string, store: Map<string, string>): ResourceProvisioner & { creates: number } {
  let seq = 0;
  const p = {
    creates: 0,
    find: async (name: string) => (store.has(name) ? { id: store.get(name) as string } : null),
    create: async (name: string) => {
      p.creates += 1;
      seq += 1;
      // r2's id is its name (no separate id); d1/kv get a synthetic uuid — same shape as the real adapter.
      const id = kind === "r2" ? name : `${kind}-${seq}`;
      store.set(name, id);
      return { id };
    },
    delete: async (id: string) => {
      for (const [name, value] of store) if (value === id) store.delete(name);
    },
  };
  return p;
}

/** A full fake provisioner set plus the backing stores, so a test can pre-seed or inspect them. */
function fakeProvisioners() {
  const stores = { d1: new Map<string, string>(), kv: new Map<string, string>(), r2: new Map<string, string>() };
  const provisioners = {
    d1: fakeKind("d1", stores.d1),
    kv: fakeKind("kv", stores.kv),
    r2: fakeKind("r2", stores.r2),
  };
  return { stores, provisioners: provisioners as unknown as ResourceProvisioners, typed: provisioners };
}

/**
 * The script half of teardown, for a case that is not about scripts: an account with none deployed, and a
 * project whose Workers the case does not resolve. The cases that are about scripts are below.
 */
const noScripts = {
  scripts: { exists: async () => false, delete: async () => {} },
  workers: [],
  ...noWorkflows(),
};

/**
 * The Workflow and token halves of teardown (#643), for a case not about them: an account hosting no Workflow and
 * holding no feature token.
 */
function noWorkflows() {
  return {
    workflows: { hostedBy: async () => [] as string[], delete: async () => {} },
    tokens: { deleteByName: async () => 0 },
  };
}

/** A capability declaring one D1, one KV, and one R2 binding — the provisionable set under test. */
function appCapability() {
  const requiredBindings: BindingSpecInput[] = [
    { type: "d1", name: "DB" },
    { type: "kv", name: "CACHE" },
    { type: "r2", name: "ASSETS" },
  ];
  return defineCapability({ name: "app", requiredBindings });
}

/**
 * Every file under `root`, by absolute path, with its bytes. The oracle for "what did this run write?".
 *
 * Through {@link sourceFiles}, never a walk of its own — `ci/sourceFiles.test.ts` refuses the seventh
 * hand-rolled recursion in this repository, and a fixture is not an exemption. `dotted` is on and `keep`
 * takes everything, because the whole question here is what landed under `.wrangler/`.
 */
function snapshot(root: string): Map<string, string> {
  return new Map(sourceFiles(root, { dotted: true, keep: () => true }).map((file) => [file.path, file.text]));
}

/**
 * Is this path one the scaffolded `.gitignore` already covers? `.wrangler/` at any depth, and the
 * feature manifest. Written as the two rules rather than as a regex over the whole ignore file, because
 * these two are the only ones provisioning is allowed to rely on.
 */
function ignored(path: string): boolean {
  return path.split(sep).includes(".wrangler") || path.endsWith(".pithy-feature.json");
}

/** Migrate/seed are exercised by their own suites; provisioning tests stub them out. */
/**
 * The seams a test that is not about worker wiring stubs out: the backend runners, plus an empty
 * worker set. These cases assert resource creation, the manifest, and audit — the real resolver would
 * read `apps/` and each Worker's `pithy.config.ts`, which these bare fixtures deliberately do not have.
 */
const noBackend = {
  migrate: async () => {},
  seed: async () => {},
  resolveWorkers: async () => [],
  administersItself: false,
};

describe("provisionFeature / deprovisionFeature", () => {
  let dir: string;
  const identity: FeatureIdentity = { project: "acme", issue: "69", slug: "demo" };
  const capabilities = [appCapability()];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-feature-"));
    // The per-Worker layout: one Worker in apps/app, owning its own wrangler.jsonc. No root Worker.
    await mkdir(join(dir, "apps", "app"), { recursive: true });
    await writeFile(join(dir, "apps", "app", "wrangler.jsonc"), '{\n  "name": "app"\n}\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Record migrate/seed invocations so a test can assert both ran, against which env. */
  function runners() {
    const calls: { migrate: string[]; seed: string[] } = { migrate: [], seed: [] };
    return {
      calls,
      migrate: async ({ env }: { env: string }) => void calls.migrate.push(env),
      seed: async ({ env }: { env: string }) => void calls.seed.push(env),
    };
  }

  /**
   * **F3 of #643's review: an app Worker can never take a kit host's name.** A feature names each Worker by its
   * directory, and `apps/email` composes exactly the name email's feature host deploys under. Refused before a
   * single resource is created — for every host the registry knows, not only email's.
   */
  test.each(["email", "secrets", "payments", "vector"])(
    "refuses an app Worker in apps/%s before creating anything",
    async (app) => {
      const { stores, provisioners } = fakeProvisioners();
      await expect(
        provisionFeature({
          administersItself: false,
          projectDir: dir,
          capabilities,
          identity,
          provisioners,
          resolveWorkers: async () => [{ name: `acme-${app}`, dir: join(dir, "apps", app), capabilities }],
          migrate: async () => {},
          seed: async () => {},
        }),
      ).rejects.toThrow(`the name this feature's ${app} host takes`);
      expect([...stores.d1.keys(), ...stores.kv.keys(), ...stores.r2.keys()]).toEqual([]);
    },
  );

  test("fresh provision creates every resource, records the manifest, writes wrangler ids, migrates + seeds", async () => {
    const { stores, provisioners } = fakeProvisioners();
    const r = runners();

    const report = await provisionFeature({
      administersItself: false,
      projectDir: dir,
      capabilities,
      identity,
      provisioners,
      // This case asserts the ids land in the fixture Worker's own wrangler.jsonc, so resolve it for real.
      resolveWorkers: async () => [{ name: "app", dir: join(dir, "apps", "app"), capabilities }],
      migrate: r.migrate,
      seed: r.seed,
    });

    expect(report.resources.map((x) => [x.kind, x.binding, x.created])).toEqual([
      ["d1", "DB", true],
      ["kv", "CACHE", true],
      ["r2", "ASSETS", true],
    ]);
    // Both backend steps ran, proven by the seams rather than by a field the payload asserts about itself
    // (#231): each throws on failure, so a returned report already means they succeeded, and a hardcoded
    // `migrated: true, seeded: true` beside it is a constant no consumer can usefully branch on.
    expect(r.calls).toEqual({ migrate: ["feature"], seed: ["feature"] });
    // No `command`: the name of a command belongs to the command, and one command produces this report
    // under two spellings (#251). `configs` and `committed` are the run saying which file it wrote and
    // what happens to it — asserted as a property in `provision/destination.test.ts`.
    // `declined` is the same fact one level down: what this run did *not* make, and why the adopter said
    // so (#514). A feature environment carries it for the reason a declared one does — a resource that was
    // never created leaves no other trace of itself. `manifestFaults` is the third of that family and
    // carries here for a third version of the reason (#513): a manifest that would not parse leaves its
    // resources created under the generic name, which is indistinguishable from a healthy run unless the
    // report says so — and a feature is exactly where an unreleased capability's broken manifest lands.
    expect(Object.keys(report).sort()).toEqual([
      "committed",
      "configs",
      "declined",
      "env",
      "manifestFaults",
      "resources",
      "secretBindings",
      "services",
      "workers",
    ]);

    // The R2 resource's name is its id; D1/KV got synthetic ids.
    const r2Name = featureResourceName(identity, "ASSETS", "r2");
    expect(stores.r2.get(r2Name)).toBe(r2Name);

    const manifest = await readManifest(manifestPath(dir));
    expect(manifest?.resources).toHaveLength(3);

    const wrangler = parse(await readFile(featureConfigPath(join(dir, "apps", "app")), "utf8")) as unknown as {
      env: Record<
        string,
        Record<string, { binding: string; database_id?: string; id?: string; bucket_name?: string }[]>
      >;
    };
    const feature = wrangler.env.feature;
    expect(feature?.d1_databases?.[0]).toMatchObject({ binding: "DB" });
    expect(feature?.d1_databases?.[0]?.database_id).toBeTruthy();
    expect(feature?.kv_namespaces?.[0]).toMatchObject({ binding: "CACHE" });
    expect(feature?.r2_buckets?.[0]).toMatchObject({ binding: "ASSETS", bucket_name: r2Name });
  });

  /**
   * **The feature's address is looked up once and stamped where its Worker reads it (#643).** The script is
   * `acme-f69-demo--app` — project and Worker differ — and its origin is that name under the account's
   * `workers.dev` subdomain, which only the Cloudflare API knows; so the lookup is a seam, and asked once a run.
   */
  test("stamps each Worker's generated stanza with its workers.dev origin, asking the account once", async () => {
    const { provisioners } = fakeProvisioners();
    let lookups = 0;

    await provisionFeature({
      ...noBackend,
      projectDir: dir,
      capabilities,
      identity,
      provisioners,
      resolveWorkers: async () => [{ name: "app", dir: join(dir, "apps", "app"), capabilities }],
      workersSubdomain: async () => {
        lookups += 1;
        return "acme-sub";
      },
    });

    const wrangler = parse(await readFile(featureConfigPath(join(dir, "apps", "app")), "utf8")) as unknown as {
      env: Record<string, { name?: string; vars?: Record<string, string> }>;
    };
    expect(wrangler.env.feature?.name).toBe(featureWorkerName(identity, "app"));
    expect(wrangler.env.feature?.vars?.BASE_URL).toBe("https://acme-f69-demo--app.acme-sub.workers.dev");
    expect(lookups).toBe(1);
  });

  test("re-running is idempotent: every resource is reused, nothing new is created", async () => {
    const { provisioners, typed } = fakeProvisioners();
    const opts = { projectDir: dir, capabilities, identity, provisioners, ...noBackend };

    await provisionFeature(opts);
    const before = typed.d1.creates + typed.kv.creates + typed.r2.creates;
    expect(before).toBe(3);

    const second = await provisionFeature(opts);
    expect(second.resources.every((x) => x.created === false)).toBe(true);
    // No additional creates on the second run.
    expect(typed.d1.creates + typed.kv.creates + typed.r2.creates).toBe(before);
  });

  test("resumes a partial provision: reuses the already-created resource, creates only what is missing", async () => {
    const { stores, provisioners, typed } = fakeProvisioners();
    // Simulate a crash after D1 was created (and even recorded) but before KV/R2.
    stores.d1.set(featureResourceName(identity, "DB", "d1"), "pre-existing-d1");

    const report = await provisionFeature({
      projectDir: dir,
      capabilities,
      identity,
      provisioners,
      ...noBackend,
    });

    expect(report.resources.map((x) => [x.binding, x.created])).toEqual([
      ["DB", false], // reused
      ["CACHE", true],
      ["ASSETS", true],
    ]);
    expect(typed.d1.creates).toBe(0);
    expect(typed.kv.creates).toBe(1);
    expect(typed.r2.creates).toBe(1);
  });

  test("a Worker is wired only the bindings its own config declares", async () => {
    const { provisioners } = fakeProvisioners();
    const apiDir = join(dir, "apps", "api");
    const collabDir = join(dir, "apps", "collab");
    for (const workerDir of [apiDir, collabDir]) {
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(workerDir, "wrangler.jsonc"), '{\n  "name": "w"\n}\n');
    }

    // Both declare DB (so they share one database); only collab declares ROOMS.
    const shared = defineCapability({ name: "shared", requiredBindings: [{ type: "d1", name: "DB" }] });
    const collabOnly = defineCapability({
      name: "collabOnly",
      requiredBindings: [
        { type: "d1", name: "DB" },
        { type: "kv", name: "ROOMS" },
      ] as BindingSpecInput[],
    });

    await provisionFeature({
      administersItself: false,
      projectDir: dir,
      capabilities: [shared, collabOnly],
      identity,
      provisioners,
      resolveWorkers: async () => [
        { name: "api", dir: apiDir, capabilities: [shared] },
        { name: "collab", dir: collabDir, capabilities: [collabOnly] },
      ],
      migrate: async () => {},
      seed: async () => {},
    });

    const stanza = async (workerDir: string) => {
      const config = parse(await readFile(featureConfigPath(workerDir), "utf8")) as unknown as {
        env: Record<string, { d1_databases?: { binding: string }[]; kv_namespaces?: { binding: string }[] }>;
      };
      return config.env.feature;
    };
    const api = await stanza(apiDir);
    const collab = await stanza(collabDir);

    // The shared binding reaches both Workers; the binding only collab declares reaches only collab.
    expect(api?.d1_databases?.map((entry) => entry.binding)).toEqual(["DB"]);
    expect(collab?.d1_databases?.map((entry) => entry.binding)).toEqual(["DB"]);
    expect(collab?.kv_namespaces?.map((entry) => entry.binding)).toEqual(["ROOMS"]);
    // api never declared ROOMS, so its config must not carry it.
    expect(api?.kv_namespaces ?? []).toEqual([]);
  });

  test("names each Worker for the env and retargets service bindings at the feature's own deployments", async () => {
    const { provisioners } = fakeProvisioners();
    // Two workers that call each other, each with its own wrangler.jsonc.
    const apiDir = join(dir, "apps", "api");
    const webDir = join(dir, "apps", "web");
    for (const workerDir of [apiDir, webDir]) {
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(workerDir, "wrangler.jsonc"), '{\n  "name": "app"\n}\n');
    }

    const withService = defineCapability({
      name: "app",
      requiredBindings: [{ type: "service", name: "API", service: "api" }] satisfies BindingSpecInput[],
    });

    const report = await provisionFeature({
      administersItself: false,
      projectDir: dir,
      capabilities: [withService],
      identity,
      provisioners,
      resolveWorkers: async () => [
        { name: "api", dir: apiDir, capabilities: [withService] },
        { name: "web", dir: webDir, capabilities: [withService] },
      ],
      migrate: async () => {},
      seed: async () => {},
    });

    const apiName = featureWorkerName(identity, "api");
    expect(report.workers).toEqual([
      { worker: "api", name: apiName },
      { worker: "web", name: featureWorkerName(identity, "web") },
    ]);
    expect(report.services).toEqual([{ binding: "API", service: apiName }]);

    // The web worker's wrangler.jsonc now deploys under its feature name and calls the feature's api.
    const web = parse(await readFile(featureConfigPath(webDir), "utf8")) as unknown as {
      env: Record<string, { name?: string; services?: { binding: string; service: string }[] }>;
    };
    expect(web.env.feature?.name).toBe(featureWorkerName(identity, "web"));
    expect(web.env.feature?.services).toEqual([{ binding: "API", service: apiName }]);
  });

  /**
   * **One address per feature Worker, and it is `<project>-f<issue>-<slug>-<app>` (#587).**
   *
   * The normal state after `pithy init acme`: `apps/api` deploys as `acme-api`, not `api`. Two things
   * compose a feature Worker's address from that — the stanza `name` the deploy reads, and the `service`
   * target a sibling calls it by (which the report also prints) — and the property is that they are the
   * same string for every Worker, and that the string is built from the directory.
   *
   * Both halves have failed. Feature-scoping the *directory* on the service side only wrote `<feature>-api`
   * while the Worker deployed as `<feature>-acme-api`, so every RPC through `env.API` failed while
   * provision reported success. Feature-scoping the *deploy name* on both sides agreed, and put the project
   * in every feature Worker twice: `acme-f69-demo--acme-api`. The expected names are literals, not
   * `featureWorkerName` calls, so a doubled segment cannot pass by being fed the same wrong input twice.
   *
   * **What it does not see.** It holds `provisionFeature`, which is the only path that composes a feature
   * Worker's script name today. A new command that composed one without a `ProvisionScope` — calling
   * `featureWorkerName` directly, or `resourceNames(project).feature(...).worker(...)` — would not pass
   * through here, and that function takes a plain string that cannot tell a directory from a deploy name.
   */
  test("gives each feature Worker one address, built from its directory, that its deploy and its callers share", async () => {
    const { provisioners } = fakeProvisioners();
    const apiDir = join(dir, "apps", "api");
    const webDir = join(dir, "apps", "web");
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(apiDir, "wrangler.jsonc"), '{\n  "name": "acme-api"\n}\n');
    await mkdir(webDir, { recursive: true });
    await writeFile(join(webDir, "wrangler.jsonc"), '{\n  "name": "acme-web"\n}\n');

    // Each Worker calls the other, by its apps/<name> directory (BindingSpec.service), so every Worker's
    // address is both deployed under and called by.
    const callsApi = defineCapability({
      name: "app",
      requiredBindings: [{ type: "service", name: "API", service: "api" }] satisfies BindingSpecInput[],
    });
    const callsWeb = defineCapability({
      name: "web",
      requiredBindings: [{ type: "service", name: "WEB", service: "web" }] satisfies BindingSpecInput[],
    });

    const report = await provisionFeature({
      administersItself: false,
      projectDir: dir,
      capabilities: [callsApi, callsWeb],
      identity,
      provisioners,
      resolveWorkers: async () => [
        { name: "acme-api", dir: apiDir, capabilities: [callsWeb] },
        { name: "acme-web", dir: webDir, capabilities: [callsApi] },
      ],
      migrate: async () => {},
      seed: async () => {},
    });

    const expected = new Map([
      ["acme-api", { dir: apiDir, name: "acme-f69-demo--api", binding: "API" }],
      ["acme-web", { dir: webDir, name: "acme-f69-demo--web", binding: "WEB" }],
    ]);
    expect(report.workers).toEqual([...expected].map(([worker, { name }]) => ({ worker, name })));
    for (const [, { dir: workerDir, name, binding }] of expected) {
      const stanza = (
        parse(await readFile(featureConfigPath(workerDir), "utf8")) as unknown as {
          env: Record<string, { name?: string; services?: { binding: string; service: string }[] }>;
        }
      ).env.feature;
      // The address it deploys under…
      expect(stanza?.name).toBe(name);
      // …is the address every caller targets, in the report and in each sibling's own stanza.
      expect(report.services.filter((service) => service.binding === binding)).toEqual([{ binding, service: name }]);
      for (const [, sibling] of expected) {
        if (sibling.dir === workerDir) continue;
        const siblingStanza = (
          parse(await readFile(featureConfigPath(sibling.dir), "utf8")) as unknown as {
            env: Record<string, { services?: { binding: string; service: string }[] }>;
          }
        ).env.feature;
        expect(siblingStanza?.services).toEqual([{ binding, service: name }]);
      }
    }
  });

  test("a service binding naming no worker is refused before a single resource is created", async () => {
    const { provisioners, typed } = fakeProvisioners();
    const ghost = defineCapability({
      name: "app",
      requiredBindings: [
        { type: "d1", name: "DB" },
        { type: "service", name: "API", service: "ghost" },
      ] satisfies BindingSpecInput[],
    });

    const failure = await provisionFeature({
      administersItself: false,
      projectDir: dir,
      capabilities: [ghost],
      identity,
      provisioners,
      resolveWorkers: async () => [{ name: "app", dir: join(dir, "apps", "app"), capabilities: [ghost] }],
      migrate: async () => {},
      seed: async () => {},
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action).toMatch(/apps/);
    // Nothing was spent on a feature that could never have worked.
    expect(typed.d1.creates).toBe(0);
  });

  test("destroy deletes every manifest resource and removes the manifest file", async () => {
    const { stores, provisioners } = fakeProvisioners();
    await provisionFeature({ projectDir: dir, capabilities, identity, provisioners, ...noBackend });

    const report = await deprovisionFeature({
      ...noScripts,
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
    });

    expect(report.deleted.map((x) => x.kind).sort()).toEqual(["d1", "kv", "r2"]);
    expect(stores.d1.size + stores.kv.size + stores.r2.size).toBe(0);
    await expect(stat(manifestPath(dir))).rejects.toThrow();
  });

  test("destroy reconciles an un-manifested resource by its exact expected name, sparing foreign ones", async () => {
    const { stores, provisioners } = fakeProvisioners();
    // A partial provision that created CACHE's resource but never wrote a manifest.
    const orphan = featureResourceName(identity, "CACHE", "kv");
    stores.kv.set(orphan, "orphan-id");
    // A resource that is not one of this feature's expected names must be left untouched.
    stores.kv.set("acme-f42-other-cache-kv", "foreign-id");

    const report = await deprovisionFeature({
      ...noScripts,
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
    });

    expect(report.deleted).toEqual([{ kind: "kv", name: orphan, id: "orphan-id" }]);
    expect(stores.kv.has("acme-f42-other-cache-kv")).toBe(true);
  });

  test("destroy does not delete a sibling feature whose slug is a hyphen-prefix of this one's", async () => {
    const { stores, provisioners } = fakeProvisioners();
    // A sibling under the same project+issue whose slug ("demo-extended") starts with ours ("demo").
    const sibling = featureResourceName({ ...identity, slug: "demo-extended" }, "CACHE", "kv");
    stores.kv.set(sibling, "sibling-id");
    const ours = featureResourceName(identity, "CACHE", "kv");
    stores.kv.set(ours, "our-id");

    const report = await deprovisionFeature({
      ...noScripts,
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
    });

    expect(report.deleted).toEqual([{ kind: "kv", name: ours, id: "our-id" }]);
    expect(stores.kv.has(sibling)).toBe(true);
  });

  test("audits every resource it creates, and records nothing for one it merely reused", async () => {
    const { stores, provisioners } = fakeProvisioners();
    const events: CliAuditEvent[] = [];
    // DB already exists, so a resumed run reuses it — that is not a change and must not be recorded.
    stores.d1.set(featureResourceName(identity, "DB", "d1"), "pre-existing");

    await provisionFeature({
      administersItself: false,
      projectDir: dir,
      capabilities,
      identity,
      provisioners,
      audit: async (event) => void events.push(event),
      resolveWorkers: async () => [],
      migrate: async () => {},
      seed: async () => {},
    });

    expect(events.map((e) => e.action)).toEqual([
      ProvisionAuditActions.resourceCreated,
      ProvisionAuditActions.resourceCreated,
    ]);
    expect(events.map((e) => e.resourceType)).toEqual(["cf_kv", "cf_r2"]);
    expect(events[0]).toMatchObject({ outcome: "success", metadata: { binding: "CACHE", issue: "69" } });
  });

  test("audits every deletion as a warning — teardown destroys real infrastructure, often with no human watching", async () => {
    const { provisioners } = fakeProvisioners();
    await provisionFeature({ projectDir: dir, capabilities, identity, provisioners, ...noBackend });

    const events: CliAuditEvent[] = [];
    await deprovisionFeature({
      ...noScripts,
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
      audit: async (event) => void events.push(event),
    });

    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.action))).toEqual(new Set([ProvisionAuditActions.resourceDeleted]));
    expect(events.every((e) => e.severity === "warning")).toBe(true);
    expect(new Set(events.map((e) => e.resourceType))).toEqual(new Set(["cf_d1", "cf_kv", "cf_r2"]));
    // The deleted resource's id and name are both recorded — the "what exactly went" of the trail.
    expect(events[0]?.resourceId).toBeTruthy();
    expect(events[0]?.metadata?.name).toBeTruthy();
  });

  test("writes binding ids into each Worker's own wrangler.jsonc — an apps/ layout has no root one", async () => {
    const { provisioners } = fakeProvisioners();
    // Each Worker owns its wrangler.jsonc, and there is NO root one. Writing only to the project root used
    // to throw a raw ENOENT *after* creating the resources, leaving the real Workers without the bindings.
    const apiDir = join(dir, "apps", "api");
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(apiDir, "wrangler.jsonc"), '{\n  "name": "api"\n}\n');

    await provisionFeature({
      administersItself: false,
      projectDir: dir,
      capabilities,
      identity,
      provisioners,
      resolveWorkers: async () => [{ name: "api", dir: apiDir, capabilities }],
      migrate: async () => {},
      seed: async () => {},
    });

    const api = parse(await readFile(featureConfigPath(apiDir), "utf8")) as unknown as {
      env: Record<string, { name?: string; d1_databases?: { binding: string; database_id?: string }[] }>;
    };
    expect(api.env.feature?.name).toBe(featureWorkerName(identity, "api"));
    expect(api.env.feature?.d1_databases?.[0]).toMatchObject({ binding: "DB" });
    expect(api.env.feature?.d1_databases?.[0]?.database_id).toBeTruthy();
  });

  /**
   * **The gate for #242, and it is one sentence: provisioning a feature writes nothing a checkout
   * tracks.**
   *
   * Stated as a property of every byte on disk rather than as a list of files, because the list was
   * the problem. `wrangler.jsonc` is tracked and cannot be gitignored — it is the project's real
   * config — so a feature's ids sitting in it were a modified tracked file the adopter never edited,
   * with nothing saying it must not be committed. In CI that was fine by accident; locally `git add -A`
   * put ids for since-deleted resources onto `main`, and `feature destroy` reversed everything except
   * that edit.
   *
   * Two rules cover every path this can legitimately touch, and both are already in the scaffolded
   * `.gitignore` of every project ever created by `pithy init`: anything under a `.wrangler/`
   * directory, and `.pithy-feature.json`. A third would mean a new ignore rule, which existing
   * projects do not have — which is why the rule is the assertion rather than the file list.
   *
   * **This is the work `pithy provision --feature` does** (#251): the command surface changed spelling,
   * and the function it calls is this one — so the gate holds through the new spelling unchanged, which
   * is exactly what a command-surface change is allowed to leave alone.
   */
  test("writes nothing a checkout tracks", async () => {
    const { provisioners } = fakeProvisioners();
    const workerDir = join(dir, "apps", "app");
    const before = snapshot(dir);

    await provisionFeature({
      administersItself: false,
      projectDir: dir,
      capabilities,
      identity,
      provisioners,
      resolveWorkers: async () => [{ name: "acme-api", dir: workerDir, capabilities }],
      migrate: async () => {},
      seed: async () => {},
    });

    const after = snapshot(dir);
    const touched = [...after]
      .filter(([path, bytes]) => before.get(path) !== bytes)
      .map(([path]) => path)
      .sort();

    // Every path is one an existing project's `.gitignore` already covers. Nothing else moved — and in
    // particular the Worker's own `wrangler.jsonc` is byte-identical.
    expect(touched.filter((path) => !ignored(path))).toEqual([]);
    expect(touched.length).toBeGreaterThan(0); // non-vacuity: the run did write something.
    expect(after.get(join(workerDir, "wrangler.jsonc"))).toBe(before.get(join(workerDir, "wrangler.jsonc")));
    // And the ids really are somewhere — this is not "wrote nothing" passing as "wrote nothing tracked".
    const generated = parse(await readFile(featureConfigPath(workerDir), "utf8")) as unknown as {
      env: Record<string, { d1_databases?: { binding: string; database_id?: string }[] }>;
    };
    expect(generated.env.feature?.d1_databases?.[0]?.database_id).toBeTruthy();
  });

  describe("a manifest is repository content, not a trusted record", () => {
    /** Write a manifest by hand, as a crafted branch would carry one. */
    async function writeCraftedManifest(resources: FeatureResource[], header = identity): Promise<void> {
      await writeManifest(manifestPath(dir), {
        ...emptyManifest({ ...header, env: "feature" }),
        resources,
      });
    }

    test("destroy refuses to delete an id the manifest names but this feature could never have created", async () => {
      const { stores, provisioners } = fakeProvisioners();
      // A production database, listed under a plausible-looking name. For R2 the id IS the bucket name, and
      // D1/KV ids are conventionally committed in wrangler.jsonc — so none of this needs secret knowledge.
      stores.d1.set("acme-prod", "prod-d1-uuid");
      await writeCraftedManifest([{ kind: "d1", binding: "DB", name: "looks-legit", id: "prod-d1-uuid" }]);

      const report = await deprovisionFeature({
        ...noScripts,
        projectDir: dir,
        identity,
        capabilities,
        env: "feature",
        provisioners,
      });

      expect(report.deleted).toEqual([]);
      expect(stores.d1.get("acme-prod")).toBe("prod-d1-uuid"); // production survived
    });

    test("destroy still deletes a legitimately-recorded resource — the check does not break the real path", async () => {
      const { stores, provisioners } = fakeProvisioners();
      const name = featureResourceName(identity, "DB", "d1");
      stores.d1.set(name, "our-d1");
      await writeCraftedManifest([{ kind: "d1", binding: "DB", name, id: "our-d1" }]);

      const report = await deprovisionFeature({
        ...noScripts,
        projectDir: dir,
        identity,
        capabilities,
        env: "feature",
        provisioners,
      });

      expect(report.deleted).toEqual([{ kind: "d1", name, id: "our-d1" }]);
      expect(stores.d1.size).toBe(0);
    });

    test("a manifest whose header names another feature is refused outright, not silently ignored", async () => {
      const { provisioners } = fakeProvisioners();
      await writeCraftedManifest([], { project: "acme", issue: "999", slug: "someone-else" });

      await expect(
        deprovisionFeature({ ...noScripts, projectDir: dir, identity, capabilities, env: "feature", provisioners }),
      ).rejects.toThrow(/different feature/i);
    });

    test("provision does not launder a foreign entry forward into the manifest it rewrites", async () => {
      const { provisioners } = fakeProvisioners();
      await writeCraftedManifest([{ kind: "d1", binding: "DB", name: "looks-legit", id: "prod-d1-uuid" }]);

      await provisionFeature({
        administersItself: false,
        projectDir: dir,
        capabilities,
        identity,
        provisioners,
        resolveWorkers: async () => [],
        migrate: async () => {},
        seed: async () => {},
      });

      // Re-persisting it under a freshly-written, legitimate-looking header is what would make `destroy`
      // delete it later. It must be dropped instead.
      const manifest = await readManifest(manifestPath(dir));
      expect(manifest?.resources.some((resource) => resource.id === "prod-d1-uuid")).toBe(false);
      expect(manifest?.resources).toHaveLength(3); // exactly this feature's own DB/CACHE/ASSETS
    });
  });

  /**
   * #239: a feature environment got every resource except its secrets, so a Worker composing `secrets`
   * deployed and failed on its first request with `Missing required bindings:
   * secret:SECRETS_ENCRYPTION_KEYS`. Nothing told the adopter that secrets were the one thing they had
   * to arrange by hand for an environment pithy created from a branch name.
   */
  describe("a feature's secrets", () => {
    /** An in-memory Secrets Store, mirroring the real exists/put/remove semantics. */
    function fakeStore() {
      const entries = new Map<string, string>();
      return {
        entries,
        store: {
          storeId: "store-1",
          exists: async (name: string) => entries.has(name),
          put: async (name: string, value: string) => void entries.set(name, value),
          create: async (name: string, value: string) => {
            if (entries.has(name)) return "present" as const;
            entries.set(name, value);
            return "created" as const;
          },
          remove: async (name: string) => entries.delete(name),
        },
      };
    }

    const withSecrets = [secrets({ registry: {} })];

    /**
     * **The feature's secrets infrastructure, through the provisioner `pithy secrets provision` uses (#643)** —
     * the real `CloudflareSecretsProvisioner`, handed the feature, over a Cloudflare that is only this store.
     */
    function featureSecretsOver(entries: Map<string, string>) {
      const cf = {
        secrets: () => ({
          exists: async (name: string) => entries.has(name),
          putSecret: async (name: string, value: string) => void entries.set(name, value),
          createSecretIfAbsent: async (name: string, value: string) => {
            if (entries.has(name)) return "present";
            entries.set(name, value);
            return "created";
          },
        }),
        accountTokens: () => {
          throw new Error("a feature's provisioning reached for an account token");
        },
      } as unknown as CloudflareClients;
      return new CloudflareSecretsProvisioner({
        cf,
        account: { accountId: "acct-1", confirmation: "pinned" },
        project: identity.project,
        storeId: "store-1",
        deploy: async () => {
          throw new Error("a feature's manager deploys with its kit hosts");
        },
        feature: identity,
      });
    }

    test("mints the feature's own master key and binds it in every Worker that declares it", async () => {
      const { provisioners } = fakeProvisioners();
      const { entries, store } = fakeStore();

      const report = await provisionFeature({
        administersItself: false,
        projectDir: dir,
        capabilities: withSecrets,
        identity,
        provisioners,
        store,
        secrets: featureSecretsOver(entries),
        resolveWorkers: async () => [{ name: "acme-api", dir: join(dir, "apps", "app"), capabilities: withSecrets }],
        migrate: async () => {},
        seed: async () => {},
      });

      const entry = "acme-f69-demo--secrets-encryption-keys";
      // Its own key, under its own name — never staging's, which teardown would then delete. And no token: a
      // feature's manager holds none, so the store gains no token entry and no account token is minted (#643).
      expect([...entries.keys()].sort()).toEqual([entry]);
      expect(JSON.parse(entries.get(entry) as string)).toMatchObject({ currentVersion: "1" });
      // `minted: false` — the master key is `json` against `EncryptionConfig`, so it declares no
      // `devValue` and the #321 minter never touches it. The secrets provisioner creates it, above.
      expect(report.secretBindings).toEqual([
        { secret: "SECRETS_ENCRYPTION_KEYS", binding: "SECRETS_ENCRYPTION_KEYS", entry, bound: true, minted: false },
      ]);

      const wrangler = parse(await readFile(featureConfigPath(join(dir, "apps", "app")), "utf8")) as unknown as {
        env: Record<string, { secrets_store_secrets?: { binding: string; store_id: string; secret_name: string }[] }>;
      };
      expect(wrangler.env.feature?.secrets_store_secrets).toEqual([
        { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "store-1", secret_name: entry },
      ]);
    });

    /**
     * **The stanza a run writes binds a kebab-case key by its derived name (#603).** The cases above use keys
     * already in the binding shape, where the key and the binding cannot be told apart — the state the kit
     * was in when it wrote `"binding": "email-link-signing-key"`.
     */
    test("a kebab-case store secret is written into the stanza under its SCREAMING_SNAKE_CASE binding", async () => {
      const { provisioners } = fakeProvisioners();
      const { entries, store } = fakeStore();
      const kebab = [
        secrets({
          registry: {
            "link-signing-key": {
              backend: "cf-secrets-store",
              scope: "environment",
              rotatable: true,
              valueType: "text",
              devValue: "random",
            },
          },
        }),
      ];

      const report = await provisionFeature({
        administersItself: false,
        projectDir: dir,
        capabilities: kebab,
        identity,
        provisioners,
        store,
        secrets: featureSecretsOver(entries),
        resolveWorkers: async () => [{ name: "acme-api", dir: join(dir, "apps", "app"), capabilities: kebab }],
        migrate: async () => {},
        seed: async () => {},
      });

      // The entry keeps the key's name; the binding is the key in SCREAMING_SNAKE_CASE.
      expect(entries.has("acme-f69-demo--link-signing-key")).toBe(true);
      expect(report.secretBindings.find((secret) => secret.secret === "link-signing-key")).toEqual({
        secret: "link-signing-key",
        binding: "LINK_SIGNING_KEY",
        entry: "acme-f69-demo--link-signing-key",
        bound: true,
        minted: true,
      });
      const wrangler = parse(await readFile(featureConfigPath(join(dir, "apps", "app")), "utf8")) as unknown as {
        env: Record<string, { secrets_store_secrets?: { binding: string; store_id: string; secret_name: string }[] }>;
      };
      expect(wrangler.env.feature?.secrets_store_secrets?.map((entry) => entry.binding).sort()).toEqual([
        "LINK_SIGNING_KEY",
        "SECRETS_ENCRYPTION_KEYS",
      ]);
    });

    test("re-running leaves the key alone — a fresh one would orphan every secret under it", async () => {
      const { provisioners } = fakeProvisioners();
      const { entries, store } = fakeStore();
      const options = {
        projectDir: dir,
        capabilities: withSecrets,
        identity,
        provisioners,
        store,
        secrets: featureSecretsOver(entries),
        resolveWorkers: async () => [],
        migrate: async () => {},
        seed: async () => {},
        administersItself: false,
      };

      await provisionFeature(options);
      const first = entries.get("acme-f69-demo--secrets-encryption-keys");
      await provisionFeature(options);

      expect(entries.get("acme-f69-demo--secrets-encryption-keys")).toBe(first);
    });

    test("destroy removes the feature's entries and leaves an environment's alone", async () => {
      const { provisioners } = fakeProvisioners();
      const { entries, store } = fakeStore();
      // Staging's key, in the same flat account-wide store. Teardown must not reach it.
      entries.set("acme-staging-secrets-encryption-keys", "staging's");

      await provisionFeature({
        administersItself: false,
        projectDir: dir,
        capabilities: withSecrets,
        identity,
        provisioners,
        store,
        secrets: featureSecretsOver(entries),
        resolveWorkers: async () => [],
        migrate: async () => {},
        seed: async () => {},
      });
      expect(entries.has("acme-f69-demo--secrets-encryption-keys")).toBe(true);

      await deprovisionFeature({
        ...noScripts,
        projectDir: dir,
        identity,
        capabilities: withSecrets,
        env: "feature",
        provisioners,
        store,
      });

      expect([...entries.keys()]).toEqual(["acme-staging-secrets-encryption-keys"]);
    });

    /**
     * #321: `pithy feature` promises "an isolated, fully-provisioned feature environment", and one that
     * printed `pithy secrets create` three times was not that — once per branch, forever. The registry
     * already said which of those values were arbitrary; only local dev read it.
     */
    describe("secrets the registry says may be minted", () => {
      /** One arbitrary value, one somebody else issued. The whole distinction, in two entries. */
      const withRegistry = [
        secrets({
          registry: {
            RELEASE_INGEST_SECRET: {
              backend: "cf-secrets-store",
              scope: "environment",
              rotatable: true,
              valueType: "text",
              devValue: "random",
            },
            STRIPE_SECRET_KEY: {
              backend: "cf-secrets-store",
              scope: "environment",
              rotatable: false,
              valueType: "text",
            },
          },
        }),
      ];

      test("creates the arbitrary one, binds it, and still stops for the supplied one", async () => {
        const { provisioners } = fakeProvisioners();
        const { entries, store } = fakeStore();

        const report = await provisionFeature({
          administersItself: false,
          projectDir: dir,
          capabilities: withRegistry,
          identity,
          provisioners,
          store,
          secrets: featureSecretsOver(entries),
          resolveWorkers: async () => [{ name: "acme-api", dir: join(dir, "apps", "app"), capabilities: withRegistry }],
          migrate: async () => {},
          seed: async () => {},
        });

        const ingest = report.secretBindings.find((secret) => secret.binding === "RELEASE_INGEST_SECRET");
        expect(ingest).toEqual({
          secret: "RELEASE_INGEST_SECRET",
          binding: "RELEASE_INGEST_SECRET",
          entry: "acme-f69-demo--release-ingest-secret",
          bound: true,
          minted: true,
        });
        // A value went in, as the uniform envelope every other secret of this backend is stored as.
        expect(JSON.parse(entries.get("acme-f69-demo--release-ingest-secret") as string)).toMatchObject({
          currentVersion: "1",
        });

        // A random string authenticates against nothing. This one stays a question for a human.
        expect(report.secretBindings.find((secret) => secret.binding === "STRIPE_SECRET_KEY")).toMatchObject({
          bound: false,
          minted: false,
        });
        expect(entries.has("acme-f69-demo--stripe-secret-key")).toBe(false);

        const wrangler = parse(await readFile(featureConfigPath(join(dir, "apps", "app")), "utf8")) as unknown as {
          env: Record<string, { secrets_store_secrets?: { binding: string }[] }>;
        };
        expect(wrangler.env.feature?.secrets_store_secrets?.map((binding) => binding.binding)).toEqual([
          "SECRETS_ENCRYPTION_KEYS",
          "RELEASE_INGEST_SECRET",
        ]);
      });

      test("re-running never replaces a minted value", async () => {
        const { provisioners } = fakeProvisioners();
        const { entries, store } = fakeStore();
        const options = {
          projectDir: dir,
          capabilities: withRegistry,
          identity,
          provisioners,
          store,
          secrets: featureSecretsOver(entries),
          resolveWorkers: async () => [{ name: "acme-api", dir: join(dir, "apps", "app"), capabilities: withRegistry }],
          migrate: async () => {},
          seed: async () => {},
          administersItself: false,
        };

        const first = await provisionFeature(options);
        const value = entries.get("acme-f69-demo--release-ingest-secret");
        const second = await provisionFeature(options);

        expect(first.secretBindings.find((secret) => secret.binding === "RELEASE_INGEST_SECRET")?.minted).toBe(true);
        expect(second.secretBindings.find((secret) => secret.binding === "RELEASE_INGEST_SECRET")?.minted).toBe(false);
        expect(entries.get("acme-f69-demo--release-ingest-secret")).toBe(value);
      });

      /** The trail says a secret was created and where. It never says what. */
      test("audits the creation without the value", async () => {
        const { provisioners } = fakeProvisioners();
        const { entries, store } = fakeStore();
        const events: CliAuditEvent[] = [];

        await provisionFeature({
          administersItself: false,
          projectDir: dir,
          capabilities: withRegistry,
          identity,
          provisioners,
          store,
          secrets: featureSecretsOver(entries),
          resolveWorkers: async () => [{ name: "acme-api", dir: join(dir, "apps", "app"), capabilities: withRegistry }],
          migrate: async () => {},
          seed: async () => {},
          audit: async (event) => void events.push(event),
        });

        const created = events.filter((event) => event.resourceType === "secret");
        expect(created.map((event) => event.resourceId)).toEqual(["acme-f69-demo--release-ingest-secret"]);
        const envelope = entries.get("acme-f69-demo--release-ingest-secret") as string;
        const value = (JSON.parse(envelope) as { versions: Record<string, string> }).versions["1"];
        expect(JSON.stringify(events)).not.toContain(value);
      });
    });

    test("without a store the feature provisions exactly as before, and the report says so", async () => {
      const { provisioners } = fakeProvisioners();
      const report = await provisionFeature({
        projectDir: dir,
        capabilities: withSecrets,
        identity,
        provisioners,
        ...noBackend,
      });
      expect(report.secretBindings).toEqual([]);
    });
  });

  test("destroy is idempotent: no manifest and nothing to reconcile exits cleanly with no deletions", async () => {
    const { provisioners } = fakeProvisioners();
    const report = await deprovisionFeature({
      ...noScripts,
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
    });
    expect(report.deleted).toEqual([]);
  });
});

/**
 * **A teardown that failed partway still says what it destroyed (#380).**
 *
 * `deprovisionFeature` deletes real infrastructure one resource at a time, with no transaction across
 * them, and `deleted` is the whole product of the command. A throw from the third delete used to take
 * the record of the first two with it — the databases were gone, and what had gone was not written
 * down anywhere. These tests exist to fail when that carry is removed.
 */
describe("deprovisionFeature — a delete that throws", () => {
  let dir: string;
  const identity: FeatureIdentity = { project: "acme", issue: "69", slug: "demo" };
  const capabilities = [appCapability()];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-feature-fail-"));
    await mkdir(join(dir, "apps", "app"), { recursive: true });
    await writeFile(join(dir, "apps", "app", "wrangler.jsonc"), '{\n  "name": "app"\n}\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Provision the feature, then break one kind's delete. Returns whatever the teardown threw. */
  async function tornDownWith(broken: "d1" | "kv" | "r2"): Promise<unknown> {
    const { provisioners, typed } = fakeProvisioners();
    await provisionFeature({ projectDir: dir, capabilities, identity, provisioners, ...noBackend });
    // The plant, in the seam the run already takes. Synchronous on purpose: a `.catch()` guard would
    // not see a seam that throws before it returns a promise, and #371's plant escaped exactly one.
    typed[broken].delete = () => {
      throw new Error("planted: this resource will not delete");
    };
    return await deprovisionFeature({
      ...noScripts,
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
    }).then(
      () => {
        throw new Error("expected the planted delete to fail the teardown");
      },
      (error: unknown) => error,
    );
  }

  test("names the resources that were destroyed before it failed", async () => {
    // d1 is the first of the three in the manifest, so kv's failure comes after it went.
    const deleted = deletedBeforeFailure(await tornDownWith("kv"));
    expect(deleted.map((resource) => resource.kind)).toEqual(["d1"]);
    expect(deleted[0]).toMatchObject({ kind: "d1", name: featureResourceName(identity, "DB", "d1") });
  });

  test("carries nothing derived from the throw — kind, name and id, and no reason", async () => {
    const deleted = deletedBeforeFailure(await tornDownWith("kv"));
    expect(Object.keys(deleted[0] ?? {}).sort()).toEqual(["id", "kind", "name"]);
    expect(JSON.stringify(deleted)).not.toContain("planted");
  });

  test("keeps the manifest, because it is the record of what is left to delete", async () => {
    await tornDownWith("kv");
    await expect(stat(manifestPath(dir))).resolves.toBeDefined();
  });

  test("a teardown that succeeds carries no report, and neither does an unrelated throw", async () => {
    const { provisioners } = fakeProvisioners();
    await provisionFeature({ projectDir: dir, capabilities, identity, provisioners, ...noBackend });
    await deprovisionFeature({ ...noScripts, projectDir: dir, identity, capabilities, env: "feature", provisioners });
    expect(deletedBeforeFailure(new Error("unrelated"))).toEqual([]);
  });
});

/**
 * **A feature's Worker scripts are torn down with it (#592).**
 *
 * `destroy` handled D1, KV, R2 and Secrets Store entries, and the manifest could not record a Worker
 * script at all. Every feature therefore left its scripts deployed, reachable on workers.dev and bound to
 * resources teardown had just deleted — one set per branch, forever.
 */
describe("a feature's Worker scripts", () => {
  let dir: string;
  const identity: FeatureIdentity = { project: "acme", issue: "69", slug: "demo" };
  const capabilities = [appCapability()];
  /** The normal state after `pithy init acme`: `apps/api` deploys as `acme-api`. */
  let workers: { name: string; dir: string; capabilities: typeof capabilities }[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-feature-scripts-"));
    workers = [];
    for (const app of ["api", "web"]) {
      const workerDir = join(dir, "apps", app);
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(workerDir, "wrangler.jsonc"), `{\n  "name": "acme-${app}"\n}\n`);
      workers.push({ name: `acme-${app}`, dir: workerDir, capabilities });
    }
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The script half of the account, by name, mirroring the real exists/delete semantics. */
  function fakeScripts(deployed: Iterable<string> = []) {
    const scripts = new Set(deployed);
    const deletes: string[] = [];
    return {
      deployed: scripts,
      deletes,
      seam: {
        exists: async (name: string) => scripts.has(name),
        delete: async (name: string) => {
          deletes.push(name);
          scripts.delete(name);
        },
      },
    };
  }

  const provision = (provisioners: ResourceProvisioners) =>
    provisionFeature({
      administersItself: false,
      projectDir: dir,
      capabilities,
      identity,
      provisioners,
      resolveWorkers: async () => workers,
      migrate: async () => {},
      seed: async () => {},
    });

  test("provision records every script it names, with the two names each was composed from", async () => {
    await provision(fakeProvisioners().provisioners);

    const manifest = await readManifest(manifestPath(dir));
    // Literals, so a doubled segment cannot pass by being composed the same wrong way twice.
    expect(manifest?.scripts).toEqual([
      { app: "api", script: "acme-api", name: "acme-f69-demo--api" },
      { app: "web", script: "acme-web", name: "acme-f69-demo--web" },
    ]);
  });

  /**
   * **The feature's own email host goes with the feature (#643).** Provisioning deploys it under a name composed
   * from the branch, so teardown recomputes that name and deletes it — whatever the branch composes now, since a
   * host deployed before email was removed is still this feature's — and never another branch's host or a
   * declared environment's.
   */
  test("destroy deletes the feature's email host by the name provisioning deployed it under", async () => {
    const { provisioners } = fakeProvisioners();
    const scripts = fakeScripts(["acme-f69-demo--email", "acme-f70-demo-email", "acme-staging-email"]);

    const report = await deprovisionFeature({
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
      scripts: scripts.seam,
      ...noWorkflows(),
      workers: [],
    });

    expect(scripts.deletes).toEqual(["acme-f69-demo--email"]);
    expect(report.deleted).toContainEqual({ kind: "worker", name: "acme-f69-demo--email", id: "acme-f69-demo--email" });
  });

  test("destroy deletes each deployed script after confirming it is there, and reports each", async () => {
    const { provisioners } = fakeProvisioners();
    await provision(provisioners);
    // web was provisioned and never deployed: there is nothing to delete, and nothing to report.
    const scripts = fakeScripts(["acme-f69-demo--api"]);

    const report = await deprovisionFeature({
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
      scripts: scripts.seam,
      ...noWorkflows(),
      workers,
    });

    expect(report.deleted.filter((entry) => entry.kind === "worker")).toEqual([
      { kind: "worker", name: "acme-f69-demo--api", id: "acme-f69-demo--api" },
    ]);
    expect(scripts.deletes).toEqual(["acme-f69-demo--api"]);
  });

  test("a feature provisioned before scripts were recorded is found by both naming shapes, and nothing else", async () => {
    const { provisioners } = fakeProvisioners();
    // A manifest from before #592, with no `scripts` at all.
    await writeFile(
      manifestPath(dir),
      JSON.stringify({ version: 1, project: "acme", issue: "69", slug: "demo", env: "feature", resources: [] }),
    );
    const scripts = fakeScripts([
      // Deployed before #587, when the project came twice.
      "acme-f69-demo--acme-api",
      // Redeployed since, under the single shape.
      "acme-f69-demo--api",
      // Not this feature's: staging, another issue, and a sibling whose slug extends this one's.
      "acme-staging-api",
      "acme-f70-demo-api",
      "acme-f69-demo--extended-api",
    ]);

    const report = await deprovisionFeature({
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
      scripts: scripts.seam,
      ...noWorkflows(),
      workers,
    });

    expect(report.deleted.map((entry) => entry.name).sort()).toEqual(["acme-f69-demo--acme-api", "acme-f69-demo--api"]);
    expect([...scripts.deployed].sort()).toEqual([
      "acme-f69-demo--extended-api",
      "acme-f70-demo-api",
      "acme-staging-api",
    ]);
  });

  /**
   * **What a feature provisioned before #592 is not torn down by.** With a Secrets Store, its generated config
   * lost the script name, and wrangler deployed it as `<script>-feature` — `acme-api-feature`. That name carries
   * no issue and no slug, and every such branch of the project deployed over the same one, so it is not this
   * feature's to delete: taking it would take down whichever open branch deployed last. Teardown leaves it,
   * and the docs say to delete it by hand once no branch is live.
   */
  test("a pre-#592 feature's `<script>-feature` Worker is left, because no feature owns that name", async () => {
    const { provisioners } = fakeProvisioners();
    await writeFile(
      manifestPath(dir),
      JSON.stringify({ version: 1, project: "acme", issue: "69", slug: "demo", env: "feature", resources: [] }),
    );
    const scripts = fakeScripts(["acme-api-feature", "acme-web-feature", "acme-f69-demo--api"]);

    const report = await deprovisionFeature({
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
      scripts: scripts.seam,
      ...noWorkflows(),
      workers,
    });

    expect(report.deleted.map((entry) => entry.name)).toEqual(["acme-f69-demo--api"]);
    expect([...scripts.deployed].sort()).toEqual(["acme-api-feature", "acme-web-feature"]);
  });

  test("a recorded script whose Worker has left the branch is still deleted", async () => {
    const { provisioners } = fakeProvisioners();
    await provision(provisioners);
    const scripts = fakeScripts(["acme-f69-demo--web"]);

    // apps/web was removed after it deployed, so the Worker set no longer names it. The manifest does.
    const report = await deprovisionFeature({
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
      scripts: scripts.seam,
      ...noWorkflows(),
      workers: workers.filter((worker) => worker.name !== "acme-web"),
    });

    expect(report.deleted.map((entry) => entry.name)).toContain("acme-f69-demo--web");
    expect(scripts.deployed.size).toBe(0);
  });

  test("destroy refuses a recorded script this feature could never have named", async () => {
    const { provisioners } = fakeProvisioners();
    await writeManifest(manifestPath(dir), {
      ...emptyManifest({ ...identity, env: "feature" }),
      // A crafted branch, pointing teardown at production under a plausible-looking entry.
      scripts: [{ app: "api", script: "acme-api", name: "acme-prod-api" }],
    });
    const scripts = fakeScripts(["acme-prod-api"]);

    const report = await deprovisionFeature({
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
      scripts: scripts.seam,
      ...noWorkflows(),
      workers: [],
    });

    expect(report.deleted).toEqual([]);
    expect(scripts.deployed.has("acme-prod-api")).toBe(true);
  });

  test("provision does not launder a foreign script forward into the manifest it rewrites", async () => {
    await writeManifest(manifestPath(dir), {
      ...emptyManifest({ ...identity, env: "feature" }),
      scripts: [{ app: "api", script: "acme-api", name: "acme-prod-api" }],
    });

    await provision(fakeProvisioners().provisioners);

    const manifest = await readManifest(manifestPath(dir));
    expect(manifest?.scripts.map((script) => script.name)).toEqual(["acme-f69-demo--api", "acme-f69-demo--web"]);
  });

  test("audits every script deletion as a warning, like every other teardown", async () => {
    const { provisioners } = fakeProvisioners();
    await provision(provisioners);
    const events: CliAuditEvent[] = [];

    await deprovisionFeature({
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
      scripts: fakeScripts(["acme-f69-demo--api"]).seam,
      ...noWorkflows(),
      workers,
      audit: async (event) => void events.push(event),
    });

    expect(events.find((event) => event.resourceId === "acme-f69-demo--api")).toMatchObject({
      action: ProvisionAuditActions.resourceDeleted,
      severity: "warning",
      resourceType: "cf_worker",
    });
  });
});

/**
 * **The gate for #592: everything provisioning and deploy put on the account, teardown takes off it.**
 *
 * Stated over the account and the manifest rather than as a list of kinds, because a list of kinds was the
 * defect. Teardown knew D1, KV, R2 and store entries by name, and a Worker script was not on the list, so
 * nothing ever deleted one and nothing ever failed for it.
 *
 * The account is one map per kind, and it answers **whatever kind it is asked for**: the provisioner set
 * is a proxy, so a provisioning step that starts creating a kind nobody taught teardown lands in the
 * account and fails the equality below. Deploy is stubbed the way wrangler names a feature Worker — from
 * `env.feature.name` in the generated config provisioning wrote — so a script is on the account under the
 * name the deploy would really use, not under the name the manifest claims.
 *
 * Two properties, both required:
 *
 * 1. **The account after teardown is the account before provisioning.** Every name the run added is gone,
 *    and every name that was there first — staging's, a sibling feature's — is still there.
 * 2. **Every entry the manifest records is among what teardown reports deleting**, read off the manifest's
 *    own arrays, whatever they are called. A record nobody acts on is the shape this issue was.
 *
 * **The account refuses what Cloudflare refuses.** `web` binds `api` as a service, as a scaffolded front end
 * calls its API, and the stubbed Workers manager refuses to delete a script another deployed script still
 * binds unless the delete is forced — `DELETE /workers/scripts/<name>` without `force`. Teardown reaches it
 * through the real `cloudflareWorkerScripts`, so the decision to force is the production one, not a stub's.
 * `api` sorts first, so an unforced teardown fails on it before a single resource is touched, every run.
 *
 * The run hands teardown the whole Worker set, so a script the recomputation finds satisfies (2) even if
 * nothing read the manifest's copy of it. The manifest-only path — a Worker removed from the branch after
 * it deployed — is held by *a recorded script whose Worker has left the branch* above, not by this.
 *
 * **What it does not see.** Anything created outside the three seams provisioning is handed — the
 * resource provisioners, the Secrets Store, and the name deploy reads from the generated config. A
 * capability's own provisioner calling `CloudflareClients` directly, or `pithy deploy --kit` shipping a kit
 * Worker into the feature environment under a name its host template composes, would put things on a
 * real account this stub never hears about. So would anything a script carries with it — routes, custom
 * domains, Durable Object storage — and an R2 bucket's objects. And the refusal is Cloudflare's as its API
 * spec and wrangler's `delete` describe it, not observed on a live account: that the manager puts `force` on
 * the SDK call is held by `workersManager.test.ts`, and this stub sees only that the manager was asked to.
 */
describe("teardown reverses everything provisioning and deploy create (#592)", () => {
  let dir: string;
  const identity: FeatureIdentity = { project: "acme", issue: "69", slug: "demo" };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-feature-gate-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** One stubbed Cloudflare account: every kind, by name, and the seams provisioning and teardown take. */
  function stubAccount() {
    const kinds = new Map<string, Map<string, string>>();
    const holding = (kind: string): Map<string, string> => {
      let names = kinds.get(kind);
      if (!names) {
        names = new Map();
        kinds.set(kind, names);
      }
      return names;
    };
    const byKind = new Map<string, ResourceProvisioner>();
    const provisioners = new Proxy({} as ResourceProvisioners, {
      get: (_target, kind) => {
        if (typeof kind !== "string") return undefined;
        let provisioner = byKind.get(kind);
        if (!provisioner) {
          provisioner = fakeKind(kind, holding(kind));
          byKind.set(kind, provisioner);
        }
        return provisioner;
      },
    });
    const store = {
      storeId: "store-1",
      exists: async (name: string) => holding("secret").has(name),
      put: async (name: string, value: string) => void holding("secret").set(name, value),
      create: async (name: string, value: string) => {
        if (holding("secret").has(name)) return "present" as const;
        holding("secret").set(name, value);
        return "created" as const;
      },
      remove: async (name: string) => holding("secret").delete(name),
    };
    /** Each deployed script's `services` targets, as its deploy uploaded them. */
    const serviceTargets = new Map<string, string[]>();
    const workersManager = {
      getWorker: async (name: string) => (holding("worker").has(name) ? { id: name } : null),
      deleteWorker: async (name: string, options?: { force?: boolean }) => {
        const callers = [...holding("worker").keys()].filter(
          (other) => other !== name && (serviceTargets.get(other) ?? []).includes(name),
        );
        if (callers.length > 0 && options?.force !== true) {
          throw new Error(`Cloudflare refused to delete ${name}: ${callers.join(", ")} binds it.`);
        }
        holding("worker").delete(name);
        serviceTargets.delete(name);
      },
    };
    const scripts = cloudflareWorkerScripts({ workers: () => workersManager } as unknown as CloudflareClients, {
      accountId: "acct-ours",
      confirmation: "pinned",
    });
    /** Every name on the account, as `kind:name`, sorted — the oracle. */
    const contents = () =>
      [...kinds].flatMap(([kind, names]) => [...names.keys()].map((name) => `${kind}:${name}`)).sort();
    return { provisioners, store, scripts, serviceTargets, holding, contents };
  }

  test("after provision, deploy and destroy, the account holds exactly what it held before", async () => {
    const account = stubAccount();
    const composed = [
      appCapability(),
      secrets({
        registry: {
          RELEASE_INGEST_SECRET: {
            backend: "cf-secrets-store",
            scope: "environment",
            rotatable: true,
            valueType: "text",
            devValue: "random",
          },
        },
      }),
    ];
    // The front end calls the API: the layout where the callee sorts first.
    const callsApi = defineCapability({
      name: "calls-api",
      requiredBindings: [{ type: "service", name: "API", service: "api" }] satisfies BindingSpecInput[],
    });
    const workers: ProvisionWorker[] = [];
    for (const app of ["api", "web"]) {
      const workerDir = join(dir, "apps", app);
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(workerDir, "wrangler.jsonc"), `{\n  "name": "acme-${app}"\n}\n`);
      workers.push({
        name: `acme-${app}`,
        dir: workerDir,
        capabilities: app === "web" ? [...composed, callsApi] : composed,
      });
    }

    // What is not this feature's, and must survive it.
    account.holding("worker").set("acme-staging-api", "acme-staging-api");
    account.holding("worker").set("acme-f70-demo-api", "acme-f70-demo-api");
    account.holding("d1").set("acme-staging-db", "staging-d1");
    account.holding("secret").set("acme-staging-secrets-encryption-keys", "staging's");
    const before = account.contents();

    await provisionFeature({
      administersItself: false,
      projectDir: dir,
      capabilities: [...composed, callsApi],
      identity,
      provisioners: account.provisioners,
      store: account.store,
      resolveWorkers: async () => workers,
      migrate: async () => {},
      seed: async () => {},
    });
    // Deploy, as wrangler names it: `--env feature` reads the stanza name out of the generated config.
    for (const worker of workers) {
      const generated = parse(await readFile(featureConfigPath(worker.dir), "utf8")) as unknown as {
        env: Record<string, { name?: string; services?: { service: string }[] }>;
      };
      const name = generated.env.feature?.name;
      if (name === undefined) throw new Error(`provisioning wrote no script name for ${worker.dir}`);
      account.holding("worker").set(name, name);
      account.serviceTargets.set(
        name,
        (generated.env.feature?.services ?? []).map((entry) => entry.service),
      );
    }
    // Non-vacuity for the refusal: a deployed script really does bind a sibling.
    expect(account.serviceTargets.get("acme-f69-demo--web")).toEqual(["acme-f69-demo--api"]);
    const deployed = account.contents();
    const manifest = await readManifest(manifestPath(dir));

    const report = await deprovisionFeature({
      projectDir: dir,
      identity,
      capabilities: [...composed, callsApi],
      env: "feature",
      provisioners: account.provisioners,
      store: account.store,
      scripts: account.scripts,
      ...noWorkflows(),
      workers,
    });

    // Non-vacuity: the run really did put things on the account, of more than one kind.
    const added = deployed.filter((entry) => !before.includes(entry));
    expect(new Set(added.map((entry) => entry.split(":")[0])).size).toBeGreaterThan(2);

    // 1. Everything the run added is gone, and nothing that was there first went with it.
    expect(account.contents()).toEqual(before);

    // 2. Every entry the manifest records, under whatever array it lives in, was deleted.
    const recorded = Object.values(manifest ?? {}).flatMap((value): { name: string }[] =>
      Array.isArray(value) ? value : [],
    );
    expect(recorded.length).toBeGreaterThan(0);
    const deletedNames = report.deleted.map((entry) => entry.name);
    for (const entry of recorded) expect(deletedNames).toContain(entry.name);
  });
});

/**
 * **#650: a feature deployment had none of the app's own Workflows, so it answered 500.**
 *
 * `pithy provision --feature` derived a feature name for every kit host's Workflow and nothing for the ones the
 * adopter declares in their own `pithy.config.ts`, whose classes are exported by their own Worker. Staging and
 * prod carry theirs — `pithy worker sync` writes them into the tracked `wrangler.jsonc` — and the feature's
 * stanza is regenerated from that file on every run with every binding array emptied, so a branch deployed with
 * no `CONNECTION_ROTATION` and no `ROTATION_SWEEP` and failed `validateBindings` on the first request,
 * `/health` included.
 *
 * The proof is the whole way through: the real provisioning run, the config it generated, and a Worker composed
 * from **that file's** bindings answering a request. A test that read the stanza and stopped would pass on a
 * table of plausible-looking strings that no Worker could boot on.
 */
describe("a feature deployment serves a request (#650)", () => {
  let dir: string;
  const identity: FeatureIdentity = { project: "acme", issue: "650", slug: "app-workflows" };

  /** The adopter's own app capability: two Workflows whose classes are exported by this Worker's own `main`. */
  const board = defineCapability({
    name: "board",
    requiredBindings: [{ type: "kv", name: "CACHE" }],
    workflows: {
      rotate: {
        binding: "CONNECTION_ROTATION",
        params: z.object({}),
        className: "ConnectionRotationWorkflow",
        schedule: "0 4 * * *",
      },
      sweep: { binding: "ROTATION_SWEEP", params: z.object({}), className: "RotationSweepWorkflow" },
    },
  });

  /**
   * A kit host's capability, named for a registry entry so `hostedWorkflowEntries` treats it as one. Composed
   * beside the app so the two kinds of `workflows` entry meet in one stanza, which is where the fix could most
   * easily take the other's entries with it.
   */
  const emailHost = defineCapability({
    name: "email",
    requiredBindings: [{ type: "workflow", name: "EMAIL_SENDER", job: "send", className: "EmailSendWorkflow" }],
    workflows: {
      send: { binding: "EMAIL_SENDER", params: z.object({}), className: "EmailSendWorkflow" },
    },
  });

  const capabilities = [emailHost, board];

  /** The generated feature stanza, read back off disk — the only source of the bindings below. */
  interface GeneratedStanza {
    vars?: Record<string, unknown>;
    workflows?: { binding: string; name: string; class_name: string; script_name?: string }[];
    kv_namespaces?: { binding: string; id: string }[];
    durable_objects?: { bindings?: { name: string }[] };
    ratelimits?: { name: string }[];
    triggers?: { crons?: string[] };
  }

  const generated = async (): Promise<GeneratedStanza> =>
    (
      parse(await readFile(featureConfigPath(join(dir, "apps", "board")), "utf8")) as unknown as {
        env: Record<string, GeneratedStanza>;
      }
    ).env.feature as GeneratedStanza;

  /**
   * The Worker's `env`, built from the generated stanza and from nothing else — every binding the config
   * declares, under the name the config gives it. A binding the file does not carry is a binding the deployed
   * Worker does not have, which is exactly what the 500 was.
   */
  function envFromStanza(stanza: GeneratedStanza): Record<string, unknown> {
    const env: Record<string, unknown> = { ...stanza.vars };
    for (const entry of stanza.workflows ?? []) env[entry.binding] = { create: async () => ({}) };
    for (const entry of stanza.kv_namespaces ?? []) env[entry.binding] = {};
    for (const entry of stanza.durable_objects?.bindings ?? []) env[entry.name] = {};
    for (const entry of stanza.ratelimits ?? []) env[entry.name] = {};
    return env;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-feature-650-"));
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(
      join(dir, "apps", "board", "wrangler.jsonc"),
      JSON.stringify({ name: "acme-board", main: "src/index.ts", kv_namespaces: [{ binding: "CACHE" }] }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** One real provisioning run over stubbed Cloudflare, with the kit host deploying as it would. */
  async function provision(): Promise<void> {
    const { provisioners } = fakeProvisioners();
    await provisionFeature({
      administersItself: false,
      projectDir: dir,
      capabilities,
      identity,
      provisioners,
      resolveWorkers: async () => [
        {
          name: "acme-board",
          dir: join(dir, "apps", "board"),
          capabilities,
          // The Worker's own `pithy.config.ts`: the libraries it composes, and its app.
          config: { capabilities: [emailHost], app: board },
        },
      ],
      migrate: async () => {},
      seed: async () => {},
      deployHosts: async () => ({
        workers: [{ capability: "email", worker: "acme-f650-app-workflows--email", outcome: "deployed", reason: "" }],
        problems: [],
      }),
    });
  }

  test("the generated stanza carries the app's own Workflows beside the kit host's", async () => {
    await provision();
    expect((await generated()).workflows).toEqual([
      {
        binding: "CONNECTION_ROTATION",
        name: "acme-f650-app-workflows--board-rotate",
        class_name: "ConnectionRotationWorkflow",
      },
      {
        binding: "ROTATION_SWEEP",
        name: "acme-f650-app-workflows--board-sweep",
        class_name: "RotationSweepWorkflow",
      },
      {
        binding: "EMAIL_SENDER",
        name: "acme-f650-app-workflows--email-send",
        class_name: "EmailSendWorkflow",
        script_name: "acme-f650-app-workflows--email",
      },
    ]);
  });

  test("every Workflow name it wrote is this feature's own", async () => {
    await provision();
    const entries = (await generated()).workflows ?? [];
    expect(entries).toHaveLength(3);
    for (const entry of entries) expect(isFeatureOwnedName(identity, entry.name)).toBe(true);
  });

  /**
   * **The end of it: a Worker composed from the generated config answers.** `createBackend` derives a
   * `workflow` binding spec from every registered job, so a stanza missing one fails `validateBindings` on the
   * first request with the 500 this issue was opened on.
   */
  test("the Worker composed from that stanza serves /health", async () => {
    await provision();
    const worker = createBackend({ capabilities: [emailHost], app: board });
    const res = await worker.request("/health", {}, envFromStanza(await generated()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  /**
   * Non-vacuity, and the failure as the adopter met it: take the app's own entries back out of the very config
   * the run wrote, and the same Worker answers 500 naming both bindings. So the request above passes because
   * the stanza carries them, not because nothing was ever checked.
   */
  test("and answers 500 naming both bindings when the stanza is stripped of them", async () => {
    await provision();
    const stanza = await generated();
    const worker = createBackend({ capabilities: [emailHost], app: board });
    const stripped = { ...stanza, workflows: (stanza.workflows ?? []).filter((e) => e.script_name !== undefined) };
    const res = await worker.request("/health", {}, envFromStanza(stripped));
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(
      /Missing required bindings: workflow:CONNECTION_ROTATION, workflow:ROTATION_SWEEP/,
    );
  });
});
