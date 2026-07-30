import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { scaffoldProject } from "../project/scaffold";
import { applyReconcilePlan, buildReconcilePlan, type ReconcilePlan } from "./reconcile";

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
  // scaffoldProject gives a real apps/api with a wrangler.jsonc (dev top-level + env.staging + env.production)
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
    for (const env of ["dev", "staging", "production"]) {
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
      { env: "production", name: "DB", type: "d1" },
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
  test("names the Worker it targets, defaulting to the apps/<name> basename", async () => {
    await writeManifest(dir, authManifest);
    const plan = await buildReconcilePlan({ projectDir: dir, workerDir, env: "dev", capabilities: AUTH });
    expect(plan.worker).toBe("api");

    const named = await buildReconcilePlan({
      projectDir: dir,
      workerDir,
      worker: "reconcile-test-api",
      env: "dev",
      capabilities: AUTH,
    });
    expect(named.worker).toBe("reconcile-test-api");
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
    for (const stanza of [wrangler, wrangler.env?.staging, wrangler.env?.production]) {
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
  test("runs migrations only when migrate is true, against the Worker's directory", async () => {
    await writeManifest(dir, authManifest);
    const plan = await planFor("dev");

    const calls: { projectDir: string; workerDir: string }[] = [];
    const runMigrate = async ({ projectDir, workerDir: wd }: { projectDir: string; workerDir: string }) => {
      calls.push({ projectDir, workerDir: wd });
      return [];
    };

    const notMigrated = await applyReconcilePlan({
      projectDir: dir,
      workerDir,
      plan,
      migrate: false,
      env: "dev",
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
      capabilities: [],
      runMigrate,
    });
    expect(calls).toEqual([{ projectDir: dir, workerDir }]);
    expect(migrated.migrated).toBe(true);
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
