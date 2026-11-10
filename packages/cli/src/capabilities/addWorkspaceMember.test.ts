// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type InstallRunner, installPackage } from "../project/packageManager";
import { scaffoldProject } from "../project/scaffold";
import { snapshotTree } from "../test-utils/treeSnapshot";
import { ejectCapability } from "./eject";
import { runAdd } from "./flow";
import { planAdd } from "./planAdd";
import { defaultRemoveSteps, removeCapability } from "./remove";

/**
 * **`pithy add` in Bun's workspace layout: `pithy init --name replay --worker board`, then `bun add` in the Worker.**
 *
 * Bun's isolated linker puts a member's dependency in that member's own `node_modules`, as a link into the root's
 * `.bun` store, and nowhere at the root. So the add finds the package from the Worker's directory, declares it in
 * the Worker's `package.json` alone, and its dry run plans exactly what the real run writes.
 */

const PKG = "@pithy-sh/secrets";
const VERSION = "0.6.8";
const MANIFEST = { name: "secrets", package: PKG, requiredBindings: [], configOptions: [] };
const PEERS = { "@pithy-sh/cloudflare": "^0.10.3", "@pithy-sh/core": "^0.20.0", zod: "^4.4.0" };

let dir: string;
let worker: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-add-member-"));
  await scaffoldProject({ targetDir: dir, appName: "replay", worker: "board" });
  worker = join(dir, "apps", "board");
  await writeFile(join(dir, "bun.lock"), "{}\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Put the package in Bun's store and link it into `base`'s own `node_modules`, the way the isolated linker does. */
async function link(base: string): Promise<void> {
  const store = join(dir, "node_modules", ".bun", `${PKG.replace("/", "+")}@${VERSION}`, "node_modules", PKG);
  await mkdir(join(store, "src"), { recursive: true });
  await writeFile(
    join(store, "package.json"),
    JSON.stringify({ name: PKG, version: VERSION, peerDependencies: PEERS, dependencies: { jose: "^6.0.0" } }),
  );
  await writeFile(join(store, "pithy.manifest.json"), JSON.stringify(MANIFEST));
  await writeFile(join(store, "src", "index.ts"), "export const secrets = () => ({});\n");
  const at = join(base, "node_modules", ...PKG.split("/"));
  await rm(at, { recursive: true, force: true });
  await mkdir(dirname(at), { recursive: true });
  await symlink(relative(dirname(at), store), at);
}

/** What `bun add <pkg>` does in `cwd`: links it, and declares it in `cwd`'s `package.json`, sorted. */
const bunAdd: InstallRunner & { calls: string[] } = Object.assign(
  async (_command: string, args: string[], cwd: string) => {
    bunAdd.calls.push(cwd);
    expect(args).toEqual(["add", PKG]);
    await link(cwd);
    const path = join(cwd, "package.json");
    const doc = JSON.parse(await readFile(path, "utf8")) as { dependencies?: Record<string, string> };
    const dependencies = { ...doc.dependencies, [PKG]: `^${VERSION}` };
    doc.dependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1)));
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
  },
  { calls: [] as string[] },
);

const base = () => ({ account: null, projectDir: dir, workerDir: worker, project: "replay", capability: "secrets" });

const realAdd = () =>
  runAdd({
    ...base(),
    install: (input) => installPackage({ ...input, run: bunAdd }),
    migrate: async () => [],
    bootstrap: async () => [],
  });

const dependenciesOf = async (path: string) =>
  (JSON.parse(await readFile(path, "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};

beforeEach(() => {
  bunAdd.calls.length = 0;
});

describe("pithy add, a capability in a workspace member", () => {
  test("installs in the Worker and declares it in the Worker's package.json only, sorted", async () => {
    const rootBefore = await readFile(join(dir, "package.json"), "utf8");

    await realAdd();

    expect(bunAdd.calls).toEqual([worker]);
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(rootBefore);
    const dependencies = await dependenciesOf(join(worker, "package.json"));
    expect(dependencies[PKG]).toBe(`^${VERSION}`);
    expect(dependencies["@pithy-sh/cloudflare"]).toBe("^0.10.3");
    const names = Object.keys(dependencies);
    expect(names).toEqual([...names].sort());
  });

  test("the import lands after the config's header comment, among its imports", async () => {
    await realAdd();

    const lines = (await readFile(join(worker, "pithy.config.ts"), "utf8")).split("\n");
    const at = lines.indexOf('import { secrets } from "@pithy-sh/secrets/src/index";');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(0, at).every((line) => !line.startsWith("import "))).toBe(false);
    const header = lines.findIndex((line) => !line.startsWith("//"));
    expect(at).toBeGreaterThan(header);
    expect(lines[at - 1]?.startsWith("import ") || lines[at + 1]?.startsWith("import ")).toBe(true);
  });

  test("--dry-run finds a package bun added in apps/board, and plans the change the real run makes", async () => {
    await bunAdd("bun", ["add", PKG], worker);
    bunAdd.calls.length = 0;

    const { plan } = await planAdd(base());
    const before = await snapshotTree(dir);
    await realAdd();
    const after = await snapshotTree(dir);

    const changed = [...after.keys()].filter((path) => after.get(path) !== before.get(path)).sort();
    expect(changed).toEqual(plan.files.map((file) => file.path));
    expect(plan.files.map((file) => file.path)).not.toContain("package.json");
    expect(plan.files.find((file) => file.path === "apps/board/package.json")?.changes).toEqual([
      `Runs bun add ${PKG} here, which also writes the lockfile.`,
    ]);
    for (const file of plan.files.filter((entry) => entry.diff !== undefined)) {
      const text = await readFile(join(dir, file.path), "utf8");
      const added = (file.diff ?? "").split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
      for (const line of added) expect(text.split("\n")).toContain(line.slice(1));
    }
  });

  test("--dry-run of a capability not yet installed plans the Worker's declaration, not the root's", async () => {
    await link(worker);
    const { plan } = await planAdd(base());

    expect(plan.files.map((file) => file.path)).not.toContain("package.json");
    const declared = plan.files.find((file) => file.path === "apps/board/package.json");
    expect(declared?.diff).toContain(`+    "${PKG}": "^${VERSION}"`);
    expect(declared?.changes).toEqual([`Runs bun add ${PKG} here, which also writes the lockfile.`]);
  });

  test("--dry-run of a capability installed nowhere names the install in the Worker, not at the root", async () => {
    const refusal = await planAdd(base()).catch((error: unknown) => error);

    expect((refusal as PithyError).payload.action).toBe(
      "Install it with cd apps/board && bun add @pithy-sh/secrets, then run `pithy add secrets --worker board --dry-run` again from the project root.",
    );
  });

  test("--eject copies the source the Worker resolves, and promotes its deps by running the install in the Worker", async () => {
    await link(worker);
    const promoted: { args: string[]; cwd: string }[] = [];

    const { plan } = await planAdd({ ...base(), eject: true });
    await runAdd({
      ...base(),
      eject: true,
      install: (input) => installPackage({ ...input, run: bunAdd }),
      migrate: async () => [],
      bootstrap: async () => [],
      ejectStep: (step) =>
        ejectCapability({
          ...step,
          run: async (_command, args, cwd) => {
            promoted.push({ args, cwd });
          },
        }),
    });

    expect(await readFile(join(worker, "capabilities", "secrets", "index.ts"), "utf8")).toContain("secrets");
    expect(promoted).toEqual([{ args: ["add", "jose@^6.0.0"], cwd: worker }]);
    expect(plan.files.find((file) => file.path === "apps/board/package.json")?.changes).toContain(
      "Runs bun add jose@^6.0.0 here, for the ejected copy.",
    );
  });

  test("pithy remove finds the package the Worker resolves", async () => {
    const steps = (workerDir: string) =>
      defaultRemoveSteps({
        projectDir: dir,
        workerDir,
        loadCapabilities: async () => [],
        project: "replay",
        account: null,
      });
    expect(await steps(worker).packageInstalled(PKG)).toBe(false);
    await link(worker);
    expect(await steps(worker).packageInstalled(PKG)).toBe(true);
  });

  test("pithy remove uninstalls from the Worker's own package.json while a sibling Worker still composes it", async () => {
    await realAdd();
    const admin = join(dir, "apps", "admin");
    await cp(worker, admin, { recursive: true, verbatimSymlinks: true });
    const removed: { args: string[]; cwd: string }[] = [];

    const result = await removeCapability({
      workerDir: worker,
      capability: "secrets",
      steps: defaultRemoveSteps({
        projectDir: dir,
        workerDir: worker,
        loadCapabilities: async () => [],
        project: "replay",
        account: null,
        run: async (_command, args, cwd) => {
          removed.push({ args, cwd });
        },
      }),
    });

    expect(result.keptFor).toHaveLength(1);
    expect(removed).toEqual([{ args: ["remove", PKG], cwd: worker }]);
    expect(result.packageManager).toBe("bun");
  });

  describe("a package only the root declares, as a hand install at the root leaves it", () => {
    /** Wire the capability into `workerDir`, then move its declaration from the Worker to the root. */
    async function declaredAtRootOnly(): Promise<void> {
      await realAdd();
      const workerManifest = JSON.parse(await readFile(join(worker, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      const range = workerManifest.dependencies[PKG];
      delete workerManifest.dependencies[PKG];
      await writeFile(join(worker, "package.json"), `${JSON.stringify(workerManifest, null, 2)}\n`);
      const rootManifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      rootManifest.dependencies = { ...rootManifest.dependencies, [PKG]: range ?? `^${VERSION}` };
      await writeFile(join(dir, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);
    }

    const removeFrom = (removed: { args: string[]; cwd: string }[]) =>
      removeCapability({
        workerDir: worker,
        capability: "secrets",
        steps: defaultRemoveSteps({
          projectDir: dir,
          workerDir: worker,
          loadCapabilities: async () => [],
          project: "replay",
          account: null,
          run: async (_command, args, cwd) => {
            removed.push({ args, cwd });
          },
        }),
      });

    test("is uninstalled at the root, where it is declared", async () => {
      await declaredAtRootOnly();
      const removed: { args: string[]; cwd: string }[] = [];

      await removeFrom(removed);

      expect(removed).toEqual([{ args: ["remove", PKG], cwd: dir }]);
    });

    test("is kept while a sibling Worker still imports it, since the root's copy is the one that sibling resolves", async () => {
      await declaredAtRootOnly();
      await cp(worker, join(dir, "apps", "admin"), { recursive: true, verbatimSymlinks: true });
      const removed: { args: string[]; cwd: string }[] = [];

      const result = await removeFrom(removed);

      expect(result.keptFor).toHaveLength(1);
      expect(removed).toEqual([]);
    });
  });
});
