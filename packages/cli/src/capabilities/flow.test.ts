import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import type { DatabaseRun } from "../migrations/run";
import { scaffoldProject } from "../project/scaffold";
import { coerceSetFlags, collectSetFlags, runAdd } from "./flow";

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
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-flow-"));
    await scaffoldProject({ targetDir: dir, appName: "flow-test" });
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
      capability: "auth",
      setFlags: ["basePath=/authentication", "sessionDays=7"],
      install,
      migrate,
    });

    // Install ran for the scoped package.
    expect(install).toHaveBeenCalledWith({ projectDir: dir, pkg: "@pithy-sh/auth" });
    // Config was wired with every override before migration ran.
    const config = await readFile(join(dir, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { auth } from "@pithy-sh/auth/src/index";');
    expect(config).toContain('basePath: "/authentication",');
    expect(config).toContain("sessionDays: 7,");
    expect(config).toContain("cookies: true,"); // un-set option keeps its default
    // Migration ran against the project after wiring.
    expect(migrate).toHaveBeenCalledWith(dir);
    expect(result).toEqual({
      capability: "auth",
      package: "@pithy-sh/auth",
      packageManager: "bun",
      databases,
    });
  });

  test("an uninstalled capability (install left no manifest) fails naming it", async () => {
    const install = vi.fn(async () => ({ packageManager: "npm" }));
    await expect(runAdd({ projectDir: dir, capability: "ghost", install, migrate: migrateStub })).rejects.toThrow(
      /ghost/,
    );
    expect(migrateStub).not.toHaveBeenCalled();
  });

  test("prompts for un-set options when a prompt seam is supplied", async () => {
    const install = vi.fn(installManifest(optionManifest));
    const prompt = vi.fn(async (_manifest, provided) => ({ ...provided, basePath: "/from-prompt" }));

    await runAdd({ projectDir: dir, capability: "auth", install, migrate: migrateStub, prompt });

    expect(prompt).toHaveBeenCalledOnce();
    const config = await readFile(join(dir, "pithy.config.ts"), "utf8");
    expect(config).toContain('basePath: "/from-prompt",');
  });

  test("is idempotent — a second run leaves config and wrangler unchanged", async () => {
    const install = vi.fn(installManifest(optionManifest));
    await runAdd({ projectDir: dir, capability: "auth", install, migrate: migrateStub });
    const config = await readFile(join(dir, "pithy.config.ts"), "utf8");
    const wrangler = await readFile(join(dir, "wrangler.jsonc"), "utf8");

    await runAdd({ projectDir: dir, capability: "auth", install, migrate: migrateStub });
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toBe(config);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(wrangler);
  });

  test("audits a successful add as capability/added, info severity", async () => {
    const install = vi.fn(installManifest(optionManifest));
    const events: CliAuditEvent[] = [];

    await runAdd({
      projectDir: dir,
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
        metadata: { package: "@pithy-sh/auth", packageManager: "bun", ejected: false },
      }),
    ]);
  });

  test("audits a failed add — an uninstalled capability — as a failure, and rethrows", async () => {
    const install = vi.fn(async () => ({ packageManager: "npm" }));
    const events: CliAuditEvent[] = [];

    await expect(
      runAdd({
        projectDir: dir,
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
