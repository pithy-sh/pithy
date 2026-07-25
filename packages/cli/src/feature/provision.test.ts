import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { emptyManifest, type FeatureResource, manifestPath, readManifest, writeManifest } from "./manifest";
import { type FeatureIdentity, featureResourceName, featureWorkerName } from "./naming";
import {
  deprovisionFeature,
  FeatureAuditActions,
  type FeatureProvisioners,
  provisionFeature,
  type ResourceProvisioner,
} from "./provision";

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
  return { stores, provisioners: provisioners as unknown as FeatureProvisioners, typed: provisioners };
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

describe("provisionFeature / deprovisionFeature", () => {
  let dir: string;
  const identity: FeatureIdentity = { project: "acme", issue: "69", slug: "demo" };
  const capabilities = [appCapability()];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-feature-"));
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "app"\n}\n');
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

  test("fresh provision creates every resource, records the manifest, writes wrangler ids, migrates + seeds", async () => {
    const { stores, provisioners } = fakeProvisioners();
    const r = runners();

    const report = await provisionFeature({
      projectDir: dir,
      env: "feature",
      capabilities,
      identity,
      provisioners,
      migrate: r.migrate,
      seed: r.seed,
    });

    expect(report.resources.map((x) => [x.kind, x.binding, x.created])).toEqual([
      ["d1", "DB", true],
      ["kv", "CACHE", true],
      ["r2", "ASSETS", true],
    ]);
    expect(report.migrated && report.seeded).toBe(true);
    expect(r.calls).toEqual({ migrate: ["feature"], seed: ["feature"] });

    // The R2 resource's name is its id; D1/KV got synthetic ids.
    const r2Name = featureResourceName(identity, "ASSETS", "r2");
    expect(stores.r2.get(r2Name)).toBe(r2Name);

    const manifest = await readManifest(manifestPath(dir));
    expect(manifest?.resources).toHaveLength(3);

    const wrangler = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as {
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

  test("re-running is idempotent: every resource is reused, nothing new is created", async () => {
    const { provisioners, typed } = fakeProvisioners();
    const opts = { projectDir: dir, env: "feature", capabilities, identity, provisioners };

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

    const report = await provisionFeature({ projectDir: dir, env: "feature", capabilities, identity, provisioners });

    expect(report.resources.map((x) => [x.binding, x.created])).toEqual([
      ["DB", false], // reused
      ["CACHE", true],
      ["ASSETS", true],
    ]);
    expect(typed.d1.creates).toBe(0);
    expect(typed.kv.creates).toBe(1);
    expect(typed.r2.creates).toBe(1);
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
      projectDir: dir,
      env: "feature",
      capabilities: [withService],
      identity,
      provisioners,
      discoverWorkers: async () => [
        { name: "api", dir: apiDir },
        { name: "web", dir: webDir },
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
    const web = parse(await readFile(join(webDir, "wrangler.jsonc"), "utf8")) as unknown as {
      env: Record<string, { name?: string; services?: { binding: string; service: string }[] }>;
    };
    expect(web.env.feature?.name).toBe(featureWorkerName(identity, "web"));
    expect(web.env.feature?.services).toEqual([{ binding: "API", service: apiName }]);
  });

  test("destroy deletes every manifest resource and removes the manifest file", async () => {
    const { stores, provisioners } = fakeProvisioners();
    await provisionFeature({ projectDir: dir, env: "feature", capabilities, identity, provisioners });

    const report = await deprovisionFeature({ projectDir: dir, identity, capabilities, provisioners });

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

    const report = await deprovisionFeature({ projectDir: dir, identity, capabilities, provisioners });

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

    const report = await deprovisionFeature({ projectDir: dir, identity, capabilities, provisioners });

    expect(report.deleted).toEqual([{ kind: "kv", name: ours, id: "our-id" }]);
    expect(stores.kv.has(sibling)).toBe(true);
  });

  test("audits every resource it creates, and records nothing for one it merely reused", async () => {
    const { stores, provisioners } = fakeProvisioners();
    const events: CliAuditEvent[] = [];
    // DB already exists, so a resumed run reuses it — that is not a change and must not be recorded.
    stores.d1.set(featureResourceName(identity, "DB", "d1"), "pre-existing");

    await provisionFeature({
      projectDir: dir,
      env: "feature",
      capabilities,
      identity,
      provisioners,
      audit: async (event) => void events.push(event),
      migrate: async () => {},
      seed: async () => {},
    });

    expect(events.map((e) => e.action)).toEqual([
      FeatureAuditActions.resourceCreated,
      FeatureAuditActions.resourceCreated,
    ]);
    expect(events.map((e) => e.resourceType)).toEqual(["cf_kv", "cf_r2"]);
    expect(events[0]).toMatchObject({ outcome: "success", metadata: { binding: "CACHE", issue: "69" } });
  });

  test("audits every deletion as a warning — teardown destroys real infrastructure, often with no human watching", async () => {
    const { provisioners } = fakeProvisioners();
    await provisionFeature({ projectDir: dir, env: "feature", capabilities, identity, provisioners });

    const events: CliAuditEvent[] = [];
    await deprovisionFeature({
      projectDir: dir,
      identity,
      capabilities,
      provisioners,
      audit: async (event) => void events.push(event),
    });

    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.action))).toEqual(new Set([FeatureAuditActions.resourceDeleted]));
    expect(events.every((e) => e.severity === "warning")).toBe(true);
    expect(new Set(events.map((e) => e.resourceType))).toEqual(new Set(["cf_d1", "cf_kv", "cf_r2"]));
    // The deleted resource's id and name are both recorded — the "what exactly went" of the trail.
    expect(events[0]?.resourceId).toBeTruthy();
    expect(events[0]?.metadata?.name).toBeTruthy();
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
      stores.d1.set("acme-production", "prod-d1-uuid");
      await writeCraftedManifest([{ kind: "d1", binding: "DB", name: "looks-legit", id: "prod-d1-uuid" }]);

      const report = await deprovisionFeature({ projectDir: dir, identity, capabilities, provisioners });

      expect(report.deleted).toEqual([]);
      expect(stores.d1.get("acme-production")).toBe("prod-d1-uuid"); // production survived
    });

    test("destroy still deletes a legitimately-recorded resource — the check does not break the real path", async () => {
      const { stores, provisioners } = fakeProvisioners();
      const name = featureResourceName(identity, "DB", "d1");
      stores.d1.set(name, "our-d1");
      await writeCraftedManifest([{ kind: "d1", binding: "DB", name, id: "our-d1" }]);

      const report = await deprovisionFeature({ projectDir: dir, identity, capabilities, provisioners });

      expect(report.deleted).toEqual([{ kind: "d1", name, id: "our-d1" }]);
      expect(stores.d1.size).toBe(0);
    });

    test("a manifest whose header names another feature is refused outright, not silently ignored", async () => {
      const { provisioners } = fakeProvisioners();
      await writeCraftedManifest([], { project: "acme", issue: "999", slug: "someone-else" });

      await expect(deprovisionFeature({ projectDir: dir, identity, capabilities, provisioners })).rejects.toThrow(
        /different feature/i,
      );
    });

    test("provision does not launder a foreign entry forward into the manifest it rewrites", async () => {
      const { provisioners } = fakeProvisioners();
      await writeCraftedManifest([{ kind: "d1", binding: "DB", name: "looks-legit", id: "prod-d1-uuid" }]);

      await provisionFeature({
        projectDir: dir,
        env: "feature",
        capabilities,
        identity,
        provisioners,
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

  test("destroy is idempotent: no manifest and nothing to reconcile exits cleanly with no deletions", async () => {
    const { provisioners } = fakeProvisioners();
    const report = await deprovisionFeature({ projectDir: dir, identity, capabilities, provisioners });
    expect(report.deleted).toEqual([]);
  });
});
