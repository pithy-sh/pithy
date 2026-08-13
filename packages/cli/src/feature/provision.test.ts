// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { type FeatureIdentity, featureResourceName, featureWorkerName } from "@pithy-sh/core/src/naming/feature";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { sourceFiles } from "../ci/sourceFiles";
import { featureConfigPath } from "../provision/featureConfig";
import { ProvisionAuditActions, type ResourceProvisioner, type ResourceProvisioners } from "../provision/resources";
import { emptyManifest, type FeatureResource, manifestPath, readManifest, writeManifest } from "./manifest";
import { deprovisionFeature, provisionFeature } from "./provision";

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
const noBackend = { migrate: async () => {}, seed: async () => {}, resolveWorkers: async () => [] };

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

  test("fresh provision creates every resource, records the manifest, writes wrangler ids, migrates + seeds", async () => {
    const { stores, provisioners } = fakeProvisioners();
    const r = runners();

    const report = await provisionFeature({
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
    expect(Object.keys(report).sort()).toEqual([
      "committed",
      "configs",
      "env",
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

  test("a service binding targets the sibling's real script name, even when it differs from its directory", async () => {
    const { provisioners } = fakeProvisioners();
    // The normal state after `pithy init acme`: apps/api deploys as "acme-api", not "api".
    const apiDir = join(dir, "apps", "api");
    const webDir = join(dir, "apps", "web");
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(apiDir, "wrangler.jsonc"), '{\n  "name": "acme-api"\n}\n');
    await mkdir(webDir, { recursive: true });
    await writeFile(join(webDir, "wrangler.jsonc"), '{\n  "name": "acme-web"\n}\n');

    // A service binding names its target by its apps/<name> directory (BindingSpec.service).
    const withService = defineCapability({
      name: "app",
      requiredBindings: [{ type: "service", name: "API", service: "api" }] satisfies BindingSpecInput[],
    });

    const report = await provisionFeature({
      projectDir: dir,
      capabilities: [withService],
      identity,
      provisioners,
      resolveWorkers: async () => [
        { name: "acme-api", dir: apiDir, capabilities: [withService] },
        { name: "acme-web", dir: webDir, capabilities: [withService] },
      ],
      migrate: async () => {},
      seed: async () => {},
    });

    // api deploys as `<feature>-acme-api`; the binding must name exactly that. Feature-scoping the directory
    // name instead wrote `<feature>-api` — a script nobody deploys, so every RPC through env.API failed
    // while provision reported success.
    const deployed = featureWorkerName(identity, "acme-api");
    expect(report.services).toEqual([{ binding: "API", service: deployed }]);

    const web = parse(await readFile(featureConfigPath(webDir), "utf8")) as unknown as {
      env: Record<string, { services?: { binding: string; service: string }[] }>;
    };
    expect(web.env.feature?.services).toEqual([{ binding: "API", service: deployed }]);
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

    const report = await deprovisionFeature({ projectDir: dir, identity, capabilities, env: "feature", provisioners });

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

    const report = await deprovisionFeature({ projectDir: dir, identity, capabilities, env: "feature", provisioners });

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

    const report = await deprovisionFeature({ projectDir: dir, identity, capabilities, env: "feature", provisioners });

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
        deprovisionFeature({ projectDir: dir, identity, capabilities, env: "feature", provisioners }),
      ).rejects.toThrow(/different feature/i);
    });

    test("provision does not launder a foreign entry forward into the manifest it rewrites", async () => {
      const { provisioners } = fakeProvisioners();
      await writeCraftedManifest([{ kind: "d1", binding: "DB", name: "looks-legit", id: "prod-d1-uuid" }]);

      await provisionFeature({
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
          remove: async (name: string) => entries.delete(name),
        },
      };
    }

    const withSecrets = [secrets({ registry: {} })];

    test("mints the feature's own master key and binds it in every Worker that declares it", async () => {
      const { provisioners } = fakeProvisioners();
      const { entries, store } = fakeStore();

      const report = await provisionFeature({
        projectDir: dir,
        capabilities: withSecrets,
        identity,
        provisioners,
        store,
        resolveWorkers: async () => [{ name: "acme-api", dir: join(dir, "apps", "app"), capabilities: withSecrets }],
        migrate: async () => {},
        seed: async () => {},
      });

      const entry = "acme-f69-demo-secrets-encryption-keys";
      // Its own key, under its own name — never staging's, which teardown would then delete.
      expect([...entries.keys()]).toEqual([entry]);
      expect(JSON.parse(entries.get(entry) as string)).toMatchObject({ currentVersion: "1" });
      // `minted: false` — the master key is `json` against `EncryptionConfig`, so it declares no
      // `devValue` and the #321 minter never touches it. `provisionFeature` writes it itself, above.
      expect(report.secretBindings).toEqual([
        { binding: "SECRETS_ENCRYPTION_KEYS", entry, bound: true, minted: false },
      ]);

      const wrangler = parse(await readFile(featureConfigPath(join(dir, "apps", "app")), "utf8")) as unknown as {
        env: Record<string, { secrets_store_secrets?: { binding: string; store_id: string; secret_name: string }[] }>;
      };
      expect(wrangler.env.feature?.secrets_store_secrets).toEqual([
        { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "store-1", secret_name: entry },
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
        resolveWorkers: async () => [],
        migrate: async () => {},
        seed: async () => {},
      };

      await provisionFeature(options);
      const first = entries.get("acme-f69-demo-secrets-encryption-keys");
      await provisionFeature(options);

      expect(entries.get("acme-f69-demo-secrets-encryption-keys")).toBe(first);
    });

    test("destroy removes the feature's entries and leaves an environment's alone", async () => {
      const { provisioners } = fakeProvisioners();
      const { entries, store } = fakeStore();
      // Staging's key, in the same flat account-wide store. Teardown must not reach it.
      entries.set("acme-staging-secrets-encryption-keys", "staging's");

      await provisionFeature({
        projectDir: dir,
        capabilities: withSecrets,
        identity,
        provisioners,
        store,
        resolveWorkers: async () => [],
        migrate: async () => {},
        seed: async () => {},
      });
      expect(entries.has("acme-f69-demo-secrets-encryption-keys")).toBe(true);

      await deprovisionFeature({
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
          projectDir: dir,
          capabilities: withRegistry,
          identity,
          provisioners,
          store,
          resolveWorkers: async () => [{ name: "acme-api", dir: join(dir, "apps", "app"), capabilities: withRegistry }],
          migrate: async () => {},
          seed: async () => {},
        });

        const ingest = report.secretBindings.find((secret) => secret.binding === "RELEASE_INGEST_SECRET");
        expect(ingest).toEqual({
          binding: "RELEASE_INGEST_SECRET",
          entry: "acme-f69-demo-release-ingest-secret",
          bound: true,
          minted: true,
        });
        // A value went in, as the uniform envelope every other secret of this backend is stored as.
        expect(JSON.parse(entries.get("acme-f69-demo-release-ingest-secret") as string)).toMatchObject({
          currentVersion: "1",
        });

        // A random string authenticates against nothing. This one stays a question for a human.
        expect(report.secretBindings.find((secret) => secret.binding === "STRIPE_SECRET_KEY")).toMatchObject({
          bound: false,
          minted: false,
        });
        expect(entries.has("acme-f69-demo-stripe-secret-key")).toBe(false);

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
          resolveWorkers: async () => [{ name: "acme-api", dir: join(dir, "apps", "app"), capabilities: withRegistry }],
          migrate: async () => {},
          seed: async () => {},
        };

        const first = await provisionFeature(options);
        const value = entries.get("acme-f69-demo-release-ingest-secret");
        const second = await provisionFeature(options);

        expect(first.secretBindings.find((secret) => secret.binding === "RELEASE_INGEST_SECRET")?.minted).toBe(true);
        expect(second.secretBindings.find((secret) => secret.binding === "RELEASE_INGEST_SECRET")?.minted).toBe(false);
        expect(entries.get("acme-f69-demo-release-ingest-secret")).toBe(value);
      });

      /** The trail says a secret was created and where. It never says what. */
      test("audits the creation without the value", async () => {
        const { provisioners } = fakeProvisioners();
        const { entries, store } = fakeStore();
        const events: CliAuditEvent[] = [];

        await provisionFeature({
          projectDir: dir,
          capabilities: withRegistry,
          identity,
          provisioners,
          store,
          resolveWorkers: async () => [{ name: "acme-api", dir: join(dir, "apps", "app"), capabilities: withRegistry }],
          migrate: async () => {},
          seed: async () => {},
          audit: async (event) => void events.push(event),
        });

        const created = events.filter((event) => event.resourceType === "secret");
        expect(created.map((event) => event.resourceId)).toEqual(["acme-f69-demo-release-ingest-secret"]);
        const envelope = entries.get("acme-f69-demo-release-ingest-secret") as string;
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
    const report = await deprovisionFeature({ projectDir: dir, identity, capabilities, env: "feature", provisioners });
    expect(report.deleted).toEqual([]);
  });
});
