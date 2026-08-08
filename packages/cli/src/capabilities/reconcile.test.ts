// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import {
  CapabilityManifest,
  CONFIG_LINE_WIDTH,
  CONFIG_OPTION_INDENT,
  ConfigOption,
  renderCapabilityImport,
  renderCapabilityRegistration,
  renderConfigOptionComment,
  renderConfigOptionLine,
} from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { scaffoldProject } from "../project/scaffold";
import { addCapability } from "./add";
import { capabilityImportSpecifier } from "./configImports";
import { applyReconcilePlan, buildReconcilePlan, type ReconcilePlan, type RunMigrate } from "./reconcile";

/**
 * The Worker's composed set, as its `pithy.config.ts` supplies it — the scope of every plan. A capability
 * installed at the project root but absent from this list belongs to another Worker.
 */
function composes(...names: string[]): Capability[] {
  return names.map((name) => ({ name, requiredBindings: [] }));
}

/** The composed set for the tests whose Worker composes auth (the common case). */
const AUTH = composes("auth");

/** Write a capability manifest into the *project's* node_modules — where every Worker's manifests resolve from. */
async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  const pkgDir = join(dir, "node_modules", "@pithy-sh", manifest.name as string);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(manifest));
}

let dir: string;
/** The scaffolded Worker's directory — `apps/api`, holding its own pithy.config.ts and wrangler.jsonc. */
let workerDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-reconcile-"));
  // scaffoldProject gives a real apps/api with a wrangler.jsonc (dev top-level + env.staging + env.prod)
  // and a pithy.config.ts carrying the managed-region marker — the surfaces reconcile reads.
  await scaffoldProject({ targetDir: dir, appName: "reconcile-test" });
  workerDir = join(dir, "apps", "api");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Copy `apps/api` to a second Worker, so a test can prove a plan reads only its own Worker's files. */
async function addWorker(name: string): Promise<string> {
  const target = join(dir, "apps", name);
  await cp(workerDir, target, { recursive: true });
  return target;
}

/** A minimal registered-capability config; the engine reads it as text (never executes it in tests). */
function configWith(body: string): string {
  return [
    "const config = {",
    "  capabilities: [",
    body,
    "    // pithy:capabilities",
    "  ],",
    "};",
    "export default config;",
    "",
  ].join("\n");
}

const authManifest = {
  name: "auth",
  package: "@pithy-sh/auth",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "kv", name: "SESSIONS" },
  ],
  configOptions: [
    { key: "basePath", default: "/auth", describe: "Where the auth routes mount." },
    { key: "sessionDays", default: 30, describe: "Refresh-token lifetime in days." },
  ],
};

describe("buildReconcilePlan — bindings", () => {
  test("reports a required binding missing from every environment", async () => {
    await writeManifest(dir, authManifest);
    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });

    const auth = plan.perCapability.find((cap) => cap.name === "auth");
    expect(auth).toBeDefined();
    // starter wrangler has empty binding arrays in dev + staging + production → 2 bindings × 3 envs.
    expect(auth?.missingBindings).toHaveLength(6);
    for (const env of ["dev", "staging", "prod"]) {
      expect(auth?.missingBindings).toContainEqual({ env, name: "DB", type: "d1" });
      expect(auth?.missingBindings).toContainEqual({ env, name: "SESSIONS", type: "kv" });
    }
  });

  test("reports a binding only in the environments that lack it", async () => {
    await writeManifest(dir, {
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [{ type: "d1", name: "DB" }],
    });
    // Add DB to the top-level (dev) stanza only.
    const raw = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      raw.replace('"d1_databases": [],', '"d1_databases": [{ "binding": "DB" }],'),
    );

    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    const auth = plan.perCapability.find((cap) => cap.name === "auth");
    expect(auth?.missingBindings).toEqual([
      { env: "staging", name: "DB", type: "d1" },
      { env: "prod", name: "DB", type: "d1" },
    ]);
  });

  test("skips binding kinds with no wrangler-array wiring", async () => {
    await writeManifest(dir, {
      name: "email",
      package: "@pithy-sh/email",
      requiredBindings: [
        { type: "email", name: "SEND_EMAIL" },
        { type: "d1", name: "DB" },
      ],
    });
    const plan = await buildReconcilePlan({
      projectDir: dir,
      workerDir,
      env: "dev",
      capabilities: composes("email"),
    });
    const email = plan.perCapability.find((cap) => cap.name === "email");
    // The email binding is skipped; only the d1 binding is reported.
    expect(email?.missingBindings.every((binding) => binding.type === "d1")).toBe(true);
    expect(email?.missingBindings.some((binding) => binding.type === "email")).toBe(false);
  });
});

describe("buildReconcilePlan — per Worker", () => {
  test("names the Worker by its directory, and reports the deployed name separately", async () => {
    await writeManifest(dir, authManifest);
    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    // No config to read, so both fall back to the directory.
    expect(plan).toMatchObject({ worker: "api", deployedAs: "api" });

    // The case that matters: the two disagree. `worker` stays the directory — the value `--worker`
    // accepts and every path is relative to — while the deployed name goes to its own field. This test
    // asserted the opposite before pithy-sh/pithy#144, against its own title.
    const named = await buildReconcilePlan({
      projectDir: dir,
      workerDir,
      worker: "reconcile-test-api",
      env: "dev",
      capabilities: AUTH,
    });
    expect(named).toMatchObject({ worker: "api", deployedAs: "reconcile-test-api" });
  });

  test("reads only its own Worker's wiring — drift in one Worker does not appear in the other", async () => {
    await writeManifest(dir, {
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [{ type: "d1", name: "DB" }],
    });
    const collabDir = await addWorker("collab");
    // Wire DB into api's every stanza; collab stays untouched. Both Workers compose auth here, so collab's
    // empty arrays are real drift — the point is that api's fix does not mask it, nor collab's leak into api.
    const raw = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      raw.replaceAll('"d1_databases": [],', '"d1_databases": [{ "binding": "DB" }],'),
    );

    const api = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    const collab = await buildReconcilePlan({ projectDir: dir, workerDir: collabDir, env: "dev", capabilities: AUTH });

    expect(api.perCapability.find((cap) => cap.name === "auth")?.missingBindings).toEqual([]);
    expect(collab.perCapability.find((cap) => cap.name === "auth")?.missingBindings).toHaveLength(3);
    expect(collab.worker).toBe("collab");
  });

  test("a capability installed at the root but composed by another Worker contributes nothing (regression)", async () => {
    // `pithy add auth --worker api` installs the package ONCE at the project root and wires only apps/api.
    // apps/collab composes nothing, so its plan must be empty — reporting auth's bindings here would make
    // `pithy upgrade` write another Worker's wiring into a script that never declared it.
    await writeManifest(dir, authManifest);
    const collabDir = await addWorker("collab");

    const api = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    const collab = await buildReconcilePlan({
      projectDir: dir,
      workerDir: collabDir,
      env: "dev",
      capabilities: composes(),
    });

    expect(api.perCapability.map((cap) => cap.name)).toEqual(["auth"]);
    expect(collab.perCapability).toEqual([]);
  });

  test("scopes a Durable Object capability too — an uncomposed DO class never reaches another Worker's plan", async () => {
    // The sharpest form: a DO class registered against a script that does not export it fails `wrangler deploy`.
    await writeManifest(dir, {
      name: "multiplayer",
      package: "@pithy-sh/multiplayer",
      requiredBindings: [{ type: "durable_object", name: "SESSIONS", className: "MultiplayerSession" }],
    });
    const webDir = await addWorker("web");
    const before = await readFile(join(webDir, "wrangler.jsonc"), "utf8");

    const plan = await buildReconcilePlan({
      projectDir: dir,
      workerDir: webDir,
      env: "dev",
      capabilities: composes(),
    });
    expect(plan.perCapability).toEqual([]);

    // And applying that plan writes nothing — no binding, no `migrations` tag.
    await applyReconcilePlan({
      projectDir: dir,
      workerDir: webDir,
      plan,
      migrate: false,
      env: "dev",
      capabilities: composes(),
    });
    expect(await readFile(join(webDir, "wrangler.jsonc"), "utf8")).toBe(before);
  });

  test("passes both directories to the migration count — manifests from the root, wiring from the Worker", async () => {
    await writeManifest(dir, authManifest);
    const seen: { projectDir: string; workerDir: string; env: string }[] = [];
    await buildReconcilePlan({
      projectDir: dir,
      workerDir,
      env: "staging",
      capabilities: AUTH,
      countPending: async ({ projectDir, workerDir: wd, env }) => {
        seen.push({ projectDir, workerDir: wd, env });
        return 0;
      },
    });
    expect(seen).toEqual([{ projectDir: dir, workerDir, env: "staging" }]);
  });

  test("a Worker with no wrangler.jsonc reports no binding drift rather than failing", async () => {
    await writeManifest(dir, authManifest);
    await rm(join(workerDir, "wrangler.jsonc"));
    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    expect(plan.perCapability.find((cap) => cap.name === "auth")?.missingBindings).toEqual([]);
  });
});

describe("buildReconcilePlan — ejected", () => {
  test("skips an ejected capability and reports it by name", async () => {
    await writeManifest(dir, authManifest);
    await writeManifest(dir, { name: "billing", package: "@pithy-sh/billing", requiredBindings: [] });
    // The local ./capabilities import is the ejected signal; read as text, never executed.
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      `import { billing } from "./capabilities/billing";\n${configWith("    auth(),")}`,
    );

    const plan = await buildReconcilePlan({
      projectDir: dir,
      workerDir,
      env: "dev",
      capabilities: composes("auth", "billing"),
    });
    expect(plan.ejectedSkipped).toEqual(["billing"]);
    expect(plan.perCapability.map((cap) => cap.name)).toEqual(["auth"]);
  });

  test("reads the ejected signal from the Worker's config, not the project root's", async () => {
    await writeManifest(dir, { name: "billing", package: "@pithy-sh/billing", requiredBindings: [] });
    // A root config naming an ejected capability must not leak into a Worker's plan.
    await writeFile(
      join(dir, "pithy.config.ts"),
      `import { billing } from "./capabilities/billing";\nexport default { name: "reconcile-test" };\n`,
    );
    const plan = await buildReconcilePlan({
      projectDir: dir,
      workerDir,
      env: "dev",
      capabilities: composes("billing"),
    });
    expect(plan.ejectedSkipped).toEqual([]);
    expect(plan.perCapability.map((cap) => cap.name)).toEqual(["billing"]);
  });
});

describe("buildReconcilePlan — config keys", () => {
  test("reports all options for a one-liner registration", async () => {
    await writeManifest(dir, authManifest);
    await writeFile(join(workerDir, "pithy.config.ts"), configWith("    auth(),"));

    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    const auth = plan.perCapability.find((cap) => cap.name === "auth");
    expect(auth?.missingConfigKeys.map((key) => key.key)).toEqual(["basePath", "sessionDays"]);
    expect(auth?.missingConfigKeys[0]).toEqual({
      key: "basePath",
      default: "/auth",
      describe: "Where the auth routes mount.",
    });
  });

  test("reports and writes an option the adopter fills in by hand, as the empty literal", async () => {
    // The other half of #161. `pithy add secrets` now scaffolds the required `registry`, but a project
    // that composed secrets before it did has a registration missing the key — and `pithy upgrade` is
    // what closes that gap. Its own copy of the option's value type was the scalar union, so a manifest
    // stating `{}` failed to parse and the one key an existing project needed was the one it could not
    // report. Written empty, for the reason `add` writes it empty: the contents are the adopter's.
    await writeManifest(dir, {
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      configOptions: [{ key: "registry", default: {}, describe: "Your secrets. Declare each one here." }],
    });
    await writeFile(join(workerDir, "pithy.config.ts"), configWith("    auth(),"));

    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    const auth = plan.perCapability.find((cap) => cap.name === "auth");
    expect(auth?.missingConfigKeys).toEqual([
      { key: "registry", default: {}, describe: "Your secrets. Declare each one here." },
    ]);

    await applyReconcilePlan({ projectDir: dir, workerDir, plan, migrate: false, env: "dev", capabilities: [] });
    expect(await readFile(join(workerDir, "pithy.config.ts"), "utf8")).toContain("registry: {},");
  });

  test("never reports a key already present, even with an adopter-changed value", async () => {
    await writeManifest(dir, authManifest);
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      configWith('    auth({\n      // Where the auth routes mount.\n      basePath: "/custom",\n    }),'),
    );

    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    const auth = plan.perCapability.find((cap) => cap.name === "auth");
    expect(auth?.missingConfigKeys.map((key) => key.key)).toEqual(["sessionDays"]);
  });
});

describe("buildReconcilePlan — migrations and purity", () => {
  test("surfaces the pending-migration count for the env", async () => {
    await writeManifest(dir, authManifest);
    const plan = await buildReconcilePlan({
      projectDir: dir,
      workerDir,
      env: "staging",
      capabilities: AUTH,
      countPending: async ({ env }) => (env === "staging" ? 4 : 0),
    });
    expect(plan.env).toBe("staging");
    expect(plan.pendingMigrations).toBe(4);
  });

  test("reports the entitlement gap for a Worker whose routes gate with no provider composed", async () => {
    await writeManifest(dir, authManifest);
    await mkdir(join(workerDir, "src"), { recursive: true });
    await writeFile(
      join(workerDir, "src", "reports.ts"),
      'app.get("/reports", requireEntitlement("pro"), (c) => c.json({}));\n',
      "utf8",
    );
    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    expect(plan.entitlementGap).toEqual(["src/reports.ts"]);
  });

  test("a composed provider closes the gap, whatever the routes gate on", async () => {
    await writeManifest(dir, authManifest);
    await mkdir(join(workerDir, "src"), { recursive: true });
    await writeFile(join(workerDir, "src", "reports.ts"), 'requireEntitlement("pro");\n', "utf8");
    const plan = await buildReconcilePlan({
      projectDir: dir,
      workerDir,
      env: "dev",
      capabilities: [...AUTH, { name: "payments", requiredBindings: [], providesEntitlements: true }],
    });
    expect(plan.entitlementGap).toEqual([]);
  });

  test("writes nothing — building a plan is read-only", async () => {
    await writeManifest(dir, authManifest);
    await writeFile(join(workerDir, "pithy.config.ts"), configWith("    auth(),"));
    const configBefore = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
    const wranglerBefore = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");

    await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });

    expect(await readFile(join(workerDir, "pithy.config.ts"), "utf8")).toBe(configBefore);
    expect(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")).toBe(wranglerBefore);
  });
});

interface WranglerBindings {
  d1_databases?: { binding: string }[];
  kv_namespaces?: { binding: string }[];
  env?: Record<string, { d1_databases?: { binding: string }[]; kv_namespaces?: { binding: string }[] } | undefined>;
}

/** A plan for `apps/api`, scoped to the capabilities that Worker composes (defaulting to auth). */
async function planFor(env: string, ...names: string[]): Promise<ReconcilePlan> {
  return buildReconcilePlan({
    projectDir: dir,
    workerDir,
    env,
    capabilities: composes(...(names.length > 0 ? names : ["auth"])),
  });
}

describe("applyReconcilePlan — bindings", () => {
  test("adds the missing bindings to every environment", async () => {
    await writeManifest(dir, authManifest);
    const plan = await planFor("dev");
    const applied = await applyReconcilePlan({
      projectDir: dir,
      workerDir,
      plan,
      migrate: false,
      env: "dev",
      capabilities: [],
    });

    const wrangler = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as WranglerBindings;
    for (const stanza of [wrangler, wrangler.env?.staging, wrangler.env?.prod]) {
      expect(stanza?.d1_databases).toContainEqual({ binding: "DB" });
      expect(stanza?.kv_namespaces).toContainEqual({ binding: "SESSIONS" });
    }
    expect(applied.worker).toBe("api");
    expect(applied.perCapability.find((cap) => cap.name === "auth")?.addedBindings).toHaveLength(6);
  });

  test("writes only its own Worker's wrangler.jsonc", async () => {
    await writeManifest(dir, authManifest);
    const collabDir = await addWorker("collab");
    const collabBefore = await readFile(join(collabDir, "wrangler.jsonc"), "utf8");

    await applyReconcilePlan({
      projectDir: dir,
      workerDir,
      plan: await planFor("dev"),
      migrate: false,
      env: "dev",
      capabilities: [],
    });

    expect(await readFile(join(collabDir, "wrangler.jsonc"), "utf8")).toBe(collabBefore);
    expect(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")).not.toBe(collabBefore);
  });

  test("wires a durable_object binding per env and the class migration tag top-level", async () => {
    await writeManifest(dir, {
      name: "multiplayer",
      package: "@pithy-sh/multiplayer",
      requiredBindings: [{ type: "durable_object", name: "ROOMS", className: "MultiplayerSession" }],
    });
    const plan = await planFor("dev", "multiplayer");
    await applyReconcilePlan({ projectDir: dir, workerDir, plan, migrate: false, env: "dev", capabilities: [] });

    interface DoWrangler {
      durable_objects?: { bindings: { name: string; class_name: string }[] };
      migrations?: { tag: string; new_sqlite_classes?: string[] }[];
      env?: Record<string, { durable_objects?: { bindings: unknown[] }; migrations?: unknown }>;
    }
    const wrangler = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as DoWrangler;
    expect(wrangler.durable_objects?.bindings).toContainEqual({ name: "ROOMS", class_name: "MultiplayerSession" });
    expect(wrangler.env?.staging?.durable_objects?.bindings).toContainEqual({
      name: "ROOMS",
      class_name: "MultiplayerSession",
    });
    expect(wrangler.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["MultiplayerSession"] }]);
    expect(wrangler.env?.staging?.migrations).toBeUndefined();
  });
});

describe("applyReconcilePlan — proposed resource names", () => {
  /** The stanza shape these read back. */
  interface NamedWrangler {
    d1_databases?: { binding: string; database_name?: string }[];
    kv_namespaces?: { binding: string }[];
    env?: Record<string, NamedWrangler | undefined>;
  }
  const read = async (): Promise<NamedWrangler> =>
    parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as NamedWrangler;

  test("proposes the same <project>-<env>-<binding> database name `pithy add` would", async () => {
    await writeManifest(dir, authManifest);
    await applyReconcilePlan({
      projectDir: dir,
      workerDir,
      plan: await planFor("dev"),
      migrate: false,
      env: "dev",
      project: "acme",
      capabilities: [],
    });

    const wrangler = await read();
    expect(wrangler.d1_databases).toContainEqual({ binding: "DB", database_name: "acme-dev-db" });
    expect(wrangler.env?.staging?.d1_databases).toContainEqual({ binding: "DB", database_name: "acme-staging-db" });
    expect(wrangler.env?.prod?.d1_databases).toContainEqual({
      binding: "DB",
      database_name: "acme-prod-db",
    });
    // KV has no name field, so upgrade writes the binding and nothing else — same as `pithy add`.
    expect(wrangler.kv_namespaces).toContainEqual({ binding: "SESSIONS" });
  });

  test("no project name proposes nothing — the entries carry only their binding", async () => {
    await writeManifest(dir, authManifest);
    await applyReconcilePlan({
      projectDir: dir,
      workerDir,
      plan: await planFor("dev"),
      migrate: false,
      env: "dev",
      capabilities: [],
    });
    expect((await read()).d1_databases).toContainEqual({ binding: "DB" });
  });

  test("a renamed database is not read as a missing binding, so no duplicate entry is appended", async () => {
    await writeManifest(dir, authManifest);
    // Captured once, then re-applied after the rename — the stale plan still believes DB is missing.
    const stale = await planFor("dev");
    const apply = () =>
      applyReconcilePlan({
        projectDir: dir,
        workerDir,
        plan: stale,
        migrate: false,
        env: "dev",
        project: "acme",
        capabilities: [],
      });
    await apply();

    const wrangler = await read();
    const [entry] = wrangler.d1_databases ?? [];
    if (entry) entry.database_name = "the-one-we-already-had";
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify(wrangler, null, 2));

    // A stale plan re-applied: the binding is present under another name, so nothing is appended.
    await apply();
    expect((await read()).d1_databases).toEqual([{ binding: "DB", database_name: "the-one-we-already-had" }]);
  });
});

describe("applyReconcilePlan — config keys", () => {
  test("converts a one-liner registration to block form with the missing keys", async () => {
    await writeManifest(dir, authManifest);
    await writeFile(join(workerDir, "pithy.config.ts"), configWith("    auth(),"));

    const plan = await planFor("dev");
    const applied = await applyReconcilePlan({
      projectDir: dir,
      workerDir,
      plan,
      migrate: false,
      env: "dev",
      capabilities: [],
    });

    const config = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
    expect(config).toContain("auth({");
    expect(config).toContain("// Where the auth routes mount.");
    expect(config).toContain('basePath: "/auth",');
    expect(config).toContain("// Refresh-token lifetime in days.");
    expect(config).toContain("sessionDays: 30,");
    expect(config).toContain("}),");
    expect(applied.perCapability.find((cap) => cap.name === "auth")?.addedConfigKeys).toEqual([
      "basePath",
      "sessionDays",
    ]);
  });

  test("inserts into an existing block without rewriting an adopter-changed value", async () => {
    await writeManifest(dir, authManifest);
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      configWith('    auth({\n      // Where the auth routes mount.\n      basePath: "/custom",\n    }),'),
    );

    const plan = await planFor("dev");
    await applyReconcilePlan({ projectDir: dir, workerDir, plan, migrate: false, env: "dev", capabilities: [] });

    const config = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
    expect(config).toContain('basePath: "/custom",'); // untouched
    expect(config).not.toContain('basePath: "/auth",'); // default not re-added
    expect(config).toContain("sessionDays: 30,"); // the missing key inserted
    // basePath appears exactly once — no duplicate key.
    expect(config.match(/basePath:/g)).toHaveLength(1);
  });

  test("does not add a key twice — a stale-plan re-apply is a no-op", async () => {
    await writeManifest(dir, authManifest);
    await writeFile(join(workerDir, "pithy.config.ts"), configWith("    auth(),"));

    const plan = await planFor("dev");
    await applyReconcilePlan({ projectDir: dir, workerDir, plan, migrate: false, env: "dev", capabilities: [] });
    const once = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
    // Re-applying the same (now stale) plan must change nothing.
    await applyReconcilePlan({ projectDir: dir, workerDir, plan, migrate: false, env: "dev", capabilities: [] });
    expect(await readFile(join(workerDir, "pithy.config.ts"), "utf8")).toBe(once);
    expect(once.match(/sessionDays:/g)).toHaveLength(1);
  });

  test("a fresh build after apply finds nothing left to reconcile", async () => {
    await writeManifest(dir, authManifest);
    await writeFile(join(workerDir, "pithy.config.ts"), configWith("    auth(),"));

    await applyReconcilePlan({
      projectDir: dir,
      workerDir,
      plan: await planFor("dev"),
      migrate: false,
      env: "dev",
      capabilities: [],
    });
    const second = await planFor("dev");
    const auth = second.perCapability.find((cap) => cap.name === "auth");
    expect(auth?.missingBindings).toEqual([]);
    expect(auth?.missingConfigKeys).toEqual([]);
  });
});

describe("applyReconcilePlan — migrations", () => {
  /** Record what the migration seam was handed, so the project reaching it is observable. */
  function recorder() {
    const calls: { projectDir: string; workerDir: string; project: string }[] = [];
    const runMigrate: RunMigrate = async ({ projectDir, workerDir: wd, project }) => {
      calls.push({ projectDir, workerDir: wd, project });
      return [];
    };
    return { calls, runMigrate };
  }

  test("runs migrations only when migrate is true, against the Worker's directory, as the project", async () => {
    await writeManifest(dir, authManifest);
    const plan = await planFor("dev");
    const { calls, runMigrate } = recorder();

    const notMigrated = await applyReconcilePlan({
      projectDir: dir,
      workerDir,
      plan,
      migrate: false,
      env: "dev",
      project: "acme",
      capabilities: [],
      runMigrate,
    });
    expect(calls).toHaveLength(0);
    expect(notMigrated.migrated).toBe(false);

    const migrated = await applyReconcilePlan({
      projectDir: dir,
      workerDir,
      plan,
      migrate: true,
      env: "dev",
      project: "acme",
      capabilities: [],
      runMigrate,
    });
    // The project reaches the run: `upgrade --migrate` claims each database it touches, exactly as
    // `pithy migrate` does. It used to be held on the options and dropped at this call.
    expect(calls).toEqual([{ projectDir: dir, workerDir, project: "acme" }]);
    expect(migrated.migrated).toBe(true);
  });

  test("--migrate on a nameless project is refused, and nothing is written", async () => {
    await writeManifest(dir, authManifest);
    const plan = await planFor("dev");
    const { calls, runMigrate } = recorder();
    const before = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");

    // Reconciling wiring without a project name is fine — the entries just carry their binding. Writing
    // to a database is not: an unstamped database is one any other project can later claim.
    await expect(
      applyReconcilePlan({ projectDir: dir, workerDir, plan, migrate: true, env: "dev", capabilities: [], runMigrate }),
    ).rejects.toThrow(/project name/i);

    expect(calls).toHaveLength(0);
    // Refused before the reconcile wrote anything, not halfway through it.
    expect(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")).toBe(before);
  });
});

describe("applyReconcilePlan — config-key insertion edge cases (regression)", () => {
  const debugManifest = {
    name: "auth",
    package: "@pithy-sh/auth",
    requiredBindings: [],
    configOptions: [{ key: "debug", default: false, describe: "Verbose logging." }],
  };

  test("inserts into a hand-written inline block with a separating comma (valid TS, not `true  debug`)", async () => {
    await writeManifest(dir, debugManifest);
    await writeFile(join(workerDir, "pithy.config.ts"), configWith('    auth({ basePath: "/auth" }),'));

    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    await applyReconcilePlan({ projectDir: dir, workerDir, plan, migrate: false, env: "dev", capabilities: [] });

    const src = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
    // The separating comma is present — the prior property is not run into the new key (valid TS).
    expect(src).toMatch(/basePath: "\/auth",\s+debug: false,/);
    expect(src).not.toMatch(/"\/auth"\s+debug/); // no missing-comma corruption

    // Re-apply is a no-op: the key is not duplicated.
    const plan2 = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    await applyReconcilePlan({ projectDir: dir, workerDir, plan: plan2, migrate: false, env: "dev", capabilities: [] });
    const src2 = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
    expect(src2).toBe(src);
    expect((src2.match(/debug:/g) ?? []).length).toBe(1);
  });

  test("recognizes a quoted existing key, so it is not reported missing or duplicated", async () => {
    await writeManifest(dir, debugManifest);
    await writeFile(join(workerDir, "pithy.config.ts"), configWith('    auth({\n      "debug": true,\n    }),'));

    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    const auth = plan.perCapability.find((cap) => cap.name === "auth");
    expect(auth?.missingConfigKeys).toHaveLength(0);
  });

  test("a block comment containing a brace does not miscount the registration's closing brace", async () => {
    await writeManifest(dir, debugManifest);
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      configWith('    auth({\n      /* note with a } brace and a ) paren */\n      basePath: "/x",\n    }),'),
    );

    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    const auth = plan.perCapability.find((cap) => cap.name === "auth");
    expect(auth?.missingConfigKeys.map((k) => k.key)).toEqual(["debug"]);

    await applyReconcilePlan({ projectDir: dir, workerDir, plan, migrate: false, env: "dev", capabilities: [] });
    const src = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
    expect(src).toContain('basePath: "/x"');
    expect(src).toContain("debug: false,");
    expect(src).toContain("note with a } brace"); // the comment survives intact
  });
});

/**
 * `pithy add` and `pithy upgrade` are two writers of one line, and for a while they were two renderers
 * of it. `upgrade` called `JSON.stringify` where `add` called `renderConfigValue`, so one manifest
 * produced `{"code":"chips"}` here and `{ code: "chips" }` there — and only the second survived the
 * `biome check` a scaffolded project runs on itself (#171).
 *
 * Both now render through `renderConfigOptionLine`, and this is the test that stops a third producer:
 * it does not assert a string, it asserts the two commands agree.
 */
describe("pithy add and pithy upgrade render one default one way", () => {
  const ledgerManifest = {
    name: "ledger",
    package: "@pithy-sh/ledger",
    requiredBindings: [],
    configOptions: [
      {
        key: "currencies",
        default: [{ code: "chips", name: "Chips" }],
        describe: "Every currency this app's ledger holds.",
      },
      { key: "adminScope", default: "ledger:admin", describe: "The scope a session must carry." },
    ],
  };

  /** The one line a config file carries for an option — what the two writers are compared on. */
  function optionLine(source: string, key: string): string | undefined {
    return source.split("\n").find((line) => line.trimStart().startsWith(`${key}:`));
  }

  test("the same manifest default lands as the same line from either command", async () => {
    await writeManifest(dir, ledgerManifest);

    // `pithy add` writes the whole registration into a Worker that has none.
    const addedDir = await addWorker("added");
    await addCapability({ workerDir: addedDir, manifest: CapabilityManifest.parse(ledgerManifest) });
    const added = await readFile(join(addedDir, "pithy.config.ts"), "utf8");

    // `pithy upgrade` splices the same options into a one-liner registration in the other Worker.
    await writeFile(join(workerDir, "pithy.config.ts"), configWith("    ledger(),"));
    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: composes("ledger") });
    await applyReconcilePlan({ projectDir: dir, workerDir, plan, migrate: false, env: "dev", capabilities: [] });
    const upgraded = await readFile(join(workerDir, "pithy.config.ts"), "utf8");

    for (const key of ["currencies", "adminScope"]) {
      expect(optionLine(added, key)).toBeDefined();
      expect(optionLine(upgraded, key)).toBe(optionLine(added, key));
    }
    // And the shape is Biome's, not JSON's — the thing that made the two differ in the first place.
    expect(optionLine(upgraded, "currencies")).toBe('      currencies: [{ code: "chips", name: "Chips" }],');
  });

  test("an inline block an adopter wrote by hand gets the same rendering, not JSON", async () => {
    await writeManifest(dir, ledgerManifest);
    await writeFile(join(workerDir, "pithy.config.ts"), configWith('    ledger({ adminScope: "ops:admin" }),'));

    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: composes("ledger") });
    await applyReconcilePlan({ projectDir: dir, workerDir, plan, migrate: false, env: "dev", capabilities: [] });

    const src = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
    expect(src).toContain('currencies: [{ code: "chips", name: "Chips" }],');
    expect(src).not.toContain('{"code":"chips"');
  });
});

/** `packages/` — this file lives at `packages/cli/src/capabilities/`. */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Every capability package that ships a manifest, as `[name, manifest]`. */
function shippedManifests(): [string, CapabilityManifest][] {
  const found: [string, CapabilityManifest][] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    let raw: string;
    try {
      raw = readFileSync(join(PACKAGES, pkg.name, "pithy.manifest.json"), "utf8");
    } catch {
      continue; // not a capability package (cli, test-utils, …)
    }
    found.push([pkg.name, CapabilityManifest.parse(JSON.parse(raw))]);
  }
  return found;
}

/**
 * The width rule, as a gate rather than a sentence.
 *
 * `renderConfigValue`'s contract has always said a default must fit on one line, because Biome breaks
 * any literal past its configured width and a broken literal is a `biome check` failure on a project the
 * adopter has not touched — #161 and #168 both. Nothing checked it, and the margin was thinner than it
 * looks: multiplayer's seed is 98 columns of 120, and a game with a two-move catalog reaches 133.
 *
 * So it is checked here, over every manifest the repo ships, at the indent the writers really use. A
 * sixteenth capability with a default one line too wide fails the build instead of an adopter's first
 * `bun run lint`. The manifests are read from the packages rather than from `node_modules`, so a seed
 * fails the moment it is written, not the moment it is published.
 */
describe("every shipped manifest default fits the line Biome would keep", () => {
  const manifests = shippedManifests();

  test("the repo ships manifests to check", () => {
    expect(manifests.length).toBeGreaterThan(10);
  });

  test("the budget is the scaffold's own lineWidth, not a number remembered from one", () => {
    // The gate is only honest while it tracks the biome.jsonc `pithy init` writes. Change that
    // `lineWidth` and this fails, which is the moment to change CONFIG_LINE_WIDTH with it.
    const template = readFileSync(join(PACKAGES, "..", "templates", "starter", "biome.template.jsonc"), "utf8");
    const scaffold = parse(template) as { formatter?: { lineWidth?: number } };
    expect(scaffold.formatter?.lineWidth).toBe(CONFIG_LINE_WIDTH);
  });

  for (const [pkg, manifest] of manifests) {
    for (const option of manifest.configOptions) {
      test(`${pkg}: ${option.key}`, () => {
        const line = renderConfigOptionLine(option.key, option.default, CONFIG_OPTION_INDENT);
        expect(
          line.length,
          `${pkg}'s ${option.key} default renders ${line.length} columns. Biome breaks past ${CONFIG_LINE_WIDTH}, and the exploded literal fails biome check on an untouched scaffold. Shrink the example.`,
        ).toBeLessThanOrEqual(CONFIG_LINE_WIDTH);
      });
    }
  }
});

/** Biome's own binary, from this repo's install — the only thing that can say what Biome would print. */
const BIOME = join(PACKAGES, "..", "node_modules", "@biomejs", "biome", "bin", "biome");

/** Run `biome check` on one file inside a scaffolded project, so it reads that project's own biome.jsonc. */
async function biomeCheck(cwd: string, file: string): Promise<{ code: number; output: string }> {
  return await new Promise((settle) => {
    const child = spawn(BIOME, ["check", file], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("close", (code) => settle({ code: code ?? -1, output }));
  });
}

/**
 * The whole line, checked by the only authority on it.
 *
 * The width gate above measures a number; this one asks Biome. #171 narrowed what a manifest may state as
 * a *value* so the renderer could only be handed shapes it prints the way Biome would — and left the
 * option's own `key` and its `describe` out, both interpolated raw. A key of `content-type` rendered
 * `content-type: "x",`, which is not TypeScript at all; a `describe` carrying a newline put its second
 * line into `pithy.config.ts` as bare code (#174).
 *
 * So every shipped option's two lines are rendered into a config in a real scaffold and put through that
 * scaffold's own `biome check`. The invariant is "Biome leaves it alone", and no regex can answer that.
 */
describe("every shipped manifest option renders lines Biome leaves alone", () => {
  const manifests = shippedManifests();

  test("biome check passes on a config carrying every shipped option", async () => {
    const lines: string[] = [];
    for (const [, manifest] of manifests) {
      if (manifest.configOptions.length === 0) continue;
      lines.push(`    ${manifest.name}({`);
      for (const option of manifest.configOptions) {
        lines.push(renderConfigOptionComment(option.describe, CONFIG_OPTION_INDENT));
        lines.push(renderConfigOptionLine(option.key, option.default, CONFIG_OPTION_INDENT));
      }
      lines.push("    }),");
    }
    // The shape `pithy add` writes: options at CONFIG_OPTION_INDENT, inside the managed region's array.
    const source = `const config = {\n  capabilities: [\n${lines.join("\n")}\n  ],\n};\n\nexport default config;\n`;

    // Not vacuous: every option the repo ships is in the file Biome was handed.
    const options = manifests.flatMap(([, manifest]) => manifest.configOptions);
    expect(options.length).toBeGreaterThan(30);
    for (const option of options) expect(source).toContain(`${option.key}:`);

    const path = join(dir, "renderedOptions.ts");
    await writeFile(path, source);
    const { code, output } = await biomeCheck(dir, path);
    expect(code, `biome check rejected the rendered options:\n${output}\n\nSource:\n${source}`).toBe(0);
  });

  test("the gate bites — biome check rejects the line the old renderer would have written", async () => {
    // The control for the test above. `content-type` is what a manifest could state before #174, and
    // what the renderer emitted verbatim; if `biome check` passed on this, the assertion above would
    // mean nothing. Written by hand because neither the schema nor the renderer will produce it now.
    const source = `const config = {\n  capabilities: [\n    cap({\n      // A rationale.\n      content-type: "x",\n    }),\n  ],\n};\n\nexport default config;\n`;
    const path = join(dir, "hostile.ts");
    await writeFile(path, source);
    const { code } = await biomeCheck(dir, path);
    expect(code).not.toBe(0);
  });
});

/**
 * The door #171 left ajar.
 *
 * A manifest is third-party data — read from `node_modules/@pithy-sh/<cap>/pithy.manifest.json` — and its
 * option keys and rationales go straight into generated TypeScript. `renderConfigValue` guarded the keys
 * of a *nested* object and not the option's own, so the one field on the line that nothing checked was
 * the one an attacker would pick: `}) ; evil(` closed the call and opened another.
 *
 * The fix is #171's own argument applied to the rest of the line — narrow at the schema, so the renderer
 * cannot be handed something it cannot print — and the renderer stays total over it, because `--set` and
 * a prompt reach `renderConfigOptionLine` without passing a manifest.
 */
describe("a manifest cannot state a key or a rationale the renderer cannot print", () => {
  /** Every key from #174, each of which the schema parsed and the renderer emitted as broken source. */
  const hostileKeys = ["content-type", 'a"b', "1", "a b", "}) ; evil("];

  test("a key that is not a bare identifier is refused, and the refusal names it", () => {
    for (const key of hostileKeys) {
      const result = ConfigOption.safeParse({ key, default: "x", describe: "Why." });
      expect(result.success, `${JSON.stringify(key)} parsed as a config option key`).toBe(false);
      expect(result.error?.issues[0]?.message).toContain(JSON.stringify(key));
    }
  });

  test("a bare identifier still parses, reserved words included", () => {
    for (const key of ["basePath", "_x", "$x", "x9", "default", "class"]) {
      expect(ConfigOption.safeParse({ key, default: "x", describe: "Why." }).success).toBe(true);
    }
  });

  test("a describe that spans lines or trails whitespace is refused", () => {
    // A line terminator ends a `//` comment: everything after it lands in the file as bare code. Trailing
    // whitespace parses and then fails `biome format`. Both measured against Biome, not guessed.
    for (const describe of ["one\ntwo", "one\rtwo", "one\u2028two", "one\u2029two", "Trailing. ", "Trailing.\t"]) {
      expect(
        ConfigOption.safeParse({ key: "k", default: "x", describe }).success,
        `${JSON.stringify(describe)} parsed as a config option describe`,
      ).toBe(false);
    }
  });

  test("a rationale Biome leaves alone still parses", () => {
    for (const describe of [" leading space is fine", "a\ttab inside is fine", "café — dash.", "ends with */"]) {
      expect(ConfigOption.safeParse({ key: "k", default: "x", describe }).success).toBe(true);
    }
  });

  test("the renderers refuse what the schema refuses — `--set` reaches them without a manifest", () => {
    for (const key of hostileKeys) {
      expect(() => renderConfigOptionLine(key, "x", CONFIG_OPTION_INDENT)).toThrow(PithyError);
    }
    expect(() => renderConfigOptionComment("one\ntwo", CONFIG_OPTION_INDENT)).toThrow(PithyError);
    expect(() => renderConfigOptionComment("Trailing. ", CONFIG_OPTION_INDENT)).toThrow(PithyError);
  });

  test("what the schema admits, biome check keeps", async () => {
    const source = `const config = {\n  capabilities: [\n    cap({\n${renderConfigOptionComment(" leading space is fine", CONFIG_OPTION_INDENT)}\n${renderConfigOptionLine("basePath", "/x", CONFIG_OPTION_INDENT)}\n    }),\n  ],\n};\n\nexport default config;\n`;
    const path = join(dir, "admitted.ts");
    await writeFile(path, source);
    const { code, output } = await biomeCheck(dir, path);
    expect(code, output).toBe(0);
  });
});

/**
 * The rest of the generated file, checked by the same authority.
 *
 * The block above renders every shipped option's two lines and asks Biome about them. It covers the two
 * lines #174 gave a producer to, and nothing else — so a manifest's `name` and `package`, which reach the
 * import statement and the registration call, went through three releases with no check at all. A
 * manifest declaring `audit }) ; evil(` produced an import that did not parse and a call that opened a
 * second one, and `pithy add` said `Done.` (#183).
 *
 * So this renders the **whole** file `pithy add` would write for every capability the repo ships —
 * imports, registrations, option lines — and puts it through a real scaffold's own `biome check`.
 */
describe("every shipped manifest renders a whole config file Biome leaves alone", () => {
  const manifests = shippedManifests();

  test("biome check passes on the config pithy add would write for every shipped capability", async () => {
    const imports: string[] = [];
    const registrations: string[] = [];
    for (const [, manifest] of manifests) {
      imports.push(renderCapabilityImport(manifest.name, capabilityImportSpecifier(manifest.package)));
      const optionLines = manifest.configOptions.flatMap((option) => [
        renderConfigOptionComment(option.describe, CONFIG_OPTION_INDENT),
        renderConfigOptionLine(option.key, option.default, CONFIG_OPTION_INDENT),
      ]);
      registrations.push(renderCapabilityRegistration({ name: manifest.name, indent: "    ", optionLines }));
    }
    const source = `${imports.join("\n")}\n\nconst config = {\n  capabilities: [\n${registrations.join("\n")}\n  ],\n};\n\nexport default config;\n`;

    // Not vacuous: every capability the repo ships is imported and registered in the file Biome was handed.
    expect(manifests.length).toBeGreaterThan(10);
    for (const [, manifest] of manifests) {
      expect(source).toContain(`import { ${manifest.name} }`);
      expect(source).toContain(`${manifest.name}(`);
    }

    const path = join(dir, "renderedConfig.ts");
    await writeFile(path, source);
    const { code, output } = await biomeCheck(dir, path);
    expect(code, `biome check rejected the rendered config:\n${output}\n\nSource:\n${source}`).toBe(0);
  });

  test("the gate bites — biome check rejects the two lines the old renderer wrote", async () => {
    // #183's own reproduction, written by hand because neither the schema nor the renderer will produce
    // it now. Without this control the assertion above would prove nothing.
    const source = `import { audit }) ; evil( } from "@pithy-sh/audit/src/index";\n\nconst config = {\n  capabilities: [\n    audit }) ; evil((),\n  ],\n};\n\nexport default config;\n`;
    const path = join(dir, "hostileConfig.ts");
    await writeFile(path, source);
    const { code } = await biomeCheck(dir, path);
    expect(code).not.toBe(0);
  });
});

/**
 * The name, at the schema, where the rule belongs.
 *
 * `pithy add` reads a manifest out of `node_modules` and writes its `name` into generated TypeScript
 * twice and its `package` once. Both were `z.string().min(1)` until #183. The renderers refuse them too,
 * because `pithy upgrade` reaches the registration renderer with a name taken from a plan.
 */
describe("a manifest cannot state a name or a package the config file cannot carry", () => {
  test("the name #183 reproduced is refused by the schema", () => {
    const result = CapabilityManifest.safeParse({
      name: "audit }) ; evil(",
      package: "@pithy-sh/audit",
      requiredBindings: [],
    });
    expect(result.success).toBe(false);
  });

  test("the package #183 reproduced is refused by the schema", () => {
    const result = CapabilityManifest.safeParse({
      name: "audit",
      package: '@pithy-sh/audit/src/index"; evil(); //',
      requiredBindings: [],
    });
    expect(result.success).toBe(false);
  });

  test("the renderers refuse it too — pithy upgrade reaches them from a plan, not from a manifest", () => {
    expect(() => renderCapabilityImport("audit }) ; evil(", "@pithy-sh/audit/src/index")).toThrow(PithyError);
    expect(() => renderCapabilityRegistration({ name: "audit }) ; evil(", indent: "    " })).toThrow(PithyError);
  });

  test("pithy add refuses to wire a capability whose manifest states a name it cannot write", async () => {
    // The end-to-end shape: an installed manifest with a hostile name never reaches the config file.
    await writeManifest(dir, { name: "audit", package: "@pithy-sh/audit", requiredBindings: [] });
    await writeFile(
      join(dir, "node_modules", "@pithy-sh", "audit", "pithy.manifest.json"),
      JSON.stringify({ name: "audit }) ; evil(", package: "@pithy-sh/audit", requiredBindings: [] }),
    );

    const before = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: composes("audit") });
    await applyReconcilePlan({ projectDir: dir, workerDir, plan, migrate: false, env: "dev", capabilities: [] });
    expect(await readFile(join(workerDir, "pithy.config.ts"), "utf8")).toBe(before);
  });
});
