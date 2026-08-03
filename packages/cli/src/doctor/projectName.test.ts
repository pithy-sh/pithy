// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type CheckProjectNameOptions,
  checkProjectName,
  type DeclaredResource,
  declaredResources,
  describeProjectName,
  misnamedResources,
  type ProjectNameCheck,
  projectSegmentOf,
  wholesaleRename,
} from "./projectName";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-project-name-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * `checkProjectName`, asserted to have answered. It returns `null` only when the root `pithy.config.ts`
 * could not be read, and every case below writes one first — so a `null` here is the fixture breaking, not
 * a verdict, and it should fail loudly rather than narrow away behind a `?.`.
 */
async function nameCheck(options: CheckProjectNameOptions = {}): Promise<ProjectNameCheck> {
  const check = await checkProjectName(dir, options);
  if (check === null) throw new Error("checkProjectName declined to answer — the fixture has no root config");
  return check;
}

/** Write one worker under `apps/<name>/wrangler.jsonc`, the surface this check reads. */
async function writeWorker(name: string, config: Record<string, unknown>): Promise<void> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name, ...config }, null, 2));
}

describe("projectSegmentOf", () => {
  test("reads the project segment off a name that has Pithy's shape", () => {
    expect(projectSegmentOf("acme-prod-db", "prod", "DB")).toBe("acme");
  });

  test("kebabs the binding, so DB matches -db and MEDIA_BUCKET matches -media-bucket", () => {
    expect(projectSegmentOf("acme-dev-media-bucket", "dev", "MEDIA_BUCKET")).toBe("acme");
  });

  test("a hyphenated project name keeps all of its segments", () => {
    expect(projectSegmentOf("acme-games-staging-db", "staging", "DB")).toBe("acme-games");
  });

  test("a name the adopter chose has no Pithy shape and no opinion is offered", () => {
    expect(projectSegmentOf("my-db", "prod", "DB")).toBeNull();
    expect(projectSegmentOf("legacy_store", "dev", "DB")).toBeNull();
  });

  test("the suffix alone is not a project — there is nothing in front of it", () => {
    expect(projectSegmentOf("production-db", "prod", "DB")).toBeNull();
  });

  test("the wrong environment does not match, so a name is only read against its own stanza", () => {
    expect(projectSegmentOf("acme-prod-db", "staging", "DB")).toBeNull();
  });
});

describe("misnamedResources", () => {
  const declared = (over: Partial<DeclaredResource> = {}): DeclaredResource => ({
    name: "acme-prod-db",
    kind: "d1",
    worker: "api",
    env: "prod",
    binding: "DB",
    ...over,
  });

  test("a name leading with the configured project is not misnamed", () => {
    expect(misnamedResources("acme", [declared()])).toEqual([]);
  });

  test("the configured name is kebabed before comparison, so Acme still matches acme", () => {
    expect(misnamedResources("Acme", [declared()])).toEqual([]);
  });

  test("a different project segment is reported, with the worker and env that declare it", () => {
    expect(misnamedResources("newname", [declared()])).toEqual([
      {
        name: "acme-prod-db",
        project: "acme",
        kind: "d1",
        worker: "api",
        env: "prod",
        binding: "DB",
      },
    ]);
  });

  test("a hand-picked name is never reported — it has no project segment to disagree with", () => {
    expect(misnamedResources("newname", [declared({ name: "my-db" })])).toEqual([]);
  });

  test("r2 buckets are read the same way as d1 databases", () => {
    const bucket = declared({ name: "acme-dev-media-bucket", kind: "r2", env: "dev", binding: "MEDIA_BUCKET" });
    expect(misnamedResources("newname", [bucket]).map((entry) => entry.kind)).toEqual(["r2"]);
  });
});

describe("declaredResources", () => {
  test("reads every environment's named entries across every worker", async () => {
    await writeWorker("api", {
      d1_databases: [{ binding: "DB", database_name: "acme-dev-db" }],
      r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "acme-dev-media-bucket" }],
      env: {
        prod: { d1_databases: [{ binding: "DB", database_name: "acme-prod-db" }] },
      },
    });
    await writeWorker("collab", {
      d1_databases: [{ binding: "COLLAB_DB", database_name: "acme-dev-collab-db" }],
    });

    const { resources, unreadable } = await declaredResources(dir);
    expect(unreadable).toBe(false);
    expect(resources.map((entry) => `${entry.worker}:${entry.env}:${entry.name}`).sort()).toEqual([
      "api:dev:acme-dev-db",
      "api:dev:acme-dev-media-bucket",
      "api:prod:acme-prod-db",
      "collab:dev:acme-dev-collab-db",
    ]);
  });

  test("an entry with no name declares nothing — a binding wrangler completes later is not a claim", async () => {
    await writeWorker("api", { d1_databases: [{ binding: "DB" }], kv_namespaces: [{ binding: "SESSIONS" }] });
    expect((await declaredResources(dir)).resources).toEqual([]);
  });

  test("an unparseable wrangler.jsonc is recorded, not thrown — the other workers still answer", async () => {
    await writeWorker("api", { d1_databases: [{ binding: "DB", database_name: "acme-dev-db" }] });
    const brokenDir = join(dir, "apps", "broken");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, "wrangler.jsonc"), "{ this is not json");

    const { resources, unreadable } = await declaredResources(dir);
    expect(unreadable).toBe(true);
    expect(resources.map((entry) => entry.name)).toEqual(["acme-dev-db"]);
  });

  test("a project with no apps/ declares nothing and reads cleanly", async () => {
    expect(await declaredResources(dir)).toEqual({ resources: [], unreadable: false });
  });

  test("a malformed pithy.worker.jsonc is recorded as unreadable, not thrown", async () => {
    // discoverWorkers parses every apps/<name>/pithy.worker.jsonc and throws on a bad one. A diagnostic
    // that cannot enumerate the worker set has learned nothing, but it must say so rather than explode.
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "pithy.worker.jsonc"), "{ not json");

    expect(await declaredResources(dir)).toEqual({ resources: [], unreadable: true });
  });

  test("a pithy.worker.jsonc that fails the manifest schema is unreadable too, not thrown", async () => {
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "pithy.worker.jsonc"), JSON.stringify({ dev: { autostart: "yes" } }));

    expect(await declaredResources(dir)).toEqual({ resources: [], unreadable: true });
  });

  test("a non-Worker process in apps/ is skipped, not counted as unreadable", async () => {
    // A Vite frontend joins the dev set through pithy.worker.jsonc alone — it has no wrangler.jsonc,
    // and a healthy project must not be reported as unchecked because of it.
    const webDir = join(dir, "apps", "web");
    await mkdir(webDir, { recursive: true });
    await writeFile(join(webDir, "pithy.worker.jsonc"), JSON.stringify({ dev: { autostart: true } }));

    expect(await declaredResources(dir)).toEqual({ resources: [], unreadable: false });
  });
});

describe("checkProjectName", () => {
  test("no root pithy.config.ts is not a name question at all, and reaches no network", async () => {
    // Not `unconfigured`: that state's advice is "add `name` to pithy.config.ts", which is the wrong
    // sentence for a directory that has no pithy.config.ts. Doctor's `Project:` block reports the missing
    // file; this check declines to answer a question nobody can ask here.
    expect(await checkProjectName(dir)).toBeNull();
  });

  test("a config that will not load is not a name question either", async () => {
    // The file exists but its import throws. Doctor's `Project:` block says "could not load"; a name
    // verdict here would dispute it with a second, wronger sentence.
    await writeFile(join(dir, "pithy.config.ts"), 'throw new Error("boom");\n');

    expect(await checkProjectName(dir)).toBeNull();
  });

  test("a config that loaded and set no name is unconfigured — the case that message was written for", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");

    expect(await checkProjectName(dir)).toEqual({ state: "unconfigured", project: null, misnamed: [] });
  });

  test("a name no Cloudflare namespace could carry is invalid, not unconfigured", async () => {
    // The operator set a name; it is just illegal. Reporting "not set" tells them to add the thing they
    // already added, while `pithy add`, `migrate`, and `token mint` all hard-fail on it.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "2026-launch" };\n');

    expect(await checkProjectName(dir)).toEqual({ state: "invalid", project: "2026-launch", misnamed: [] });
  });

  test("a database the adopter had before Pithy is not a rename", async () => {
    // The migrate-an-existing-Worker-into-Pithy path. `<app>-<env>-<resource>` is the ordinary
    // Cloudflare convention, so a name having Pithy's *shape* proves nothing about who made it.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    await writeWorker("api", {
      env: { prod: { d1_databases: [{ binding: "DB", database_name: "myapp-prod-db" }] } },
    });

    expect(await nameCheck({ probeAccount: async () => new Map() })).toEqual({
      state: "ok",
      project: "acme",
      misnamed: [],
    });
  });

  test("a malformed pithy.worker.jsonc is a state, not a throw — doctor still runs in the broken project", async () => {
    // The whole point of the probe is to work in the environment it exists to diagnose. A worker manifest
    // that will not parse must resolve to could-not-check, with the name it did manage to read.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "pithy.worker.jsonc"), "{ not json");

    expect(await checkProjectName(dir)).toEqual({ state: "could-not-check", project: "acme", misnamed: [] });
  });

  test("one legacy name beside correctly named resources is not a rename either", async () => {
    // A rename moves one string, so every derived name moves with it. A wiring that still names the
    // configured project has not been renamed — the odd one out came from somewhere else.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    await writeWorker("api", {
      d1_databases: [{ binding: "DB", database_name: "acme-dev-db" }],
      r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "acme-dev-media-bucket" }],
      env: {
        prod: {
          d1_databases: [
            { binding: "DB", database_name: "acme-prod-db" },
            { binding: "LEGACY_DB", database_name: "myapp-prod-legacy-db" },
          ],
        },
      },
    });

    const check = await nameCheck({ probeAccount: async () => new Map() });
    expect(check.state).toBe("ok");
    expect(check.misnamed).toEqual([]);
  });

  test("a wholesale rename is still caught — every name leads with the old project, none with the new", async () => {
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "newname" };\n');
    await writeWorker("api", {
      d1_databases: [{ binding: "DB", database_name: "oldname-dev-db" }],
      env: { prod: { d1_databases: [{ binding: "DB", database_name: "oldname-prod-db" }] } },
    });

    const check = await nameCheck({ probeAccount: async () => new Map() });
    expect(check.state).toBe("drifted");
    expect(check.project).toBe("newname");
    expect(check.misnamed.map((entry) => entry.name).sort()).toEqual(["oldname-dev-db", "oldname-prod-db"]);
    // Unasked is unknown, never "not there".
    expect(check.misnamed.every((entry) => entry.provisioned === null && entry.owner === null)).toBe(true);
  });

  test("two legacy names from one old app read as a wholesale rename — stated, not hidden", async () => {
    // The ambiguous case, decided deliberately. Two names, one foreign segment, the configured project
    // nowhere in the wiring: locally indistinguishable from a rename, and a real fault either way — pithy
    // will provision `acme-*` beside them and never touch these. So it is reported, and the copy names both
    // readings and asks for one rather than claiming the resources are ours.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    await writeWorker("api", {
      d1_databases: [{ binding: "DB", database_name: "myapp-dev-db" }],
      env: { prod: { d1_databases: [{ binding: "DB", database_name: "myapp-prod-db" }] } },
    });

    const check = await nameCheck({ probeAccount: async () => new Map() });
    expect(check.state).toBe("drifted");
    const text = describeProjectName(check);
    expect(text).toContain("rename the project, or rename the resources");
    expect(text).not.toContain("delete");
  });

  test("a capability-named bucket counts as the configured name appearing — the thing slot is not the binding", async () => {
    // The same false positive, reached through the other door. Several capabilities put the *capability*
    // in the thing slot rather than the binding: `resourceNames(p).env(e).r2("storage")` composes
    // `acme-prod-storage` for the `STORAGE_BUCKET` binding, and media and support do the same. So a
    // correctly named, Pithy-created bucket does not end in `-<env>-<kebab(binding)>` and cannot satisfy a
    // shape-based "the configured name appears somewhere" test — which fires the deduction on exactly the
    // adoption path it was rewritten to protect: `pithy add` proposed the D1 names, the adopter repointed
    // them at their existing `myapp-*` databases, and `pithy storage provision` legitimately made
    // `acme-*-storage` beside them.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    await writeWorker("api", {
      d1_databases: [{ binding: "DB", database_name: "myapp-dev-db" }],
      r2_buckets: [{ binding: "STORAGE_BUCKET", bucket_name: "acme-dev-storage" }],
      env: {
        prod: {
          d1_databases: [{ binding: "DB", database_name: "myapp-prod-db" }],
          r2_buckets: [{ binding: "STORAGE_BUCKET", bucket_name: "acme-prod-storage" }],
        },
      },
    });

    const check = await nameCheck({ probeAccount: async () => new Map() });
    expect(check.state).toBe("ok");
    expect(check.misnamed).toEqual([]);
  });

  test("two different foreign projects are not one rename — one string cannot have done both", async () => {
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    await writeWorker("api", {
      d1_databases: [{ binding: "DB", database_name: "myapp-dev-db" }],
      env: { prod: { d1_databases: [{ binding: "DB", database_name: "otherapp-prod-db" }] } },
    });

    expect((await nameCheck({ probeAccount: async () => new Map() })).state).toBe("ok");
  });

  test("two workers sharing one binding declare one resource, not two — no plurality from that", async () => {
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    await writeWorker("api", { d1_databases: [{ binding: "DB", database_name: "myapp-dev-db" }] });
    await writeWorker("collab", { d1_databases: [{ binding: "DB", database_name: "myapp-dev-db" }] });

    expect((await nameCheck({ probeAccount: async () => new Map() })).state).toBe("ok");
  });

  test("a live database that exists is still not an orphan — existence is not ownership", async () => {
    // The whole defect in one assertion: the adopter's production database is live, and that is exactly
    // what a database of theirs looks like. Only Pithy's own stamp can say Pithy made it.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    await writeWorker("api", {
      env: { prod: { d1_databases: [{ binding: "DB", database_name: "myapp-prod-db" }] } },
    });

    const check = await nameCheck({
      probeAccount: async () => new Map([["myapp-prod-db", { exists: true, owner: null }]]),
    });
    expect(check.state).toBe("ok");
  });

  test("the owner stamp proves it — a database pithy migrated under the old name is an orphan", async () => {
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "newname" };\n');
    await writeWorker("api", {
      env: { prod: { d1_databases: [{ binding: "DB", database_name: "oldname-prod-db" }] } },
    });

    const check = await nameCheck({
      probeAccount: async () => new Map([["oldname-prod-db", { exists: true, owner: "oldname" }]]),
    });
    expect(check.state).toBe("orphaned");
    expect(check.misnamed).toEqual([
      {
        name: "oldname-prod-db",
        project: "oldname",
        kind: "d1",
        worker: "api",
        env: "prod",
        binding: "DB",
        provisioned: true,
        owner: "oldname",
      },
    ]);
  });

  test("proof outranks the mix — a rename that has since re-provisioned is still caught", async () => {
    // After a rename the adopter runs `pithy add`, which writes new-name resources beside the old. The
    // wiring is now mixed, so the local deduction cannot fire. The stamp still can, and it is the only
    // thing that can tell this apart from a legacy database.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "newname" };\n');
    await writeWorker("api", {
      d1_databases: [{ binding: "DB", database_name: "newname-dev-db" }],
      env: { prod: { d1_databases: [{ binding: "DB", database_name: "oldname-prod-db" }] } },
    });

    const check = await nameCheck({
      probeAccount: async () => new Map([["oldname-prod-db", { exists: true, owner: "oldname" }]]),
    });
    expect(check.state).toBe("orphaned");
  });

  test("only the proven project is reported — an unproven legacy name is not dragged in with it", async () => {
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "newname" };\n');
    await writeWorker("api", {
      d1_databases: [{ binding: "DB", database_name: "oldname-dev-db" }],
      env: { prod: { d1_databases: [{ binding: "LEGACY_DB", database_name: "myapp-prod-legacy-db" }] } },
    });

    const check = await nameCheck({
      probeAccount: async () =>
        new Map([
          ["oldname-dev-db", { exists: true, owner: "oldname" }],
          ["myapp-prod-legacy-db", { exists: true, owner: null }],
        ]),
    });
    expect(check.state).toBe("orphaned");
    expect(check.misnamed.map((entry) => entry.name)).toEqual(["oldname-dev-db"]);
  });

  test("a wrangler.jsonc that would not parse blocks the deduction, not the proof", async () => {
    // The deduction turns on the configured name appearing nowhere — and the file that would not parse is
    // exactly where it might have been. An inference drawn from missing files is not a finding.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    await writeWorker("api", {
      d1_databases: [{ binding: "DB", database_name: "myapp-dev-db" }],
      env: { prod: { d1_databases: [{ binding: "DB", database_name: "myapp-prod-db" }] } },
    });
    const brokenDir = join(dir, "apps", "broken");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, "wrangler.jsonc"), "{ this is not json");

    expect((await nameCheck({ probeAccount: async () => new Map() })).state).toBe("could-not-check");

    // A stamp is a fact about one database, so it survives the partial read.
    const proven = await nameCheck({
      probeAccount: async () => new Map([["myapp-prod-db", { exists: true, owner: "myapp" }]]),
    });
    expect(proven.state).toBe("orphaned");
  });

  test("a stamp naming the configured project proves nothing is wrong", async () => {
    // A database Pithy migrated as `acme` that happens to sit under a name from before the convention.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    await writeWorker("api", {
      env: { prod: { d1_databases: [{ binding: "DB", database_name: "myapp-prod-db" }] } },
    });

    const check = await nameCheck({
      probeAccount: async () => new Map([["myapp-prod-db", { exists: true, owner: "acme" }]]),
    });
    expect(check.state).toBe("ok");
  });
});

describe("wholesaleRename", () => {
  const declared = (name: string, over: Partial<DeclaredResource> = {}): DeclaredResource => ({
    name,
    kind: "d1",
    worker: "api",
    env: "prod",
    binding: "DB",
    ...over,
  });
  const verdict = (project: string, resources: DeclaredResource[]) =>
    wholesaleRename(project, resources, misnamedResources(project, resources));

  test("every name on one other project, and the configured one nowhere", () => {
    const resources = [declared("oldname-prod-db"), declared("oldname-dev-db", { env: "dev" })];
    expect(verdict("newname", resources)).toBe(true);
  });

  test("the configured name appearing anywhere settles it — a rename moves one string", () => {
    const resources = [
      declared("oldname-prod-db"),
      declared("oldname-dev-db", { env: "dev" }),
      declared("acme-dev-media-bucket", { kind: "r2", env: "dev", binding: "MEDIA_BUCKET" }),
    ];
    expect(verdict("acme", resources)).toBe(false);
  });

  test("the configured name leads a name it did not shape — the capability sits in the thing slot", () => {
    // `resourceNames("acme").env("prod").r2("storage")` is `acme-prod-storage` on `STORAGE_BUCKET`. Pithy
    // made it, under the configured name, and no strict `-<env>-<binding>` tail will ever see it. The
    // escape asks whether the configured project *leads* a declared name, which is the actual question.
    const resources = [
      declared("myapp-dev-db", { env: "dev" }),
      declared("myapp-prod-db"),
      declared("acme-dev-storage", { kind: "r2", env: "dev", binding: "STORAGE_BUCKET" }),
      declared("acme-prod-storage", { kind: "r2", binding: "STORAGE_BUCKET" }),
    ];
    expect(verdict("acme", resources)).toBe(false);
  });

  test("a name merely starting with the same letters is not the project leading it", () => {
    // `acmecorp-prod-db` leads with `acmecorp`, not with `acme`. Only a whole leading segment counts.
    const resources = [declared("myapp-dev-db", { env: "dev" }), declared("myapp-prod-db"), declared("acmecorp-x")];
    expect(verdict("acme", resources)).toBe(true);
  });

  test("one name is a resource, not a fingerprint", () => {
    expect(verdict("acme", [declared("myapp-prod-db")])).toBe(false);
  });

  test("a hand-picked name never counts toward it, in either direction", () => {
    // `legacy_store` has no Pithy shape, so it is neither a candidate nor proof the project is fine.
    const resources = [declared("legacy_store"), declared("myapp-prod-db")];
    expect(verdict("acme", resources)).toBe(false);
  });

  test("nothing declared is not a rename", () => {
    expect(verdict("acme", [])).toBe(false);
  });
});

describe("describeProjectName", () => {
  const check = (over: Partial<ProjectNameCheck>): ProjectNameCheck => ({
    state: "ok",
    project: "acme",
    misnamed: [],
    ...over,
  });

  const orphan = (name: string, project: string, provisioned: boolean | null, owner: string | null = null) => ({
    name,
    project,
    kind: "d1" as const,
    worker: "api",
    env: "prod",
    binding: "DB",
    provisioned,
    owner,
  });

  test("a matching name reports the name it matched", () => {
    expect(describeProjectName(check({}))).toBe("acme — every resource name matches");
  });

  test("unconfigured says where to set it and why it matters", () => {
    const text = describeProjectName(check({ state: "unconfigured", project: null }));
    expect(text).toContain("pithy.config.ts");
    expect(text).toContain("every resource name derives from it");
  });

  test("invalid names the name that was set and the rule it breaks", () => {
    const text = describeProjectName(check({ state: "invalid", project: "2026-launch" }));
    expect(text).toContain("2026-launch");
    // The rule comes from the one seam, so a rule added there is picked up here. Only the
    // digit-leading half is asserted — the length half is that seam's business, not this renderer's.
    expect(text).toContain("letter");
    expect(text).not.toContain("not set");
  });

  test("could-not-check claims nothing about the name", () => {
    const text = describeProjectName(check({ state: "could-not-check" }));
    expect(text).toContain("could not read");
    expect(text).not.toContain("orphan");
  });

  test("drift names both readings of the contradiction and claims neither", () => {
    const text = describeProjectName(
      check({
        state: "drifted",
        misnamed: [orphan("oldname-prod-db", "oldname", null), orphan("oldname-dev-db", "oldname", null)],
      }),
    );
    expect(text).toBe(
      '2 resource names this project declares lead with "oldname", and none leads with acme — pithy would provision a second set beside them; rename the project, or rename the resources',
    );
    // It counts what it found, and does not call that the whole declared set: a hand-picked name Pithy's
    // rule could never have produced is in the wiring too and was never in this number.
    expect(text).not.toContain("all 2");
    // It has not established ownership, so it says nothing about orphans and nothing about deleting.
    expect(text).not.toContain("orphan");
    expect(text).not.toContain("delete");
  });

  test("orphans count only what the stamp proved, and the fix never says delete", () => {
    const text = describeProjectName(
      check({
        state: "orphaned",
        misnamed: [
          orphan("oldname-prod-db", "oldname", true, "oldname"),
          orphan("oldname-staging-db", "oldname", false),
        ],
      }),
    );
    expect(text).toContain('1 resource is stamped "oldname" by pithy migrate');
    expect(text).toContain("acme will never find it again");
    // The worst part of the defect this replaced: advising an adopter to delete a live production
    // database on a heuristic. The stamp proves one database's provenance, never the list's.
    expect(text).not.toContain("delete");
  });
});
