// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Plan } from "../plan/plan";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { snapshotTree } from "../test-utils/treeSnapshot";
import { runAdd } from "./flow";
import { planAdd } from "./planAdd";

/**
 * **`pithy add --dry-run` writes nothing, installs nothing, and plans what the add then does (#697).**
 *
 * The plan is the real add run in a copy of the project, so the first half is about the copy — the project
 * and the dev secrets file are byte-identical afterwards — and the second is about the plan: the files it
 * names are the files the real add changes, and its diff is the change.
 */

const authManifest = CapabilityManifest.parse({
  name: "auth",
  package: "@pithy-sh/auth",
  requiredBindings: [{ type: "d1", name: "DB" }],
  configOptions: [{ key: "basePath", default: "/auth", describe: "Where the auth routes mount." }],
  devSecrets: [{ name: "auth-session-secret", devValue: "random" }],
});

const secretsManifest = CapabilityManifest.parse({
  name: "secrets",
  package: "@pithy-sh/secrets",
  requiredBindings: [],
  configOptions: [],
});

/** `auth`, requiring `secrets` the way the real one does. */
const authNeedingSecrets = CapabilityManifest.parse({ ...authManifest, peerCapabilities: ["secrets"] });

let dir: string;
let worker: string;
let configDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-plan-add-"));
  await scaffoldProject({ targetDir: dir, appName: "plan-add" });
  worker = join(dir, "apps", DEFAULT_WORKER);
  configDir = process.env.PITHY_CONFIG_DIR ?? "";
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Put a capability's package where an install would have: its manifest, its version, its source. */
async function install(manifest: CapabilityManifest, version = "1.2.3"): Promise<void> {
  const pkgDir = join(dir, "node_modules", ...manifest.package.split("/"));
  await mkdir(join(pkgDir, "src"), { recursive: true });
  await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(manifest));
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: manifest.package, version }));
  await writeFile(join(pkgDir, "src", "index.ts"), "export const capability = 1;\n");
  await writeFile(join(pkgDir, "src", "routes.ts"), "export const routes = [];\n");
}

const base = () => ({ account: null, projectDir: dir, workerDir: worker, project: "acme" });

describe("planAdd", () => {
  test("writes nothing — not the project, not the dev secrets file — and the plan parses as the one shape", async () => {
    await install(authManifest);
    const project = await snapshotTree(dir);
    const secrets = await snapshotTree(configDir);

    const planned = await planAdd({ ...base(), capability: "auth" });

    expect(await snapshotTree(dir)).toEqual(project);
    expect(await snapshotTree(configDir)).toEqual(secrets);
    expect(Plan.parse(planned.plan)).toEqual(planned.plan);
  });

  test("the plan is the add: its config and binding diffs, the install, the secret, the migrate", async () => {
    await install(authManifest);
    const { plan, capability, databases } = await planAdd({ ...base(), capability: "auth" });

    expect(capability).toBe("auth");
    expect(databases).toEqual([]);
    const byPath = new Map(plan.files.map((file) => [file.path, file]));
    expect(byPath.get(`apps/${DEFAULT_WORKER}/pithy.config.ts`)?.diff).toContain(
      '+import { auth } from "@pithy-sh/auth/src/index";',
    );
    expect(byPath.get(`apps/${DEFAULT_WORKER}/wrangler.jsonc`)?.diff).toContain('"binding": "DB"');
    const root = byPath.get("package.json");
    expect(root?.changes).toEqual(["Runs npm install @pithy-sh/auth here, which also writes the lockfile."]);
    expect(root?.diff).toContain('+    "@pithy-sh/auth": "^1.2.3"');
    expect(byPath.get(`apps/${DEFAULT_WORKER}/package.json`)?.diff).toContain('+    "@pithy-sh/auth": "^1.2.3"');
    expect(plan.secrets).toEqual([expect.objectContaining({ name: "auth-session-secret", action: "mint" })]);
    expect(plan.notes[0]).toMatch(/pending dev migrations/);
    // The copy's path never reaches the plan.
    expect(JSON.stringify(plan)).not.toMatch(/pithy-plan-[A-Za-z0-9]{6}/);
  });

  test("the files it names are the files the real add changes, with the same bytes", async () => {
    await install(authManifest);
    const { plan } = await planAdd({ ...base(), capability: "auth" });
    const config = join(worker, "pithy.config.ts");
    const before = await readFile(config, "utf8");

    await runAdd({
      ...base(),
      capability: "auth",
      install: async () => ({ packageManager: "npm" }),
      migrate: async () => [],
      bootstrap: async () => [],
    });

    const after = await readFile(config, "utf8");
    const diff = plan.files.find((file) => file.path === `apps/${DEFAULT_WORKER}/pithy.config.ts`)?.diff ?? "";
    const added = diff
      .split("\n")
      .filter((line) => line.startsWith("+"))
      .map((line) => line.slice(1));
    for (const line of added) expect(after.split("\n")).toContain(line);
    expect(after).not.toBe(before);
  });

  test("a capability that is not installed is refused, naming the install — not planned from a guess", async () => {
    const before = await snapshotTree(dir);
    const refusal = await planAdd({ ...base(), capability: "auth" }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PithyError);
    const payload = (refusal as PithyError).payload;
    expect(payload.code).toBe("core/precondition_failed");
    expect(payload.message).toContain("@pithy-sh/auth is not installed");
    expect(payload.action).toContain("npm install @pithy-sh/auth");
    expect(payload.action).toContain("pithy add auth --worker api --with-prerequisites --dry-run");
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("the same refusals as the real add: a missing prerequisite without --with-prerequisites", async () => {
    await install(authNeedingSecrets);
    await install(secretsManifest);
    await expect(planAdd({ ...base(), capability: "auth" })).rejects.toThrow(/secrets/);
  });

  test("with --with-prerequisites, the prerequisite is planned first and named", async () => {
    await install(authNeedingSecrets);
    await install(secretsManifest);
    const before = await snapshotTree(dir);
    const { prerequisites, plan } = await planAdd({ ...base(), capability: "auth", withPrerequisites: true });
    expect(prerequisites).toEqual(["secrets"]);
    const config = plan.files.find((file) => file.path === `apps/${DEFAULT_WORKER}/pithy.config.ts`)?.diff ?? "";
    expect(config).toContain("+import { secrets }");
    expect(config).toContain("+import { auth }");
    expect(plan.files.find((file) => file.path === "package.json")?.changes).toEqual([
      "Runs npm install @pithy-sh/auth @pithy-sh/secrets here, which also writes the lockfile.",
    ]);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("--eject plans one directory created and the repointed import, and installs nothing", async () => {
    await install(authManifest);
    const before = await snapshotTree(dir);
    const { plan, eject } = await planAdd({ ...base(), capability: "auth", eject: true });
    expect(eject?.path).toBe("capabilities/auth");
    const ejected = plan.files.find((file) => file.path === `apps/${DEFAULT_WORKER}/capabilities/auth`);
    expect(ejected).toEqual({
      path: `apps/${DEFAULT_WORKER}/capabilities/auth`,
      action: "create",
      changes: ["Copies @pithy-sh/auth's source here, 2 files. @pithy-sh/auth no longer upgrades it."],
    });
    expect(plan.files.some((file) => file.path.startsWith(`apps/${DEFAULT_WORKER}/capabilities/auth/`))).toBe(false);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  /**
   * **A file the add edits may be a link out of the project, and the plan is still the add (#697).** The real
   * add writes through the adopter's link; the dry run crashed on it with a raw `ENOTDIR` naming its temporary
   * copy, exit 1 and no `--json` line. It plans the edit at the path the add wrote, says where it lands, and
   * leaves the file outside alone.
   */
  describe("a link out of the project", () => {
    let outside: string;
    beforeEach(async () => {
      outside = await mkdtemp(join(tmpdir(), "pithy-plan-add-outside-"));
    });
    afterEach(async () => {
      await rm(outside, { recursive: true, force: true });
    });

    test("a pithy.config.ts linked from outside is planned as the edit the real add makes through the link", async () => {
      await install(authManifest);
      const config = join(worker, "pithy.config.ts");
      const shared = join(outside, "pithy.config.ts");
      await rename(config, shared);
      await symlink(relative(worker, shared), config);
      const original = await readFile(shared, "utf8");
      const before = await snapshotTree(dir);

      const { plan } = await planAdd({ ...base(), capability: "auth" });

      const path = `apps/${DEFAULT_WORKER}/pithy.config.ts`;
      const edit = plan.files.find((file) => file.path === path);
      expect(edit?.action).toBe("edit");
      expect(edit?.diff).toContain('+import { auth } from "@pithy-sh/auth/src/index";');
      expect(plan.notes).toContain(`${path} is a link to a file outside the project. The edit lands in that file.`);
      expect(JSON.stringify(plan)).not.toMatch(/pithy-plan-[A-Za-z0-9]{6}\//);
      expect(await readFile(shared, "utf8")).toBe(original);
      expect(await snapshotTree(dir)).toEqual(before);

      // And the real add makes exactly that edit, through the link, to the file outside.
      await runAdd({
        ...base(),
        capability: "auth",
        install: async () => ({ packageManager: "npm" }),
        migrate: async () => [],
        bootstrap: async () => [],
      });
      expect((await lstat(config)).isSymbolicLink()).toBe(true);
      const after = (await readFile(shared, "utf8")).split("\n");
      const added = (edit?.diff ?? "").split("\n").filter((line) => line.startsWith("+"));
      expect(added.length).toBeGreaterThan(0);
      for (const line of added) expect(after).toContain(line.slice(1));
    });

    test("a directory linked from outside is refused as the real add refuses it", async () => {
      await install(authManifest);
      await symlink(outside, join(worker, "capabilities"));
      const real = await runAdd({
        ...base(),
        capability: "auth",
        eject: true,
        install: async () => ({ packageManager: "npm" }),
        migrate: async () => [],
        bootstrap: async () => [],
      }).catch((error: unknown) => error);
      expect(real).toBeInstanceOf(PithyError);
      const planned = await planAdd({ ...base(), capability: "auth", eject: true }).catch((error: unknown) => error);
      expect(planned).toBeInstanceOf(PithyError);
      expect((planned as PithyError).payload.code).toBe((real as PithyError).payload.code);
      expect((planned as PithyError).payload.message).toBe((real as PithyError).payload.message);
      expect(await readdir(outside)).toEqual([]);
    });
  });

  test("a re-run over a project that already composes it plans no wiring", async () => {
    await install(authManifest);
    // What the real install leaves at the root, which the stub below does not write.
    const rootPath = join(dir, "package.json");
    const root = JSON.parse(await readFile(rootPath, "utf8")) as { dependencies?: Record<string, string> };
    root.dependencies = { ...root.dependencies, "@pithy-sh/auth": "^1.2.3" };
    await writeFile(rootPath, `${JSON.stringify(root, null, 2)}\n`);
    await runAdd({
      ...base(),
      capability: "auth",
      install: async () => ({ packageManager: "npm" }),
      migrate: async () => [],
      bootstrap: async () => [],
    });
    const { plan } = await planAdd({ ...base(), capability: "auth" });
    expect(plan.files.filter((file) => file.path.startsWith("apps/"))).toEqual([]);
  });
});
