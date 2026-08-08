// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManifest, type ConfigOption } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import type { DatabaseRun } from "../migrations/run";
import { installPackage } from "../project/packageManager";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { coerceSetFlags, collectSetFlags, isHandWritten, runAdd } from "./flow";

const optionManifest = CapabilityManifest.parse({
  name: "auth",
  package: "@pithy-sh/auth",
  requiredBindings: [{ type: "d1", name: "DB" }],
  configOptions: [
    { key: "basePath", default: "/auth", describe: "Where the auth routes mount." },
    { key: "sessionDays", default: 30, describe: "Refresh-token lifetime in days." },
    { key: "cookies", default: true, describe: "Enable cookie sessions." },
  ],
});

/** Options a manifest can only scaffold empty — the shape `@pithy-sh/secrets` needs for its registry. */
const handWrittenManifest = CapabilityManifest.parse({
  name: "secrets",
  package: "@pithy-sh/secrets",
  requiredBindings: [],
  configOptions: [
    { key: "registry", default: {}, describe: "Your secrets. Declare each one here." },
    { key: "boards", default: [], describe: "Every board this app ranks." },
  ],
});

describe("coerceSetFlags", () => {
  test("coerces values to each option's type", () => {
    expect(coerceSetFlags(optionManifest, ["basePath=/api/auth", "sessionDays=7", "cookies=false"])).toEqual({
      basePath: "/api/auth",
      sessionDays: 7,
      cookies: false,
    });
  });

  test("an unknown key fails with the valid keys", () => {
    const error = coerceSetFlags.bind(null, optionManifest, ["nope=1"]);
    expect(error).toThrow(PithyError);
    expect(error).toThrow(/nope/);
  });

  test("a missing = fails", () => {
    expect(() => coerceSetFlags(optionManifest, ["basePath"])).toThrow(/key=value/);
  });

  test("a non-numeric number and a non-boolean boolean fail", () => {
    expect(() => coerceSetFlags(optionManifest, ["sessionDays=lots"])).toThrow(/number/);
    expect(() => coerceSetFlags(optionManifest, ["cookies=maybe"])).toThrow(/boolean/);
  });

  test("an option the adopter writes by hand is refused, not stringified", () => {
    // The secrets registry: a manifest states it as `{}` so the generated config compiles (#161), and
    // there it stops. `--set` carries a string, and the old fall-through returned the raw one — which
    // would have composed `registry: "d1"` as the registry and been accepted by nothing.
    const error = coerceSetFlags.bind(null, handWrittenManifest, ["registry=d1"]);
    expect(error).toThrow(PithyError);
    expect(error).toThrow(/not settable from the command line/);
  });
});

describe("isHandWritten", () => {
  test("is true for an option whose value is an object or an array, false for the scalars", () => {
    const byKey = new Map(handWrittenManifest.configOptions.map((option) => [option.key, option]));
    expect(isHandWritten(byKey.get("registry") as ConfigOption)).toBe(true);
    expect(isHandWritten(byKey.get("boards") as ConfigOption)).toBe(true);
    for (const option of optionManifest.configOptions) expect(isHandWritten(option)).toBe(false);
  });
});

describe("collectSetFlags", () => {
  test("collects every repeated --set, not just the last (citty keeps only the last)", () => {
    expect(collectSetFlags(["add", "auth", "--set", "basePath=/x", "--set", "sessionDays=7"])).toEqual([
      "basePath=/x",
      "sessionDays=7",
    ]);
  });

  test("handles the --set=key=value form", () => {
    expect(collectSetFlags(["--set=basePath=/x", "--set=cookies=false"])).toEqual(["basePath=/x", "cookies=false"]);
  });

  test("a trailing --set with no value is ignored", () => {
    expect(collectSetFlags(["--set"])).toEqual([]);
  });

  test("no --set flags yields an empty list", () => {
    expect(collectSetFlags(["add", "auth", "--json"])).toEqual([]);
  });
});

describe("runAdd", () => {
  let dir: string;
  /** The Worker being wired. The package installs at the project root; the wiring lands here. */
  let worker: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-flow-"));
    await scaffoldProject({ targetDir: dir, appName: "flow-test" });
    worker = join(dir, "apps", DEFAULT_WORKER);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A stub installer that drops the capability's manifest where loadManifest reads it. */
  function installManifest(manifest: unknown) {
    return async ({ projectDir, pkg }: { projectDir: string; pkg: string }) => {
      const name = pkg.replace("@pithy-sh/", "");
      const pkgDir = join(projectDir, "node_modules", "@pithy-sh", name);
      await mkdir(pkgDir, { recursive: true });
      await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(manifest));
      return { packageManager: "bun" };
    };
  }

  const noMigrations: DatabaseRun[] = [];
  const migrateStub = vi.fn(async () => noMigrations);

  test("installs, loads the manifest, wires config + bindings, then migrates", async () => {
    const install = vi.fn(installManifest(optionManifest));
    const databases: DatabaseRun[] = [{ database: "auth", binding: "DB", results: [] }];
    const migrate = vi.fn(async () => databases);

    const result = await runAdd({
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      setFlags: ["basePath=/authentication", "sessionDays=7"],
      install,
      migrate,
    });

    // Install ran for the scoped package.
    expect(install).toHaveBeenCalledWith({ projectDir: dir, pkg: "@pithy-sh/auth" });
    // Config was wired with every override before migration ran.
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { auth } from "@pithy-sh/auth/src/index";');
    expect(config).toContain('basePath: "/authentication",');
    expect(config).toContain("sessionDays: 7,");
    expect(config).toContain("cookies: true,"); // un-set option keeps its default
    // Migration ran against the project after wiring — and named it. `add` finishes by writing to a
    // database, so it claims it for this project rather than leaving it unowned for the next one.
    expect(migrate).toHaveBeenCalledWith({
      projectDir: dir,
      workerDir: worker,
      worker: DEFAULT_WORKER,
      project: "acme",
    });
    expect(result).toEqual({
      capability: "auth",
      // No `worker` was passed, so the deployed name falls back to the directory and the two agree.
      // `runAdd`'s own "names the Worker by its directory" test is where they are made to disagree.
      worker: DEFAULT_WORKER,
      deployedAs: DEFAULT_WORKER,
      package: "@pithy-sh/auth",
      packageManager: "bun",
      databases,
      // auth declares no KV binding here, so there is nothing to propose a name for.
      kvNamespaces: [],
      // Every binding auth needs is one `add` writes, so there is nothing left to say.
      notes: [],
      eject: undefined,
    });
  });

  test("names the Worker by its directory, and reports the deployed name separately", async () => {
    // A Worker deploys as `<project>-<worker>`, so these two strings are what `pithy add --worker board`
    // has in hand on a project named `acme`. They must not collapse into one field: `worker` is what
    // `--worker` accepts and what a caller can act on, `deployedAs` is what Cloudflare shows.
    const result = await runAdd({
      projectDir: dir,
      workerDir: worker,
      worker: "acme-api",
      project: "acme",
      capability: "auth",
      install: installManifest(optionManifest),
      migrate: async () => [],
    });

    expect(result).toMatchObject({ worker: DEFAULT_WORKER, deployedAs: "acme-api" });
    // Not merely different — the directory is read from `workerDir`, never derived by stripping a
    // project prefix off the deployed name. A `wrangler.jsonc` may name the Worker anything.
    expect(result.worker).not.toBe(result.deployedAs);
  });

  test("mints the secrets dev master key and reports it — `pithy dev` serves the moment add finishes", async () => {
    const secrets = CapabilityManifest.parse({
      name: "secrets",
      package: "@pithy-sh/secrets",
      requiredBindings: [
        { type: "d1", name: "SECRETS" },
        { type: "secret", name: "SECRETS_ENCRYPTION_KEYS" },
      ],
    });

    const result = await runAdd({
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "secrets",
      install: vi.fn(installManifest(secrets)),
      migrate: vi.fn(async () => noMigrations),
    });

    // The project root's `.dev.vars`, which every worker symlinks to — not the worker directory.
    const vars = await readFile(join(dir, ".dev.vars"), "utf8");
    expect(vars).toMatch(/^SECRETS_ENCRYPTION_KEYS=\{"currentVersion":"1"/m);
    expect(result.notes.join(" ")).toMatch(/pithy secrets provision/);
  });

  test("threads the project name through, so add proposes <project>-<env>-<binding>", async () => {
    const result = await runAdd({
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install: vi.fn(
        installManifest(
          CapabilityManifest.parse({
            name: "auth",
            package: "@pithy-sh/auth",
            requiredBindings: [
              { type: "d1", name: "DB" },
              { type: "kv", name: "SESSIONS" },
            ],
          }),
        ),
      ),
      // A local stub: `migrateStub` is shared, and a later test asserts it was never called.
      migrate: vi.fn(async () => noMigrations),
    });

    expect(result.kvNamespaces).toContainEqual({
      binding: "SESSIONS",
      env: "prod",
      name: "acme-prod-sessions",
    });
    const wrangler = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"database_name": "acme-dev-db"');
  });

  test("an uninstalled capability (install left no manifest) fails naming it", async () => {
    const install = vi.fn(async () => ({ packageManager: "npm" }));
    await expect(
      runAdd({
        projectDir: dir,
        workerDir: worker,
        project: "acme",
        capability: "ghost",
        install,
        migrate: migrateStub,
      }),
    ).rejects.toThrow(/ghost/);
    expect(migrateStub).not.toHaveBeenCalled();
  });

  test("a linked checkout installs nothing and still wires — the skip and the manifest read agree", async () => {
    // The real install step, not a stub: `installPackage` must decline to spawn, and `loadManifest`
    // must then find the manifest in the very directory the skip was decided from. When those two
    // disagreed, `pithy add secrets` skipped the install and answered "No capability named secrets is
    // installed. Run pithy add secrets to install it." — a dead end with no flag out of it.
    const checkout = join(dir, "checkout", "auth");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "@pithy-sh/auth" }));
    await writeFile(join(checkout, "pithy.manifest.json"), JSON.stringify(optionManifest));
    await mkdir(join(dir, "node_modules", "@pithy-sh"), { recursive: true });
    await symlink(checkout, join(dir, "node_modules", "@pithy-sh", "auth"), "dir");

    // The real `installPackage`, with only its spawner replaced. The outcome alone did not pin this:
    // with the guard reverted the tmpdir has no lockfile, so the test spawned `npm install
    // @pithy-sh/auth` against the live registry — an E404 today (a failure for the wrong reason, and no
    // failure at all offline), and a passing test the day the scope publishes. A recording runner is
    // the assertion the outcome could not make: nothing spawned.
    const spawned: string[] = [];
    const result = await runAdd({
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install: (input) =>
        installPackage({
          ...input,
          run: async (command, args) => {
            spawned.push(`${command} ${args.join(" ")}`);
          },
        }),
      migrate: vi.fn(async () => noMigrations),
    });

    expect(spawned).toEqual([]);
    expect(result.capability).toBe("auth");
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toContain('from "@pithy-sh/auth/src/index"');
  });

  test("prompts for un-set options when a prompt seam is supplied", async () => {
    const install = vi.fn(installManifest(optionManifest));
    const prompt = vi.fn(async (_manifest, provided) => ({ ...provided, basePath: "/from-prompt" }));

    await runAdd({
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install,
      migrate: migrateStub,
      prompt,
    });

    expect(prompt).toHaveBeenCalledOnce();
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain('basePath: "/from-prompt",');
  });

  test("is idempotent — a second run leaves config and wrangler unchanged", async () => {
    const install = vi.fn(installManifest(optionManifest));
    await runAdd({
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install,
      migrate: migrateStub,
    });
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    const wrangler = await readFile(join(worker, "wrangler.jsonc"), "utf8");

    await runAdd({
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install,
      migrate: migrateStub,
    });
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toBe(config);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(wrangler);
  });

  test("audits a successful add as capability/added, info severity", async () => {
    const install = vi.fn(installManifest(optionManifest));
    const events: CliAuditEvent[] = [];

    await runAdd({
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability: "auth",
      install,
      migrate: migrateStub,
      audit: async (event) => void events.push(event),
    });

    expect(events).toEqual([
      expect.objectContaining({
        action: "capability/added",
        outcome: "success",
        severity: "info",
        resourceType: "capability",
        resourceId: "auth",
        // `targetWorker`, not `worker`: this is the Worker the capability was added TO, which is a
        // different thing from the `worker` origin column (null for a CLI action, which came from none).
        metadata: { targetWorker: DEFAULT_WORKER, package: "@pithy-sh/auth", packageManager: "bun", ejected: false },
      }),
    ]);
  });

  test("audits a failed add — an uninstalled capability — as a failure, and rethrows", async () => {
    const install = vi.fn(async () => ({ packageManager: "npm" }));
    const events: CliAuditEvent[] = [];

    await expect(
      runAdd({
        projectDir: dir,
        workerDir: worker,
        project: "acme",
        capability: "ghost",
        install,
        migrate: migrateStub,
        audit: async (event) => void events.push(event),
      }),
    ).rejects.toThrow(/ghost/);

    expect(events).toEqual([
      expect.objectContaining({
        action: "capability/added",
        outcome: "failure",
        severity: "info",
        resourceType: "capability",
        resourceId: "ghost",
      }),
    ]);
  });
});
