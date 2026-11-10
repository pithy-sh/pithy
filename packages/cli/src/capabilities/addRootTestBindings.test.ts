// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { installedPackageBase } from "../project/installedPackage";
import { type InstallRunner, installPackage } from "../project/packageManager";
import { scaffoldProject } from "../project/scaffold";
import { WORKERS_TEST_CONFIG } from "../project/workersTestConfig";
import { runAdd } from "./flow";
import { planAdd } from "./planAdd";
import { defaultRemoveSteps, removeCapability } from "./remove";

/**
 * **`pithy add secrets` in a Bun workspace: the package its test binding imports is a root devDependency.**
 *
 * The secrets manifest's master-key test binding writes an import of `@pithy-sh/secrets` into the root
 * `vitest.workers.config.ts`. Bun's isolated linker links a member's dependency beside that member and nowhere at
 * the root, so the root declares the package too, and the Worker keeps its runtime dependency alone. The project
 * is scaffolded into the OS tmpdir, outside every checkout, so no parent `node_modules` can resolve it instead.
 */

const PKG = "@pithy-sh/secrets";
const VERSION = "0.6.8";
const MODULE = `${PKG}/src/test-utils/devEncryptionKeys`;
const MANIFEST = {
  name: "secrets",
  package: PKG,
  requiredBindings: [],
  configOptions: [],
  testBindings: [
    { kind: "d1", name: "SECRETS" },
    { kind: "value", name: "SECRETS_ENCRYPTION_KEYS", module: MODULE, export: "devEncryptionKeys" },
  ],
};

let dir: string;
let worker: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-add-root-test-"));
  await scaffoldProject({ targetDir: dir, appName: "replay", worker: "board" });
  worker = join(dir, "apps", "board");
  await writeFile(join(dir, "bun.lock"), "{}\n");
  bunAdd.calls.length = 0;
  bunInstall.calls.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const store = () => join(dir, "node_modules", ".bun", `${PKG.replace("/", "+")}@${VERSION}`, "node_modules", PKG);

/** Put the package in Bun's store and link it into `base`'s own `node_modules`, the way the isolated linker does. */
async function link(base: string): Promise<void> {
  const at = store();
  await mkdir(join(at, "src", "test-utils"), { recursive: true });
  await writeFile(join(at, "package.json"), JSON.stringify({ name: PKG, version: VERSION }));
  await writeFile(join(at, "pithy.manifest.json"), JSON.stringify(MANIFEST));
  await writeFile(join(at, "src", "index.ts"), "export const secrets = () => ({});\n");
  await writeFile(
    join(at, "src", "test-utils", "devEncryptionKeys.ts"),
    "export const devEncryptionKeys = () => '';\n",
  );
  const into = join(base, "node_modules", ...PKG.split("/"));
  await rm(into, { recursive: true, force: true });
  await mkdir(dirname(into), { recursive: true });
  await symlink(relative(dirname(into), at), into);
}

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const manifestOf = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Manifest;

/** What `bun add <pkg>` does in `cwd`: links it, and declares it in `cwd`'s `package.json`. */
const bunAdd: InstallRunner & { calls: string[] } = Object.assign(
  async (_command: string, _args: string[], cwd: string) => {
    bunAdd.calls.push(cwd);
    await link(cwd);
    const path = join(cwd, "package.json");
    const doc = await manifestOf(path);
    doc.dependencies = { ...doc.dependencies, [PKG]: `^${VERSION}` };
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
  },
  { calls: [] as string[] },
);

/** What `bun install` at the root does with the isolated linker: links the root's own declarations at the root. */
const bunInstall: InstallRunner & { calls: [string, string[], string][] } = Object.assign(
  async (command: string, args: string[], cwd: string) => {
    bunInstall.calls.push([command, args, cwd]);
    const root = await manifestOf(join(cwd, "package.json"));
    if ({ ...root.dependencies, ...root.devDependencies }[PKG] !== undefined) await link(cwd);
    else await rm(join(cwd, "node_modules", ...PKG.split("/")), { recursive: true, force: true });
  },
  { calls: [] as [string, string[], string][] },
);

const base = () => ({ account: null, projectDir: dir, workerDir: worker, project: "replay", capability: "secrets" });

const realAdd = () =>
  runAdd({
    ...base(),
    install: (input) => installPackage({ ...input, run: bunAdd }),
    sync: (projectDir) => bunInstall("bun", ["install"], projectDir),
    migrate: async () => [],
    bootstrap: async () => [],
  });

const remove = (removed: { args: string[]; cwd: string }[]) =>
  removeCapability({
    workerDir: worker,
    capability: "secrets",
    steps: defaultRemoveSteps({
      projectDir: dir,
      workerDir: worker,
      loadCapabilities: async () => [],
      project: "replay",
      account: null,
      run: async (command, args, cwd) => {
        removed.push({ args, cwd });
        if (args[0] === "install") await bunInstall(command, args, cwd);
      },
    }),
  });

describe("pithy add, a test binding that imports from the capability's package", () => {
  test("declares the package as a root devDependency, and the runtime dependency in the Worker only", async () => {
    await realAdd();

    expect(await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8")).toContain(`from "${MODULE}"`);
    const root = await manifestOf(join(dir, "package.json"));
    expect(root.devDependencies?.[PKG]).toBe(`^${VERSION}`);
    expect(root.dependencies?.[PKG]).toBeUndefined();
    const names = Object.keys(root.devDependencies ?? {});
    expect(names).toEqual([...names].sort());
    const member = await manifestOf(join(worker, "package.json"));
    expect(member.dependencies?.[PKG]).toBe(`^${VERSION}`);
    expect(member.devDependencies?.[PKG]).toBeUndefined();
  });

  test("runs the root install, so the root resolves what its Workers config imports", async () => {
    await realAdd();

    expect(bunInstall.calls).toEqual([["bun", ["install"], dir]]);
    expect(await installedPackageBase(dir, dir, PKG)).toBe(dir);
  });

  test("a copy of the project resolves the import from its own root after a fresh install", async () => {
    await realAdd();
    const copy = await mkdtemp(join(tmpdir(), "pithy-add-root-copy-"));
    try {
      await cp(dir, copy, { recursive: true, filter: (source) => !source.includes("node_modules") });
      expect(await installedPackageBase(copy, copy, PKG)).toBeNull();
      await bunInstall("bun", ["install"], copy);
      expect(await installedPackageBase(copy, copy, PKG)).toBe(copy);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  test("--dry-run plans the root devDependency and the root install the real run makes", async () => {
    await bunAdd("bun", ["add", PKG], worker);

    const { plan } = await planAdd(base());

    const root = plan.files.find((file) => file.path === "package.json");
    expect(root?.diff).toContain(`+    "${PKG}": "^${VERSION}"`);
    expect(root?.changes).toEqual(["Runs bun install here, which also writes the lockfile."]);
    expect(bunInstall.calls).toEqual([]);
  });

  test("pithy remove takes the root devDependency out when nothing else imports it", async () => {
    await realAdd();
    const removed: { args: string[]; cwd: string }[] = [];

    await remove(removed);

    expect(await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8")).not.toContain(MODULE);
    expect((await manifestOf(join(dir, "package.json"))).devDependencies?.[PKG]).toBeUndefined();
    expect(removed).toEqual([
      { args: ["install"], cwd: dir },
      { args: ["remove", PKG], cwd: worker },
    ]);
  });

  test("pithy remove keeps the root devDependency while a sibling Worker still composes the capability", async () => {
    await realAdd();
    await cp(worker, join(dir, "apps", "admin"), { recursive: true, verbatimSymlinks: true });

    await remove([]);

    expect(await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8")).toContain(MODULE);
    expect((await manifestOf(join(dir, "package.json"))).devDependencies?.[PKG]).toBe(`^${VERSION}`);
  });
});
