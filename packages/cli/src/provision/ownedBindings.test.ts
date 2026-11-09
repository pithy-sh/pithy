// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { environmentScope, featureScope } from "@pithy-sh/core/src/naming/provisionScope";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { WorkerConfig } from "../project/config";
import { type ProvisionWorker, provisionEnvironment } from "./environment";
import type { ResourceProvisioner, ResourceProvisioners } from "./resources";

/** An in-memory account over a name→id map per kind, counting creates. */
function fakeProvisioners() {
  const stores = { d1: new Map<string, string>(), kv: new Map<string, string>(), r2: new Map(), queue: new Map() };
  let seq = 0;
  const kind = (name: keyof typeof stores): ResourceProvisioner => ({
    find: async (resource) => (stores[name].has(resource) ? { id: stores[name].get(resource) as string } : null),
    create: async (resource) => {
      seq += 1;
      const id = name === "r2" ? resource : `${name}-${seq}`;
      stores[name].set(resource, id);
      return { id };
    },
    delete: async () => {},
  });
  const provisioners = { d1: kind("d1"), kv: kind("kv"), r2: kind("r2"), queue: kind("queue") };
  return { stores, provisioners: provisioners as unknown as ResourceProvisioners };
}

const db = (name: string) =>
  defineCapability({ name, requiredBindings: [{ type: "d1", name: "DB" }] satisfies BindingSpecInput[] });
const organization = db("organization");
const controlplane = db("controlplane");

interface Stanza {
  d1_databases?: { binding: string; database_name?: string; database_id?: string }[];
}

async function stanzaOf(workerDir: string, env: string): Promise<Stanza | undefined> {
  const config = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as {
    env?: Record<string, Stanza>;
  };
  return config.env?.[env];
}

/** Install a capability's manifest at the project root, where decline resolution reads it. */
async function installManifest(dir: string, name: string, requiredBindings: BindingSpecInput[]): Promise<void> {
  const pkgDir = join(dir, "node_modules", "@pithy-sh", name);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "pithy.manifest.json"),
    JSON.stringify({ name, package: `@pithy-sh/${name}`, requiredBindings }),
  );
}

const noBackend = { seedData: false, migrate: async () => {}, seed: async () => {}, administersItself: false };

/**
 * **The reporter's project**: `api` and `other`, each declaring `DB`, two products that must not share data.
 * `other` lists `DB` in `ownBindings`.
 */
describe("provisionEnvironment with ownBindings", () => {
  let dir: string;
  let api: string;
  let other: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-own-"));
    api = join(dir, "apps", "api");
    other = join(dir, "apps", "other");
    for (const [workerDir, name] of [
      [api, "my-app-api"],
      [other, "my-app-other"],
    ] as const) {
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(workerDir, "wrangler.jsonc"), `{\n  "name": "${name}"\n}\n`);
    }
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const workers =
    (own: { api?: string[]; other?: string[] } = { other: ["DB"] }, config?: WorkerConfig) =>
    async (): Promise<ProvisionWorker[]> => [
      { name: "my-app-api", dir: api, capabilities: [organization], ownBindings: own.api ?? [] },
      {
        name: "my-app-other",
        dir: other,
        capabilities: [controlplane],
        ownBindings: own.other ?? [],
        ...(config ? { config } : {}),
      },
    ];

  test("creates the shared database for api and the owned one for other, each with its owner", async () => {
    const { stores, provisioners } = fakeProvisioners();
    const report = await provisionEnvironment({
      projectDir: dir,
      scope: environmentScope("my-app", "staging"),
      capabilities: [organization, controlplane],
      provisioners,
      resolveWorkers: workers(),
      ...noBackend,
    });

    expect(report.resources.map(({ name, owner, workers: into }) => ({ name, owner, workers: into }))).toEqual([
      { name: "my-app-staging-db", owner: undefined, workers: ["my-app-api"] },
      { name: "my-app-staging-other---db", owner: "other", workers: ["my-app-other"] },
    ]);
    expect([...stores.d1.keys()]).toEqual(["my-app-staging-db", "my-app-staging-other---db"]);
    expect(report.ownership).toEqual([{ worker: "my-app-other", owned: ["DB"], unrecognized: [] }]);

    // Each id lands in its own Worker's stanza, and only there.
    expect((await stanzaOf(api, "staging"))?.d1_databases).toEqual([
      { binding: "DB", database_name: "my-app-staging-db", database_id: stores.d1.get("my-app-staging-db") },
    ]);
    expect((await stanzaOf(other, "staging"))?.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "my-app-staging-other---db",
        database_id: stores.d1.get("my-app-staging-other---db"),
      },
    ]);
  });

  test("shares one resource between two Workers that own nothing, byte for byte as before", async () => {
    const { stores, provisioners } = fakeProvisioners();
    const report = await provisionEnvironment({
      projectDir: dir,
      scope: environmentScope("my-app", "staging"),
      capabilities: [organization, controlplane],
      provisioners,
      resolveWorkers: workers({}),
      ...noBackend,
    });

    expect(report.resources).toHaveLength(1);
    expect(report.resources[0]).toEqual({
      kind: "d1",
      binding: "DB",
      name: "my-app-staging-db",
      id: "d1-1",
      created: true,
      workers: ["my-app-api", "my-app-other"],
    });
    expect(report.ownership).toEqual([]);
    expect([...stores.d1.keys()]).toEqual(["my-app-staging-db"]);
    const expected = [
      "{",
      '  "name": "my-app-api",',
      '  "env": {',
      '    "staging": {',
      '      "name": "my-app-api-staging",',
      '      "d1_databases": [{ "binding": "DB", "database_name": "my-app-staging-db", "database_id": "d1-1" }]',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(await readFile(join(api, "wrangler.jsonc"), "utf8")).toBe(expected);
    expect(await readFile(join(other, "wrangler.jsonc"), "utf8")).toBe(expected.replace(/my-app-api/g, "my-app-other"));
  });

  test("names no shared resource when every Worker declaring the binding owns it", async () => {
    const { stores, provisioners } = fakeProvisioners();
    await provisionEnvironment({
      projectDir: dir,
      scope: environmentScope("my-app", "staging"),
      capabilities: [organization, controlplane],
      provisioners,
      resolveWorkers: workers({ api: ["DB"], other: ["DB"] }),
      ...noBackend,
    });
    expect([...stores.d1.keys()]).toEqual(["my-app-staging-api---db", "my-app-staging-other---db"]);
  });

  /**
   * **Each Worker's Workflow bindings reach the host that reads its database.** `other` owns `DB`, which email's host
   * binds, so its `EMAIL_SENDER` is pointed at its own host; `api` keeps the shared one.
   */
  test("points each Worker's Workflow bindings at the capability host that reads its database", async () => {
    const mailer = defineCapability({
      name: "email",
      requiredBindings: [
        { type: "d1", name: "DB" },
        { type: "workflow", name: "EMAIL_SENDER", job: "send", className: "EmailSendWorkflow" },
      ] satisfies BindingSpecInput[],
      workflows: {
        send: { binding: "EMAIL_SENDER", params: z.object({}).describe("None."), className: "EmailSendWorkflow" },
      },
    });
    const { provisioners } = fakeProvisioners();
    const report = await provisionEnvironment({
      projectDir: dir,
      scope: environmentScope("my-app", "staging"),
      capabilities: [mailer],
      provisioners,
      resolveWorkers: async () => [
        { name: "my-app-api", dir: api, capabilities: [mailer], ownBindings: [] },
        { name: "my-app-other", dir: other, capabilities: [mailer], ownBindings: ["DB"] },
      ],
      ...noBackend,
    });

    const sender = async (workerDir: string) =>
      ((await stanzaOf(workerDir, "staging")) as { workflows?: { binding: string; script_name: string }[] })?.workflows;
    expect(await sender(api)).toEqual([
      {
        binding: "EMAIL_SENDER",
        name: "my-app-staging-email-send",
        class_name: "EmailSendWorkflow",
        script_name: "my-app-staging-email",
      },
    ]);
    expect(await sender(other)).toEqual([
      {
        binding: "EMAIL_SENDER",
        name: "my-app-staging-other---email-send",
        class_name: "EmailSendWorkflow",
        script_name: "my-app-staging-other---email",
      },
    ]);
    expect(report.kitHosts).toEqual([
      { capability: "email", script: "my-app-staging-email", workers: ["my-app-api-staging"] },
      {
        capability: "email",
        owner: "other",
        script: "my-app-staging-other---email",
        workers: ["my-app-other-staging"],
      },
    ]);
  });

  test("reports an ownBindings entry naming nothing the Worker composes, and owns nothing for it", async () => {
    const { stores, provisioners } = fakeProvisioners();
    const report = await provisionEnvironment({
      projectDir: dir,
      scope: environmentScope("my-app", "staging"),
      capabilities: [organization, controlplane],
      provisioners,
      resolveWorkers: workers({ other: ["DBB"] }),
      ...noBackend,
    });
    expect(report.ownership).toEqual([{ worker: "my-app-other", owned: [], unrecognized: ["DBB"] }]);
    expect([...stores.d1.keys()]).toEqual(["my-app-staging-db"]);
  });

  test("refuses to own a global binding, naming the binding and the capability", async () => {
    const suppressions = defineCapability({
      name: "email",
      requiredBindings: [{ type: "d1", name: "EMAIL_SUPPRESSIONS", scope: "global" }] satisfies BindingSpecInput[],
    });
    const { stores, provisioners } = fakeProvisioners();
    const run = provisionEnvironment({
      projectDir: dir,
      scope: environmentScope("my-app", "staging"),
      capabilities: [suppressions],
      provisioners,
      resolveWorkers: async () => [
        { name: "my-app-other", dir: other, capabilities: [suppressions], ownBindings: ["EMAIL_SUPPRESSIONS"] },
      ],
      ...noBackend,
    });
    await expect(run).rejects.toThrow(/EMAIL_SUPPRESSIONS.*email declares global/);
    expect(stores.d1.size).toBe(0);
  });

  test("counts only sharing Workers in a decline's wantedBy, and creates nothing for an owner's decline", async () => {
    const optional = (name: string) =>
      defineCapability({
        name,
        requiredBindings: [{ type: "kv", name: "CACHE", optional: true }] satisfies BindingSpecInput[],
      });
    const a = optional("organization");
    const b = optional("controlplane");
    for (const name of ["organization", "controlplane"]) {
      await installManifest(dir, name, [{ type: "kv", name: "CACHE", optional: true }]);
    }
    const declines: WorkerConfig = {
      capabilities: [b],
      declinedBindings: { CACHE: "Cached elsewhere." },
    } as unknown as WorkerConfig;
    const { stores, provisioners } = fakeProvisioners();
    const report = await provisionEnvironment({
      projectDir: dir,
      scope: environmentScope("my-app", "staging"),
      capabilities: [a, b],
      provisioners,
      resolveWorkers: async () => [
        { name: "my-app-api", dir: api, capabilities: [a], ownBindings: ["CACHE"] },
        { name: "my-app-other", dir: other, capabilities: [b], ownBindings: ["CACHE"], config: declines },
      ],
      ...noBackend,
    });
    const decline = report.declined[0];
    expect(decline?.state).toBe("read");
    expect(decline?.state === "read" ? decline.declines[0] : undefined).toMatchObject({
      state: "honored",
      name: "CACHE",
      wantedBy: [],
    });
    // api owns its own; other declined its own; no shared namespace exists for anyone.
    expect([...stores.kv.keys()]).toEqual(["my-app-staging-api---cache"]);
  });

  test("keeps a sharing sibling in wantedBy when the decliner shares", async () => {
    const optional = (name: string) =>
      defineCapability({
        name,
        requiredBindings: [{ type: "kv", name: "CACHE", optional: true }] satisfies BindingSpecInput[],
      });
    const a = optional("organization");
    const b = optional("controlplane");
    const c = optional("billing");
    for (const name of ["organization", "controlplane", "billing"]) {
      await installManifest(dir, name, [{ type: "kv", name: "CACHE", optional: true }]);
    }
    const third = join(dir, "apps", "third");
    await mkdir(third, { recursive: true });
    await writeFile(join(third, "wrangler.jsonc"), '{\n  "name": "my-app-third"\n}\n');
    const declines = { capabilities: [a], declinedBindings: { CACHE: "Not here." } } as unknown as WorkerConfig;
    const { provisioners } = fakeProvisioners();
    const report = await provisionEnvironment({
      projectDir: dir,
      scope: environmentScope("my-app", "staging"),
      capabilities: [a, b, c],
      provisioners,
      resolveWorkers: async () => [
        { name: "my-app-api", dir: api, capabilities: [a], config: declines },
        { name: "my-app-other", dir: other, capabilities: [b], ownBindings: ["CACHE"] },
        { name: "my-app-third", dir: third, capabilities: [c] },
      ],
      ...noBackend,
    });
    const decline = report.declined[0];
    expect(decline?.state === "read" ? decline.declines[0] : undefined).toMatchObject({ wantedBy: ["my-app-third"] });
  });

  describe("a stanza that points at another resource", () => {
    /** Provision shared, then have `other` take `DB` as its own: its stanza still holds the shared id. */
    async function sharedThenOwned() {
      const account = fakeProvisioners();
      await provisionEnvironment({
        projectDir: dir,
        scope: environmentScope("my-app", "staging"),
        capabilities: [organization, controlplane],
        provisioners: account.provisioners,
        resolveWorkers: workers({}),
        ...noBackend,
      });
      return account;
    }

    test("is refused without --repoint, before anything is created", async () => {
      const { stores, provisioners } = await sharedThenOwned();
      const before = await readFile(join(other, "wrangler.jsonc"), "utf8");
      let caught: unknown;
      try {
        await provisionEnvironment({
          projectDir: dir,
          scope: environmentScope("my-app", "staging"),
          capabilities: [organization, controlplane],
          provisioners,
          resolveWorkers: workers(),
          ...noBackend,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PithyError);
      expect((caught as PithyError).payload.message).toBe(
        "my-app-other's DB points at my-app-staging-db. This run names my-app-staging-other---db. my-app-staging-db keeps its data.",
      );
      expect([...stores.d1.keys()]).toEqual(["my-app-staging-db"]);
      expect(await readFile(join(other, "wrangler.jsonc"), "utf8")).toBe(before);
    });

    test("is performed with --repoint, and reported", async () => {
      const { stores, provisioners } = await sharedThenOwned();
      const report = await provisionEnvironment({
        projectDir: dir,
        scope: environmentScope("my-app", "staging"),
        capabilities: [organization, controlplane],
        provisioners,
        resolveWorkers: workers(),
        repoint: true,
        ...noBackend,
      });
      expect(report.repoints).toEqual([
        {
          worker: "my-app-other",
          binding: "DB",
          kind: "d1",
          current: "my-app-staging-db",
          next: "my-app-staging-other---db",
        },
      ]);
      expect((await stanzaOf(other, "staging"))?.d1_databases?.[0]?.database_id).toBe(
        stores.d1.get("my-app-staging-other---db"),
      );
      // The shared database is still there, with whatever it held.
      expect(stores.d1.has("my-app-staging-db")).toBe(true);
    });

    test("is refused owned to shared, too, and a rerun after a repoint finds nothing to repoint", async () => {
      const { provisioners } = fakeProvisioners();
      const run = (own: { other?: string[] }, repoint = false) =>
        provisionEnvironment({
          projectDir: dir,
          scope: environmentScope("my-app", "staging"),
          capabilities: [organization, controlplane],
          provisioners,
          resolveWorkers: workers(own),
          repoint,
          ...noBackend,
        });
      await run({ other: ["DB"] });
      expect((await run({ other: ["DB"] })).repoints).toEqual([]);
      await expect(run({})).rejects.toThrow(/my-app-staging-other---db\. This run names my-app-staging-db/);
      expect((await run({}, true)).repoints).toHaveLength(1);
      expect((await run({})).repoints).toEqual([]);
    });

    test("is never asked of a feature, whose stanza is regenerated", async () => {
      const { provisioners } = fakeProvisioners();
      const scope = featureScope({ project: "my-app", issue: "12", slug: "x" });
      const run = (own: { other?: string[] }) =>
        provisionEnvironment({
          projectDir: dir,
          scope,
          capabilities: [organization, controlplane],
          provisioners,
          resolveWorkers: workers(own),
          ...noBackend,
        });
      await run({});
      const report = await run({ other: ["DB"] });
      expect(report.repoints).toEqual([]);
      expect(report.resources.map((resource) => resource.name)).toEqual([
        "my-app-f12-x--db-d1",
        "my-app-f12-x--other---db-d1",
      ]);
    });
  });
});
