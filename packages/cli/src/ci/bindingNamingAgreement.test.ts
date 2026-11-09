// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { GLOBAL_SCOPE } from "@pithy-sh/core/src/naming/environment";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bindingDeclarations } from "../capabilities/bindingNamings";
import { composedManifests } from "../capabilities/manifests";
import { checkDeclaredNames, type DeclaredNamesWorker } from "../doctor/declaredNames";
import { reconcileOwnedDatabases } from "../project/ownedStanzas";
import { provisionPlan } from "../provision/plan";

/**
 * **`pithy provision --dry-run`, `pithy doctor` and `pithy worker sync` name every global or `resource:` binding
 * the kit ships one way, in every declared environment.**
 *
 * The manifests are the shipped ones, read through the real reader from a project whose `node_modules/@pithy-sh`
 * links every package under `packages/`. The capability objects are built from them with `scope` and
 * `resource` taken out, because that is what the kit's capability objects declare: the manifest is the one place
 * those two fields live, and a command reading them anywhere else names the resource another way.
 */

/** `packages/` — this file lives at `packages/cli/src/ci/`. */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const PROJECT = "acme";
const ENVIRONMENTS = ["staging", "prod"] as const;
const KINDS = { d1: "d1_databases", r2: "r2_buckets" } as const;

/** One binding the kit declares `scope: "global"` or `resource:` for, and what composes it. */
interface NamedBinding {
  capability: string;
  binding: string;
  kind: keyof typeof KINDS;
  global: boolean;
}

let dir: string;
let worker: string;
let capabilities: Capability[];
let named: NamedBinding[];
let declarations: DeclaredNamesWorker["declarations"];

/** A stanza naming each binding through `nameOf`. */
function stanza(nameOf: (binding: NamedBinding) => string): Record<string, { binding: string }[]> {
  const out: Record<string, { binding: string; database_name?: string; bucket_name?: string }[]> = {};
  for (const entry of named) {
    const field = entry.kind === "d1" ? "database_name" : "bucket_name";
    out[KINDS[entry.kind]] = [...(out[KINDS[entry.kind]] ?? []), { binding: entry.binding, [field]: nameOf(entry) }];
  }
  return out;
}

async function writeStanzas(nameOf: (binding: NamedBinding, env: string) => string): Promise<string> {
  const config = JSON.stringify({
    name: `${PROJECT}-api`,
    env: Object.fromEntries(ENVIRONMENTS.map((env) => [env, stanza((binding) => nameOf(binding, env))])),
  });
  await writeFile(join(worker, "wrangler.jsonc"), config);
  return config;
}

/** What `pithy provision --env <env> --dry-run` plans for each binding. */
async function planned(env: string): Promise<Map<string, string>> {
  const plan = await provisionPlan({
    projectDir: dir,
    project: PROJECT,
    scope: environmentScope(PROJECT, env),
    capabilities,
    workers: [{ name: `${PROJECT}-api`, dir: worker, capabilities }],
  });
  return new Map(plan.resources.map((resource) => [resource.binding, resource.name]));
}

const workers = async (): Promise<DeclaredNamesWorker[]> => [
  { dir: worker, capabilities, ownBindings: [], declarations },
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-naming-agreement-"));
  const scope = join(dir, "node_modules", "@pithy-sh");
  await mkdir(scope, { recursive: true });
  for (const entry of await readdir(PACKAGES, { withFileTypes: true })) {
    if (entry.isDirectory()) await symlink(join(PACKAGES, entry.name), join(scope, entry.name), "dir");
  }
  await writeFile(
    join(dir, "pithy.config.ts"),
    `export default { name: "${PROJECT}", environments: ${JSON.stringify(ENVIRONMENTS)} };\n`,
  );
  worker = join(dir, "apps", "api");
  await mkdir(worker, { recursive: true });

  const { manifests } = await composedManifests(dir, worker);
  declarations = bindingDeclarations(manifests, undefined);
  named = [];
  capabilities = [];
  for (const manifest of manifests) {
    const specs = manifest.requiredBindings.filter(
      (spec) => (spec.type === "d1" || spec.type === "r2") && (spec.scope === GLOBAL_SCOPE || spec.resource),
    );
    if (specs.length === 0) continue;
    for (const spec of specs) {
      named.push({
        capability: manifest.name,
        binding: spec.name,
        kind: spec.type as NamedBinding["kind"],
        global: spec.scope === GLOBAL_SCOPE,
      });
    }
    capabilities.push(
      defineCapability({
        name: manifest.name,
        requiredBindings: specs.map(({ scope: _scope, resource: _resource, ...spec }) => spec),
      }),
    );
  }
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("one name per global or resource: binding, whichever command composes it", () => {
  test("finds the bindings the kit ships with a scope or a resource", () => {
    expect(named.map(({ binding, global }) => [binding, global])).toEqual(
      expect.arrayContaining([
        ["EMAIL_SUPPRESSIONS", true],
        ["SUPPORT_BUCKET", true],
        ["MEDIA_BUCKET", false],
        ["STORAGE_BUCKET", false],
      ]),
    );
  });

  test("doctor expects what provision plans, in every declared environment", async () => {
    await writeStanzas((binding, env) => `${PROJECT}-${env}-hand-picked-${binding.binding.toLowerCase()}`);
    const check = await checkDeclaredNames(dir, workers);
    for (const env of ENVIRONMENTS) {
      const plan = await planned(env);
      for (const binding of named) {
        const mismatch = check.mismatches.find((entry) => entry.env === env && entry.binding === binding.binding);
        expect(mismatch?.expected, `${env} ${binding.binding}`).toBe(plan.get(binding.binding));
        expect(mismatch?.global, `${env} ${binding.binding}`).toBe(binding.global);
      }
    }
  });

  test("doctor is quiet, and worker sync rewrites nothing, where every stanza names what provision plans", async () => {
    const plans = new Map(await Promise.all(ENVIRONMENTS.map(async (env) => [env, await planned(env)] as const)));
    const config = await writeStanzas((binding, env) => plans.get(env as never)?.get(binding.binding) ?? "");
    for (const binding of named.filter((entry) => entry.global)) {
      expect(new Set(ENVIRONMENTS.map((env) => plans.get(env)?.get(binding.binding))).size).toBe(1);
    }

    expect(await checkDeclaredNames(dir, workers)).toEqual({ state: "ok", mismatches: [], unrecognized: [] });
    const changes = await reconcileOwnedDatabases({
      workerDir: worker,
      project: PROJECT,
      capabilities,
      declarations,
      ownBindings: [],
    });
    expect(changes).toEqual([]);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(config);
  });

  test("worker sync refuses to own a global binding, naming the capability, and rewrites nothing", async () => {
    const config = await writeStanzas((binding, env) => `${PROJECT}-${env}-${binding.binding.toLowerCase()}`);
    for (const binding of named.filter((entry) => entry.global)) {
      await expect(
        reconcileOwnedDatabases({
          workerDir: worker,
          project: PROJECT,
          capabilities,
          declarations,
          ownBindings: [binding.binding],
        }),
      ).rejects.toThrow(`owns ${binding.binding}, which ${binding.capability} declares global`);
    }
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(config);
  });
});
