// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindingSpec, type BindingSpecInput, type BindingType } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { provisionableBindings } from "../feature/bindings";
import { FeatureResource } from "../feature/manifest";
import { appendBinding, WRANGLER_KEYS } from "./bindingEntries";
import { declaredBindingSpecs, reconcileDeclaredBindings } from "./declaredBindings";

const app = (requiredBindings: BindingSpecInput[]) => defineCapability({ name: "app", requiredBindings });
const library = (name: string, requiredBindings: BindingSpecInput[]) => defineCapability({ name, requiredBindings });

interface Stanza {
  d1_databases?: { binding: string; database_name?: string; database_id?: string }[];
  r2_buckets?: { binding: string; bucket_name?: string }[];
  kv_namespaces?: { binding: string }[];
  queues?: { producers?: { binding: string; queue: string }[] };
}
type Config = Stanza & { env: Record<string, Stanza> };

const SCAFFOLDED = `{
  "name": "replay-board",
  // The top level is the dev environment.
  "env": {
    "staging": { "name": "replay-board-staging" },
    "prod": { "name": "replay-board" }
  }
}
`;

let dir: string;
let worker: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-declared-bindings-"));
  worker = join(dir, "apps", "board");
  await mkdir(worker, { recursive: true });
  await writeFile(join(worker, "wrangler.jsonc"), SCAFFOLDED);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = async (): Promise<Config> =>
  parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Config;

const STATS = app([
  { type: "d1", name: "DB" },
  { type: "r2", name: "PUBLISHED" },
]);

describe("reconcileDeclaredBindings", () => {
  test("writes an app's own D1 and R2 into every stanza, named for the project and not the worker", async () => {
    const runs = await reconcileDeclaredBindings({
      workerDir: worker,
      project: "replay",
      capabilities: [STATS],
      declarations: [],
      declined: new Set(),
      ownBindings: [],
    });
    const config = await read();
    for (const [env, stanza] of [
      ["dev", config],
      ["staging", config.env.staging],
      ["prod", config.env.prod],
    ] as const) {
      expect(stanza?.d1_databases).toEqual([{ binding: "DB", database_name: `replay-${env}-db` }]);
      expect(stanza?.r2_buckets).toEqual([{ binding: "PUBLISHED" }]);
    }
    expect(runs.map((run) => [run.env, run.written.map((entry) => entry.binding)])).toEqual([
      ["dev", ["DB", "PUBLISHED"]],
      ["staging", ["DB", "PUBLISHED"]],
      ["prod", ["DB", "PUBLISHED"]],
    ]);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toContain(
      "// The top level is the dev environment.",
    );
  });

  test("a second run writes nothing and leaves the file byte for byte", async () => {
    const options = {
      workerDir: worker,
      project: "replay",
      capabilities: [STATS],
      declarations: [],
      declined: new Set<string>(),
      ownBindings: [],
    };
    await reconcileDeclaredBindings(options);
    const first = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    const runs = await reconcileDeclaredBindings(options);
    expect(runs.every((run) => run.written.length === 0 && run.skipped.length === 0)).toBe(true);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(first);
  });

  test("leaves an entry the adopter wrote as they wrote it", async () => {
    await writeFile(
      join(worker, "wrangler.jsonc"),
      `{ "r2_buckets": [{ "binding": "PUBLISHED", "bucket_name": "mine" }], "env": {} }\n`,
    );
    const runs = await reconcileDeclaredBindings({
      workerDir: worker,
      project: "replay",
      capabilities: [STATS],
      declarations: [],
      declined: new Set(),
      ownBindings: [],
    });
    expect((await read()).r2_buckets).toEqual([{ binding: "PUBLISHED", bucket_name: "mine" }]);
    expect(runs[0]?.written.map((entry) => entry.binding)).toEqual(["DB"]);
  });

  test("writes a library capability's resources too, and leaves out an honored decline", async () => {
    const storage = library("storage", [
      { type: "kv", name: "CACHE" },
      { type: "r2", name: "UPLOADS", optional: true },
    ]);
    await reconcileDeclaredBindings({
      workerDir: worker,
      project: "replay",
      capabilities: [storage, STATS],
      declarations: [],
      declined: new Set(["UPLOADS"]),
      ownBindings: [],
      env: "staging",
    });
    const config = await read();
    expect(config.env.staging?.kv_namespaces).toEqual([{ binding: "CACHE" }]);
    expect(config.env.staging?.r2_buckets).toEqual([{ binding: "PUBLISHED" }]);
    // `--env staging` writes staging alone.
    expect(config.d1_databases).toBeUndefined();
    expect(config.env.prod?.d1_databases).toBeUndefined();
  });

  test("names an owned binding for its worker, with its own local store at the top level", async () => {
    await reconcileDeclaredBindings({
      workerDir: worker,
      project: "replay",
      capabilities: [STATS],
      declarations: [],
      declined: new Set(),
      ownBindings: ["DB"],
    });
    const config = await read();
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_name: "replay-dev-board---db", database_id: "replay-dev-board---db" },
    ]);
    expect(config.env.prod?.d1_databases).toEqual([{ binding: "DB", database_name: "replay-prod-board---db" }]);
  });

  test("names a global binding from its manifest, the way provisioning does", async () => {
    const queues = library("jobs", [{ type: "queue", name: "JOBS" }]);
    await reconcileDeclaredBindings({
      workerDir: worker,
      project: "replay",
      capabilities: [queues],
      declarations: [
        { name: "jobs", requiredBindings: [BindingSpec.parse({ type: "queue", name: "JOBS", scope: "global" })] },
      ],
      declined: new Set(),
      ownBindings: [],
    });
    const config = await read();
    expect(config.env.staging?.queues?.producers).toEqual([{ binding: "JOBS", queue: "replay-global-jobs" }]);
    expect(config.queues?.producers).toEqual([{ binding: "JOBS", queue: "replay-global-jobs" }]);
  });

  test("says why an entry that needs a name is not written without a project", async () => {
    const runs = await reconcileDeclaredBindings({
      workerDir: worker,
      capabilities: [app([{ type: "queue", name: "JOBS" }])],
      declarations: [],
      declined: new Set(),
      ownBindings: [],
      env: "dev",
    });
    expect(runs).toEqual([
      {
        env: "dev",
        written: [],
        skipped: [{ binding: "JOBS", type: "queue", reason: "no project name is resolved" }],
      },
    ]);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(SCAFFOLDED);
  });

  test("touches no file for a Worker composing no resource", async () => {
    const runs = await reconcileDeclaredBindings({
      workerDir: worker,
      project: "replay",
      capabilities: [app([{ type: "ai", name: "AI" }])],
      declarations: [],
      declined: new Set(),
      ownBindings: [],
    });
    expect(runs).toEqual([]);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(SCAFFOLDED);
  });
});

describe("declaredBindingSpecs", () => {
  test("is provisioning's set, in its order, each from the first capability declaring it", () => {
    const first = library("first", [
      { type: "d1", name: "DB" },
      { type: "ai", name: "AI" },
    ]);
    const second = library("second", [
      { type: "d1", name: "DB" },
      { type: "queue", name: "JOBS" },
      { type: "r2", name: "OPTIONAL", optional: true },
    ]);
    const declined = new Set(["OPTIONAL"]);
    const specs = declaredBindingSpecs([first, second], declined);
    expect(specs.map(({ spec }) => spec.name)).toEqual(
      provisionableBindings([first, second], declined).map((binding) => binding.binding),
    );
    expect(specs.map(({ capability }) => capability.name)).toEqual(["first", "second"]);
  });
});

describe("one writer for every binding kind provisioning knows", () => {
  // `pithy add`, `pithy upgrade` and `pithy worker sync` write through `appendBinding`, and `pithy provision`
  // creates the entry it stamps through it too. A kind provisioning creates and the writer cannot write fails here.
  const provisioned = (Object.keys(WRANGLER_KEYS) as BindingType[]).filter(
    (type) => provisionableBindings([library("probe", [probeSpec(type)])]).length > 0,
  );

  test("provisioning's resource kinds are the kinds it creates resources for", () => {
    expect([...provisioned].sort()).toEqual([...FeatureResource.shape.kind.options].sort());
  });

  test.each(provisioned)("the shared writer writes a %s entry", (type) => {
    const write = appendBinding({}, BindingSpec.parse(probeSpec(type)), {
      project: "replay",
      env: "staging",
      capability: "app",
    });
    expect(write.outcome).toBe("written");
  });
});

/** The smallest spec `BindingSpec` accepts for a kind. */
function probeSpec(type: BindingType): BindingSpecInput {
  switch (type) {
    case "durable_object":
      return { type, name: "PROBE", className: "Probe", classModule: "@pithy-sh/probe" };
    case "workflow":
      return { type, name: "PROBE", job: "probe", className: "Probe" };
    case "service":
      return { type, name: "PROBE", service: "other" };
    case "hyperdrive":
    case "analytics_engine_datasets":
    case "pipelines":
    case "mtls_certificates":
    case "dispatch_namespaces":
      return { type, name: "PROBE", target: "probe" };
    default:
      return { type, name: "PROBE" };
  }
}
