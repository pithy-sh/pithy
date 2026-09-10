// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { environmentScope, featureScope } from "@pithy-sh/core/src/naming/provisionScope";
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
    //
    // **This one is blind to #514, and stays.** It writes the manifest to the *project root*, which is
    // where the old root-only scan was already looking, so it was green before that fix and after it. The
    // gate is "creates nothing for a decline whose capability is installed only under the Worker's own
    // node_modules" below; this is the control that keeps a root-declared capability working.
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

  /**
   * **The same decline, with the manifest where the kit tells adopters to put it (#514).**
   *
   * The case above and the one below are the pair that made this look covered, and they are blind to it
   * for one reason: both write the fixture manifest to `<root>/node_modules/@pithy-sh/app` — the *project
   * root* — which is the one place `availableManifests(projectDir)` was already looking. They pass before
   * this fix and after it, and neither can fail while a Worker's own `node_modules` is never read.
   *
   * A capability declared only on the Worker composing it — capabilities being per-Worker, which is the
   * shape this repository's own principles state — installs under `apps/<name>/node_modules`. The root
   * scan found nothing there, so the decline resolved as `unrecognized`, and provisioning created the
   * bucket and wrote the binding back into the file the adopter had removed it from. `pithy upgrade` had
   * honored the same declaration since #440; the two commands disagreed about one config line.
   *
   * **This test is the gate.** The manifest goes under the Worker and nowhere else — the arrangement is
   * the whole assertion, so it is written out here rather than shared with a neighbor that could quietly
   * move it back to the root. Both halves are asserted, because the resource and the stanza are two
   * separate writes off one answer: a fix that skipped the creation but still wrote the binding would
   * leave a `wrangler.jsonc` pointing at a bucket that does not exist.
   */
  test("creates nothing for a decline whose capability is installed only under the Worker's own node_modules", async () => {
    const optional = defineCapability({
      name: "app",
      requiredBindings: [
        { type: "d1", name: "DB" },
        { type: "kv", name: "CACHE" },
        { type: "r2", name: "ASSETS", optional: true },
      ] satisfies BindingSpecInput[],
    });
    // Under `apps/board/`, and deliberately not under the project root.
    const pkgDir = join(workerDir, "node_modules", "@pithy-sh", "app");
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
          config: {
            capabilities: [],
            declinedBindings: { ASSETS: "Attachments are off, so nothing would ever be written to it." },
          } as never,
        },
      ],
      ...noBackend,
    });

    expect([...stores.r2.keys()]).toEqual([]);
    // And the binding is not written back into the file the adopter removed it from — the second half of
    // the report in #514, and a separate write from the one above.
    const stanza = await readStanza(workerDir, "staging");
    expect((stanza?.r2_buckets ?? []).map((bucket) => bucket.binding)).toEqual([]);
    // The skip is reported. A resource that was not created leaves no other trace of itself.
    expect(report.declined).toEqual([
      {
        state: "read",
        worker: "replay-board",
        declines: [
          {
            state: "honored",
            name: "ASSETS",
            type: "r2",
            capability: "app",
            reason: "Attachments are off, so nothing would ever be written to it.",
            wantedBy: [],
          },
        ],
      },
    ]);
  });

  /**
   * **A forked capability's decline is honored, because provisioning acts on the fork.**
   *
   * The first cut of #514 passed `ejectedCapabilities` into this resolution "for the same reason
   * `buildReconcilePlan` passes it", and that reason does not carry across. An upgrade *skips* an ejected
   * capability — it writes nothing for a fork — so dropping its manifest costs the fork nothing. This
   * command decides what to create from the **composed instances**, and a fork is composed: drop its
   * manifest and the decline resolves `unrecognized`, the bucket is created, and the binding is written
   * back into the file the adopter removed it from. That is #440 verbatim, for the one capability whose
   * code the adopter owns, and silent, because an unrecognized decline reports no skip.
   *
   * **This test is the gate for that.** Revert the `ejected` argument at the call site and both halves
   * fail: `stores.r2` gains the bucket and `report.declined` empties.
   */
  test("honors a decline against an ejected capability, because the fork it composes is what gets provisioned", async () => {
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
    // The local import **is** the ejected signal — `pithy upgrade` reads this file and nothing else.
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      'import { app } from "./capabilities/app";\n\nexport default { capabilities: [app] };\n',
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
          config: { capabilities: [], declinedBindings: { ASSETS: "the fork does not use it" } } as never,
        },
      ],
      ...noBackend,
    });

    expect([...stores.r2.keys()]).toEqual([]);
    // And not written back into the stanza the adopter emptied — the second half of #440.
    expect(((await readStanza(workerDir, "staging"))?.r2_buckets ?? []).map((bucket) => bucket.binding)).toEqual([]);
    expect(report.declined).toEqual([
      {
        state: "read",
        worker: "replay-board",
        declines: [
          {
            state: "honored",
            name: "ASSETS",
            type: "r2",
            capability: "app",
            reason: "the fork does not use it",
            wantedBy: [],
          },
        ],
      },
    ]);
  });

  /**
   * **The likelier typo, and the one the honored-only report kept silent.**
   *
   * `invalid` earned a line because a decline dropped on the floor must not read as a project that
   * declines nothing. A one-character slip in the *binding name* drops the same decline on the same floor
   * by a shorter path — `ASSET` for `ASSETS` — and until this it produced no line at all: the resource was
   * created and the run printed exactly what a clean run prints.
   *
   * The state is reported and the resource math is untouched. `unrecognized` is not a skip, and the
   * sentence says so; what it stops is the silence.
   */
  test("reports a decline that names nothing, rather than provisioning everything in silence", async () => {
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
          // One character short of the binding the capability declares.
          config: { capabilities: [], declinedBindings: { ASSET: "no R2 in this account" } } as never,
        },
      ],
      ...noBackend,
    });

    // Nothing was left out — an unrecognized decline names nothing to leave out.
    expect([...stores.r2.keys()]).toEqual(["replay-staging-assets"]);
    // But the run says so, which is the whole of the fix.
    expect(report.declined).toEqual([
      {
        state: "read",
        worker: "replay-board",
        declines: [{ state: "unrecognized", name: "ASSET", reason: "no R2 in this account" }],
      },
    ]);
  });

  /**
   * **One typo, and everything declined is created — so the run has to say so.**
   *
   * A `declinedBindings` block that will not read resolves to no honored names, which is correct and is
   * also indistinguishable, at the filter, from a Worker that declines nothing. So the resource is
   * created — that part is deliberate, because provisioning must not guess at a declaration it cannot
   * parse — and the state has to survive as far as the report, or the adopter learns that their decline
   * was never applied from the Cloudflare bill.
   *
   * The near-miss key is the case this is really for: the scaffolded config literal is unannotated, so
   * TypeScript accepts `declinedBinding` and nothing reads it.
   */
  test("an unreadable declinedBindings block provisions everything, and is reported rather than silent", async () => {
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
          // The singular. TypeScript accepts it, and until #514 so did the run.
          config: { capabilities: [], declinedBinding: { ASSETS: "no R2 in this account" } } as never,
        },
      ],
      ...noBackend,
    });

    expect([...stores.r2.keys()]).toEqual(["replay-staging-assets"]);
    expect(report.declined).toHaveLength(1);
    const [entry] = report.declined;
    expect(entry?.state).toBe("invalid");
    // The problem names the key, so the adopter knows which line to fix rather than which file to search.
    expect(entry?.state === "invalid" && entry.problem).toContain("declinedBinding");
    expect(entry?.worker).toBe("replay-board");
  });

  test("a resource survives one Worker declining it while another still wants it", async () => {
    // The environment provisions one resource per binding *name* — that is how two Workers share a
    // database. So a decline is only decisive when every Worker that declares the binding declines it;
    // one Worker opting out must not take the other's bucket away.
    //
    // **The second of the blind pair, and it stays too**: its manifest is at the project root as well.
    // It pins the union rule, which #514's fix must not disturb — and the report it now carries is what
    // stops the run calling this a skip, because the bucket exists.
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
          config: { capabilities: [], declinedBindings: { ASSETS: "not here" } } as never,
        },
        { name: "replay-collab", dir: secondDir, capabilities: [optional] },
      ],
      ...noBackend,
    });

    expect([...stores.r2.keys()]).toEqual(["replay-staging-assets"]);
    // **And the bucket that exists is wired into the Worker that wanted it, and only that one.** This is
    // the half the single-Worker case cannot state: there, a resource that is never created cannot be
    // written either, so the stanza follows from the creation. Here the resource exists, so omitting it
    // from the declining Worker's config is a second decision — and the one a fix that resolved declines
    // twice, once per loop, gets wrong.
    expect(((await readStanza(workerDir, "staging"))?.r2_buckets ?? []).map((bucket) => bucket.binding)).toEqual([]);
    expect(((await readStanza(secondDir, "staging"))?.r2_buckets ?? []).map((bucket) => bucket.binding)).toEqual([
      "ASSETS",
    ]);
    // And the report names the Worker that kept it, so the run cannot report a skip it did not take.
    expect(report.declined).toEqual([
      {
        state: "read",
        worker: "replay-board",
        declines: [
          {
            state: "honored",
            name: "ASSETS",
            type: "r2",
            capability: "app",
            reason: "not here",
            wantedBy: ["replay-collab"],
          },
        ],
      },
    ]);
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

  /**
   * **What a binding's manifest says about its resource's name, honored by the run (#513).**
   *
   * The run reads `scope` and `resource` from the manifest and from nowhere else — `pithy add` and
   * `pithy upgrade` both read the manifest and neither reaches a composed instance, so a declaration on
   * the capability object would be invisible to two of the three writers. These tests install fixture
   * manifests for that reason: a capability composed with no manifest declares nothing, which is the
   * adopter's own `app` capability and stays exactly as it was.
   */
  describe("a binding's declared naming", () => {
    /** Install a fixture manifest where a Worker's composed manifests are resolved from. */
    const install = async (root: string, name: string, requiredBindings: unknown[]): Promise<void> => {
      const pkgDir = join(root, "node_modules", "@pithy-sh", name);
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        join(pkgDir, "pithy.manifest.json"),
        JSON.stringify({ name, package: `@pithy-sh/${name}`, requiredBindings }),
      );
    };

    const emailBindings = [
      { type: "d1", name: "DB" },
      { type: "d1", name: "EMAIL_SUPPRESSIONS", scope: "global" },
    ];
    const email = defineCapability({
      name: "email",
      requiredBindings: emailBindings as BindingSpecInput[],
    });
    const emailWorkers = () => async () => [{ name: "replay-board", dir: workerDir, capabilities: [email] }];

    test("creates a project-global resource once, under `global`, and writes it into the stanza", async () => {
      await install(dir, "email", emailBindings);
      const { stores, provisioners } = fakeProvisioners();

      const report = await provisionEnvironment({
        projectDir: dir,
        scope,
        capabilities: [email],
        provisioners,
        resolveWorkers: emailWorkers(),
        ...noBackend,
      });

      // The suppression database carries no environment segment; the app database beside it still does.
      expect(report.resources.map((resource) => resource.name)).toEqual([
        "replay-staging-db",
        "replay-global-email-suppressions",
      ]);
      expect([...stores.d1.keys()]).toEqual(["replay-staging-db", "replay-global-email-suppressions"]);

      const stanza = await readStanza(workerDir, "staging");
      expect(stanza?.d1_databases).toEqual([
        { binding: "DB", database_name: "replay-staging-db", database_id: "d1-1" },
        { binding: "EMAIL_SUPPRESSIONS", database_name: "replay-global-email-suppressions", database_id: "d1-2" },
      ]);
    });

    test("refuses two capabilities that disagree about the resource behind one binding", async () => {
      // First-wins would let `readdir` order decide where a project's data lives — one run's suppression
      // list is the project's, the next run's is staging's, and nothing said so.
      await install(dir, "email", emailBindings);
      await install(dir, "other", [{ type: "d1", name: "EMAIL_SUPPRESSIONS" }]);
      const other = defineCapability({
        name: "other",
        requiredBindings: [{ type: "d1", name: "EMAIL_SUPPRESSIONS" }] satisfies BindingSpecInput[],
      });
      const { stores, provisioners } = fakeProvisioners();

      const run = provisionEnvironment({
        projectDir: dir,
        scope,
        capabilities: [email, other],
        provisioners,
        resolveWorkers: async () => [{ name: "replay-board", dir: workerDir, capabilities: [email, other] }],
        ...noBackend,
      });

      await expect(run).rejects.toThrow(/email.*other|other.*email/);
      await expect(run).rejects.toThrow(/replay-global-email-suppressions/);
      await expect(run).rejects.toThrow(/replay-staging-email-suppressions/);
      // Refused before the account was reached — a refusal after the third create is a half-provisioned
      // account, which is worse than either name.
      expect([...stores.d1.keys()]).toEqual([]);
    });

    test("refuses two bindings that compose one name", async () => {
      // `resource` removes the property that made the binding name the unique key. Nothing else would
      // catch it: the run would create one bucket, adopt it on the second pass, and hand two capabilities
      // a store each believes is its own.
      const bindings = [
        { type: "r2", name: "SUPPORT_BUCKET", resource: "support" },
        { type: "r2", name: "SUPPORT" },
      ];
      await install(dir, "support", [bindings[0]]);
      await install(dir, "helpdesk", [bindings[1]]);
      const support = defineCapability({
        name: "support",
        requiredBindings: [{ type: "r2", name: "SUPPORT_BUCKET" }] satisfies BindingSpecInput[],
      });
      const helpdesk = defineCapability({
        name: "helpdesk",
        requiredBindings: [{ type: "r2", name: "SUPPORT" }] satisfies BindingSpecInput[],
      });
      const { stores, provisioners } = fakeProvisioners();

      const run = provisionEnvironment({
        projectDir: dir,
        scope,
        capabilities: [support, helpdesk],
        provisioners,
        resolveWorkers: async () => [{ name: "replay-board", dir: workerDir, capabilities: [support, helpdesk] }],
        ...noBackend,
      });

      await expect(run).rejects.toThrow(/support.*helpdesk|helpdesk.*support/);
      await expect(run).rejects.toThrow(/replay-staging-support\b/);
      expect([...stores.r2.keys()]).toEqual([]);
    });

    test("keeps a project-global resource out of a feature's teardown record", async () => {
      // A feature's record is its exact-id delete list. A resource the whole project shares has no
      // business in it — `destroy` deletes what it finds there by id, so one branch would take the
      // project's suppression list with it.
      await install(dir, "email", emailBindings);
      const { provisioners } = fakeProvisioners();
      const saved: { binding: string; name: string }[][] = [];
      const record = {
        load: async () => [],
        save: async (resources: { binding: string; name: string }[]) => void saved.push(resources),
      };

      // A feature names nothing `global` in the first place — `featureScope` takes the naming and ignores
      // it — so every resource here is the feature's own and every one of them is recorded.
      const feature = await provisionEnvironment({
        projectDir: dir,
        scope: featureScope({ project: "replay", issue: "513", slug: "binding-scope" }),
        capabilities: [email],
        provisioners,
        resolveWorkers: emailWorkers(),
        record,
        ...noBackend,
      });
      expect(feature.resources.map((resource) => resource.name)).toEqual([
        "replay-f513-binding-scope-db-d1",
        "replay-f513-binding-scope-email-suppressions-d1",
      ]);
      expect(saved.at(-1)?.map((resource) => resource.name)).toEqual([
        "replay-f513-binding-scope-db-d1",
        "replay-f513-binding-scope-email-suppressions-d1",
      ]);

      // And the guard from the other end, so honoring `global` in a feature namer could never quietly
      // become a deletion: a run that *does* compose a global name records everything but that.
      saved.length = 0;
      await provisionEnvironment({
        projectDir: dir,
        scope,
        capabilities: [email],
        provisioners,
        resolveWorkers: emailWorkers(),
        record,
        ...noBackend,
      });
      expect(saved.at(-1)?.map((resource) => resource.name)).toEqual(["replay-staging-db"]);
    });
  });
});
