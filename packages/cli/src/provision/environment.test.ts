// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { provisionEnvironment } from "./environment";
import type { ResourceProvisioner, ResourceProvisioners } from "./resources";

/** An in-memory provisioner over a name→id map, mirroring the real find/create/delete semantics. */
function fakeKind(kind: string, store: Map<string, string>): ResourceProvisioner & { creates: number } {
  let seq = 0;
  const provisioner = {
    creates: 0,
    find: async (name: string) => (store.has(name) ? { id: store.get(name) as string } : null),
    create: async (name: string) => {
      provisioner.creates += 1;
      seq += 1;
      const id = kind === "r2" ? name : `${kind}-${seq}`;
      store.set(name, id);
      return { id };
    },
    delete: async (id: string) => {
      for (const [name, value] of store) if (value === id) store.delete(name);
    },
  };
  return provisioner;
}

function fakeProvisioners() {
  const stores = { d1: new Map<string, string>(), kv: new Map<string, string>(), r2: new Map<string, string>() };
  const typed = { d1: fakeKind("d1", stores.d1), kv: fakeKind("kv", stores.kv), r2: fakeKind("r2", stores.r2) };
  return { stores, typed, provisioners: typed as unknown as ResourceProvisioners };
}

const app = defineCapability({
  name: "app",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "kv", name: "CACHE" },
    { type: "r2", name: "ASSETS" },
  ] satisfies BindingSpecInput[],
});

/** One stanza of a Worker's wrangler.jsonc, as this suite reads it back. */
interface Stanza {
  name?: string;
  d1_databases?: { binding: string; database_name?: string; database_id?: string }[];
  kv_namespaces?: { binding: string; id?: string }[];
  r2_buckets?: { binding: string; bucket_name?: string }[];
  services?: { binding: string; service: string }[];
}

async function readStanza(workerDir: string, env: string): Promise<Stanza | undefined> {
  const config = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as {
    env?: Record<string, Stanza | undefined>;
  };
  return config.env?.[env];
}

/**
 * **Project and worker names differ throughout.** A Worker deploys as `<project>-<worker>`, and a
 * fixture where both segments are the same word hides every place the two are confused.
 */
describe("provisionEnvironment, for a declared environment", () => {
  let dir: string;
  let workerDir: string;
  const scope = environmentScope("replay", "staging");
  const noBackend = { seedData: false, migrate: async () => {}, seed: async () => {} };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-provision-"));
    workerDir = join(dir, "apps", "board");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), '{\n  "name": "replay-board"\n}\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const workers = () => async () => [{ name: "replay-board", dir: workerDir, capabilities: [app] }];

  test("creates one resource per binding, named for the environment it is written into", async () => {
    const { stores, provisioners } = fakeProvisioners();

    const report = await provisionEnvironment({
      projectDir: dir,
      scope,
      capabilities: [app],
      provisioners,
      resolveWorkers: workers(),
      ...noBackend,
    });

    expect(report.env).toBe("staging");
    expect(report.resources.map((resource) => [resource.kind, resource.name, resource.created])).toEqual([
      ["d1", "replay-staging-db", true],
      ["kv", "replay-staging-cache", true],
      ["r2", "replay-staging-assets", true],
    ]);
    expect([...stores.d1.keys()]).toEqual(["replay-staging-db"]);
  });

  test("creates nothing for a binding this Worker declines", async () => {
    // The other half of #440. Stopping `pithy upgrade` writing the binding while `pithy provision` still
    // created the bucket handed the adopter exactly the resource the decline said they did not want.
    // The manifest has to be installed for the decline to resolve at all — a decline resolves against
    // what the Worker composes, and a name nothing declares is `unrecognized` and changes nothing.
    const optional = defineCapability({
      name: "app",
      requiredBindings: [
        { type: "d1", name: "DB" },
        { type: "kv", name: "CACHE" },
        { type: "r2", name: "ASSETS", optional: true },
      ] satisfies BindingSpecInput[],
    });
    const pkgDir = join(dir, "node_modules", "@pithy-sh", "app");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "pithy.manifest.json"),
      JSON.stringify({
        name: "app",
        package: "@pithy-sh/app",
        requiredBindings: [
          { type: "d1", name: "DB" },
          { type: "kv", name: "CACHE" },
          { type: "r2", name: "ASSETS", optional: true },
        ],
      }),
    );
    const { stores, provisioners } = fakeProvisioners();

    const report = await provisionEnvironment({
      projectDir: dir,
      scope,
      capabilities: [optional],
      provisioners,
      resolveWorkers: async () => [
        {
          name: "replay-board",
          dir: workerDir,
          capabilities: [optional],
          config: { capabilities: [], declinedBindings: { ASSETS: "no R2 in this account" } } as never,
        },
      ],
      ...noBackend,
    });

    expect(report.resources.map((resource) => resource.kind)).toEqual(["d1", "kv"]);
    // The bucket was never created, which is the whole point — a report that merely omitted it while the
    // provisioner had made one would read identically.
    expect([...stores.r2.keys()]).toEqual([]);
    // And the two the Worker still wants are untouched.
    expect([...stores.d1.keys()]).toEqual(["replay-staging-db"]);
    expect([...stores.kv.keys()]).toEqual(["replay-staging-cache"]);
  });

  test("a resource survives one Worker declining it while another still wants it", async () => {
    // The environment provisions one resource per binding *name* — that is how two Workers share a
    // database. So a decline is only decisive when every Worker that declares the binding declines it;
    // one Worker opting out must not take the other's bucket away.
    const optional = defineCapability({
      name: "app",
      requiredBindings: [
        { type: "d1", name: "DB" },
        { type: "r2", name: "ASSETS", optional: true },
      ] satisfies BindingSpecInput[],
    });
    const pkgDir = join(dir, "node_modules", "@pithy-sh", "app");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "pithy.manifest.json"),
      JSON.stringify({
        name: "app",
        package: "@pithy-sh/app",
        requiredBindings: [
          { type: "d1", name: "DB" },
          { type: "r2", name: "ASSETS", optional: true },
        ],
      }),
    );
    const secondDir = join(dir, "apps", "collab");
    await mkdir(secondDir, { recursive: true });
    await writeFile(join(secondDir, "wrangler.jsonc"), '{\n  "name": "replay-collab"\n}\n');
    const { stores, provisioners } = fakeProvisioners();

    await provisionEnvironment({
      projectDir: dir,
      scope,
      capabilities: [optional],
      provisioners,
      resolveWorkers: async () => [
        {
          name: "replay-board",
          dir: workerDir,
          capabilities: [optional],
          config: { capabilities: [], declinedBindings: { ASSETS: "not here" } } as never,
        },
        { name: "replay-collab", dir: secondDir, capabilities: [optional] },
      ],
      ...noBackend,
    });

    expect([...stores.r2.keys()]).toEqual(["replay-staging-assets"]);
  });

  test("writes the ids into the env.<name> stanza of each Worker's own wrangler.jsonc", async () => {
    const { provisioners } = fakeProvisioners();
    await provisionEnvironment({
      projectDir: dir,
      scope,
      capabilities: [app],
      provisioners,
      resolveWorkers: workers(),
      ...noBackend,
    });

    const stanza = await readStanza(workerDir, "staging");
    // `database_name` beside `database_id`: `pithy add` proposes the name offline and provisioning is
    // what makes it true, so the two must be written by the same step or they disagree.
    expect(stanza?.d1_databases?.[0]).toEqual({
      binding: "DB",
      database_name: "replay-staging-db",
      database_id: "d1-1",
    });
    expect(stanza?.kv_namespaces?.[0]).toEqual({ binding: "CACHE", id: "kv-1" });
    expect(stanza?.r2_buckets?.[0]).toEqual({ binding: "ASSETS", bucket_name: "replay-staging-assets" });
    // The environment deploys under wrangler's own name for it — written out rather than left implicit.
    expect(stanza?.name).toBe("replay-board-staging");
  });

  test("adopts a resource of the right name rather than creating a second", async () => {
    const { stores, typed, provisioners } = fakeProvisioners();
    stores.d1.set("replay-staging-db", "made-by-hand");

    const report = await provisionEnvironment({
      projectDir: dir,
      scope,
      capabilities: [app],
      provisioners,
      resolveWorkers: workers(),
      ...noBackend,
    });

    expect(report.resources[0]).toMatchObject({ binding: "DB", id: "made-by-hand", created: false });
    expect(typed.d1.creates).toBe(0);
    expect(stores.d1.size).toBe(1);
    expect((await readStanza(workerDir, "staging"))?.d1_databases?.[0]?.database_id).toBe("made-by-hand");
  });

  test("re-running changes nothing", async () => {
    const { typed, provisioners } = fakeProvisioners();
    const options = {
      projectDir: dir,
      scope,
      capabilities: [app],
      provisioners,
      resolveWorkers: workers(),
      ...noBackend,
    };
    await provisionEnvironment(options);
    const first = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");

    const second = await provisionEnvironment(options);

    expect(second.resources.every((resource) => resource.created === false)).toBe(true);
    expect(typed.d1.creates + typed.kv.creates + typed.r2.creates).toBe(3);
    expect(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")).toBe(first);
  });

  /**
   * A declared environment's record **is** its `wrangler.jsonc` — the ids are long-lived and belong
   * under review. A second file recording them would be a build artifact claiming to be source.
   */
  test("writes no manifest file: the stanza is the record", async () => {
    const { provisioners } = fakeProvisioners();
    await provisionEnvironment({
      projectDir: dir,
      scope,
      capabilities: [app],
      provisioners,
      resolveWorkers: workers(),
      ...noBackend,
    });

    expect(await readdir(dir)).toEqual(["apps"]);
  });

  test("retargets a service binding at the sibling's deployment in this environment", async () => {
    const { provisioners } = fakeProvisioners();
    const webDir = join(dir, "apps", "web");
    await mkdir(webDir, { recursive: true });
    await writeFile(join(webDir, "wrangler.jsonc"), '{\n  "name": "replay-web"\n}\n');

    const calling = defineCapability({
      name: "calling",
      requiredBindings: [{ type: "service", name: "BOARD", service: "board" }] satisfies BindingSpecInput[],
    });

    const report = await provisionEnvironment({
      projectDir: dir,
      scope,
      capabilities: [calling],
      provisioners,
      resolveWorkers: async () => [
        { name: "replay-board", dir: workerDir, capabilities: [calling] },
        { name: "replay-web", dir: webDir, capabilities: [calling] },
      ],
      ...noBackend,
    });

    // The target is resolved through the Worker's deploy name, never its directory: `apps/board`
    // deploys as `replay-board`, so staging's copy is `replay-board-staging`.
    expect(report.services).toEqual([{ binding: "BOARD", service: "replay-board-staging" }]);
    expect((await readStanza(webDir, "staging"))?.services).toEqual([
      { binding: "BOARD", service: "replay-board-staging" },
    ]);
  });

  test("migrates and seeds the environment it provisioned", async () => {
    const { provisioners } = fakeProvisioners();
    const calls: string[] = [];
    await provisionEnvironment({
      projectDir: dir,
      scope,
      capabilities: [app],
      provisioners,
      resolveWorkers: workers(),
      seedData: true,
      migrate: async ({ env }) => void calls.push(`migrate:${env}`),
      seed: async ({ env }) => void calls.push(`seed:${env}`),
    });
    expect(calls).toEqual(["migrate:staging", "seed:staging"]);
  });
});
