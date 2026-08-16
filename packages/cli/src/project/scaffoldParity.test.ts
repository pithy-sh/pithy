// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { VERSION_METADATA_BINDING } from "@pithy-sh/core/src/worker/identity";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { reactStub } from "../ui/react";
import { kitRange, scaffoldProject } from "./scaffold";
import { hasVersionMetadata } from "./versionMetadata";
import { scaffoldWorker, WRANGLER_RANGE } from "./workerScaffold";

/**
 * The two Worker producers, held together.
 *
 * A Pithy project's Workers come from two entirely separate code paths that share nothing.
 * `pithy init` copies `templates/starter/apps/api/wrangler.jsonc` and string-replaces three
 * placeholders; `pithy worker add` generates a file from an inline template string in
 * `workerScaffold.ts`. Nothing pinned them together, and they had already drifted — the added-Worker
 * template carries no `d1_databases`/`kv_namespaces` arrays where the starter does.
 *
 * That drift is not cosmetic. `CF_VERSION_METADATA` is the exact failure it produces: a reader shipped in
 * `createBackend`, was documented, was tested — and no template declared the binding, so a scaffolded
 * project's log records silently carried no `version` field at all. Two producers, one of them updated.
 *
 * So this file asserts the invariants that must hold in **both**, rather than in whichever one a change
 * happened to touch. It deliberately does not demand the files be identical: they legitimately differ.
 *
 * `wrangler.jsonc` was the only file it covered, which is exactly why `package.json` drifted next — two
 * stale pins, a missing `engines`, and two missing deploy scripts, in the producer nobody re-read. Both
 * files are covered now, each against the right side of the starter: `wrangler.jsonc` against the
 * template on disk, which `pithy init` only string-replaces, and `package.json` against a **scaffolded**
 * project, because `pithy init` stamps that one and the template's pre-stamp text is not what an adopter
 * ever holds.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTER_WRANGLER = resolve(HERE, "../../../../templates/starter/apps/api/wrangler.jsonc");

/** A worker's `package.json`, in the shape both producers write. */
interface WorkerPackage {
  name?: string;
  private?: boolean;
  type?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe("both wrangler.jsonc producers", () => {
  let dir: string;
  let added: Record<string, unknown>;
  let starter: Record<string, unknown>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-scaffold-parity-"));
    const { dir: workerDir } = await scaffoldWorker({ projectDir: dir, name: "web", project: "acme" });
    added = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as Record<string, unknown>;
    starter = parse(await readFile(STARTER_WRANGLER, "utf8")) as unknown as Record<string, unknown>;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("declare the version-metadata binding under the name the runtime reads", () => {
    // The regression this file exists for. `hasVersionMetadata` keys on the binding *name*, so a block
    // naming anything else fails here exactly as an absent one does — it would bind a value nothing
    // consumes.
    expect(hasVersionMetadata(starter)).toBe(true);
    expect(hasVersionMetadata(added)).toBe(true);
    expect(VERSION_METADATA_BINDING).toBe("CF_VERSION_METADATA");
  });

  test("declare it at the top level, so every environment inherits one copy", () => {
    // `env.<name>` stanzas REPLACE rather than merge. A per-environment copy would be three places for
    // one build fact to drift in, and Cloudflare inherits the top-level declaration anyway.
    for (const config of [starter, added]) {
      const envs = (config.env ?? {}) as Record<string, Record<string, unknown>>;
      expect(Object.keys(envs).length).toBeGreaterThan(0);
      for (const stanza of Object.values(envs)) expect(stanza.version_metadata).toBeUndefined();
    }
  });

  test("stamp the same three identity vars into every environment stanza", () => {
    // The other thing a Worker cannot derive about itself, and the other thing one producer could
    // quietly stop emitting. `env.<name>.vars` replaces the top-level block, so every stanza repeats all
    // three or the ones it omits are simply absent in that environment.
    const stanzas = (config: Record<string, unknown>) => [
      config,
      ...Object.values((config.env ?? {}) as Record<string, Record<string, unknown>>),
    ];

    for (const config of [starter, added]) {
      for (const stanza of stanzas(config)) {
        const vars = stanza.vars as Record<string, string> | undefined;
        expect(Object.keys(vars ?? {}).sort()).toEqual(["ENVIRONMENT", "PROJECT", "WORKER"]);
      }
    }
  });

  test("declare the same environments, so a capability lands everywhere in both", () => {
    expect(Object.keys((added.env ?? {}) as object).sort()).toEqual(Object.keys((starter.env ?? {}) as object).sort());
  });
});

describe("both package.json producers", () => {
  let dir: string;
  let added: WorkerPackage;
  let starter: WorkerPackage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-package-parity-"));
    // Project name and worker name deliberately different. `<project>-<worker>` and `<worker>` look
    // alike whenever they are not, and every check below that reads a name would pass on a coincidence.
    const project = join(dir, "replay");
    await scaffoldProject({ targetDir: project, appName: "replay", worker: "board" });
    starter = JSON.parse(await readFile(join(project, "apps", "board", "package.json"), "utf8")) as WorkerPackage;

    const { dir: workerDir } = await scaffoldWorker({ projectDir: project, name: "web", project: "replay" });
    added = JSON.parse(await readFile(join(workerDir, "package.json"), "utf8")) as WorkerPackage;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("declare the same kit range — one that resolves, or none at all", () => {
    // The regression this block exists for. `pithy init` stopped writing `"@pithy-sh/core": "^0.0.0"`;
    // `pithy worker add` went on writing it, and every worker after the first 404'd on install.
    // Asserted from `kitRange` rather than from today's value, so the release commit needs no edit here.
    const range = kitRange(PACKAGE_VERSION);
    for (const pkg of [starter, added]) {
      expect(pkg.dependencies?.[PACKAGE_NAME]).toBe(range ?? undefined);
      expect(pkg.dependencies?.hono).toBe("^4.13.2");
    }
  });

  test("declare the same dependency names, so a package added to one is added to both", () => {
    // Named keys were all this compared, which left the set itself unwatched: a dependency added to the
    // starter template and not to `workerScaffold.ts` drifted silently — the exact drift this file was
    // written to catch, in the half nobody thought to name. `stampWorkerManifest` drops `@pithy-sh/core`
    // from the starter while the scope is unpublished and `workerScaffold` omits it, so the sets agree on
    // both sides of publication; a *second* kit dependency would not, and would fail here.
    for (const field of ["dependencies", "devDependencies"] as const) {
      expect(Object.keys(added[field] ?? {}).sort(), field).toEqual(Object.keys(starter[field] ?? {}).sort());
    }
  });

  test("pin the same toolchain — a drifted wrangler is a Worker built by a different compiler", () => {
    // Every key, not a named few, now that the sets above are held equal. A pin is the one field where
    // "close enough" deploys and then fails somewhere else.
    for (const field of ["dependencies", "devDependencies"] as const) {
      for (const key of Object.keys(starter[field] ?? {})) {
        expect(added[field]?.[key], `${field}.${key}`).toBe(starter[field]?.[key]);
      }
    }
  });

  test("the ui stub pins the same wrangler — three producers of one pin, not two", () => {
    // `pithy ui add` writes `wrangler` into the Worker's package.json too, and held between only the two
    // Worker producers it could drift from both unnoticed. It is imported from `workerScaffold` rather
    // than restated; this is what holds that constant to the template on disk.
    expect(reactStub.devDependencies.wrangler).toBe(starter.devDependencies?.wrangler);
    expect(reactStub.devDependencies.wrangler).toBe(WRANGLER_RANGE);
  });

  test("declare the same Node floor, so `npm install` refuses the same runtimes", () => {
    expect(added.engines).toEqual(starter.engines);
    expect(added.engines?.node).toBeDefined();
  });

  test("declare the same scripts, so every worker deploys to staging and prod the same way", () => {
    // `pithy deploy --env prod` is the supported path, but a worker whose package.json is missing
    // `deploy:prod` is a worker whose adopter reaches for wrangler by hand and guesses the flag.
    expect(Object.keys(added.scripts ?? {}).sort()).toEqual(Object.keys(starter.scripts ?? {}).sort());
    for (const [name, command] of Object.entries(starter.scripts ?? {})) {
      expect(added.scripts?.[name], name).toBe(command);
    }
  });

  test("name the package `<project>-<worker>` in both, never the bare worker", () => {
    // A workspace holding two projects would otherwise hold two packages called `board`.
    expect(starter.name).toBe("replay-board");
    expect(added.name).toBe("replay-web");
    expect(added.private).toBe(true);
    expect(added.type).toBe("module");
  });
});

/**
 * Both producers of a Worker's own `pithy.config.ts`, held to the same rule.
 *
 * `pithy worker add` generates the file and interpolates the name into all three places it appears.
 * `pithy init` copies `templates/starter/apps/api/pithy.config.ts` and, until #169, stamped none of them
 * — so a project scaffolded with any worker but the default carried a header pointing at a directory it
 * does not have, a comment telling the adopter to run a command against a worker that does not exist,
 * and the template's flat `"app"` where the other producer derives a namespace.
 *
 * The names here are deliberately kebab-case and unlike each other, because that is what separates the
 * three stamps: `admin-api` becomes `adminapi` as a namespace and stays `admin-api` as a path. A fixture
 * using a single-word default would pass with every stamp missing.
 */
describe("both pithy.config.ts producers", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-config-parity-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("name the worker they actually made, in the path, the command, and the namespace", async () => {
    await scaffoldProject({ targetDir: dir, appName: "replay", worker: "admin-api" });
    await scaffoldWorker({ projectDir: dir, name: "edge-web", project: "replay" });

    const scaffolded = await readFile(join(dir, "apps", "admin-api", "pithy.config.ts"), "utf8");
    const added = await readFile(join(dir, "apps", "edge-web", "pithy.config.ts"), "utf8");

    for (const [source, worker, namespace] of [
      [scaffolded, "admin-api", "adminapi"],
      [added, "edge-web", "edgeweb"],
    ] as const) {
      expect(source).toContain(`apps/${worker}/pithy.config.ts`);
      expect(source).toContain(`--worker ${worker}`);
      expect(source).toContain(`name: "${namespace}"`);
      // The template's own name must not survive into either. `api` appears legitimately inside
      // `admin-api`, so this asks about the three stamped forms rather than the bare word.
      expect(source).not.toContain("apps/api/pithy.config.ts");
      expect(source).not.toContain("--worker api");
      expect(source).not.toContain('name: "app"');
    }
  });
});
