// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { scaffoldProject } from "../project/scaffold";
import { provisionEnvironment } from "../provision/environment";
import type { ResourceProvisioner, ResourceProvisioners } from "../provision/resources";
import { applyReconcilePlan, buildReconcilePlan } from "./reconcile";

let dir: string;
let workerDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-reconcile-owned-"));
  await scaffoldProject({ targetDir: dir, appName: "my-app", worker: "other" });
  workerDir = join(dir, "apps", "other");
  await writeFile(join(workerDir, "pithy.worker.jsonc"), '{\n  "ownBindings": ["DB"]\n}\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function account(): ResourceProvisioners {
  const stores = new Map<string, Map<string, string>>();
  let seq = 0;
  const kind = (name: string): ResourceProvisioner => {
    const store = new Map<string, string>();
    stores.set(name, store);
    return {
      find: async (resource) => (store.has(resource) ? { id: store.get(resource) as string } : null),
      create: async (resource) => {
        seq += 1;
        store.set(resource, `${name}-${seq}`);
        return { id: `${name}-${seq}` };
      },
      delete: async () => {},
    };
  };
  return { d1: kind("d1"), kv: kind("kv"), r2: kind("r2"), queue: kind("queue") } as unknown as ResourceProvisioners;
}

interface Entry {
  binding: string;
  database_name?: string;
  database_id?: string;
}

/**
 * **`pithy upgrade` writes an owned binding the way `pithy add` does.** A missing D1 entry for a binding the Worker
 * lists in `ownBindings` gets the owned name in every stanza and a top-level `database_id` of its own, so local dev
 * keeps it apart from the shared database, and the provision that follows has nothing to repoint.
 */
describe("pithy upgrade, then pithy provision, on a Worker that owns DB", () => {
  test("writes the owned names and local id, and provision then creates the owned database with no repoint", async () => {
    const app = defineCapability({ name: "board", requiredBindings: [{ type: "d1", name: "DB" }] });
    const plan = await buildReconcilePlan({
      account: null,
      projectDir: dir,
      workerDir,
      env: "dev",
      capabilities: [app],
      workerConfig: { capabilities: [], app },
    });
    await applyReconcilePlan({
      account: null,
      projectDir: dir,
      workerDir,
      plan,
      migrate: false,
      env: "dev",
      project: "my-app",
      capabilities: [app],
      app,
    });
    const read = async () =>
      parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as {
        d1_databases?: Entry[];
        env: Record<string, { d1_databases?: Entry[] }>;
      };
    const upgraded = await read();
    expect(upgraded.d1_databases).toEqual([
      { binding: "DB", database_name: "my-app-dev-other---db", database_id: "my-app-dev-other---db" },
    ]);
    expect(upgraded.env.staging?.d1_databases).toEqual([{ binding: "DB", database_name: "my-app-staging-other---db" }]);
    expect(upgraded.env.prod?.d1_databases).toEqual([{ binding: "DB", database_name: "my-app-prod-other---db" }]);

    const report = await provisionEnvironment({
      projectDir: dir,
      scope: environmentScope("my-app", "staging"),
      capabilities: [app],
      provisioners: account(),
      resolveWorkers: async () => [{ name: "my-app-other", dir: workerDir, capabilities: [app], ownBindings: ["DB"] }],
      seedData: false,
      migrate: async () => {},
      seed: async () => {},
      administersItself: false,
    });
    expect(report.repoints).toEqual([]);
    expect(report.resources.map(({ name, owner }) => ({ name, owner }))).toEqual([
      { name: "my-app-staging-other---db", owner: "other" },
    ]);
    expect((await read()).env.staging?.d1_databases).toEqual([
      { binding: "DB", database_name: "my-app-staging-other---db", database_id: "d1-1" },
    ]);
  });
});
