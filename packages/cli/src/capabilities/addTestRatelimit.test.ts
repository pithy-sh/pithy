// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type InstallRunner, installPackage } from "../project/packageManager";
import { scaffoldProject } from "../project/scaffold";
import { incompleteTestBindings, WORKERS_TEST_CONFIG } from "../project/workersTestConfig";
import { runAdd } from "./flow";
import { planAdd } from "./planAdd";

/**
 * **`pithy add` over a Workers test config holding a rate limiter with no `namespace_id`.** The re-run fills the id
 * in, `--dry-run` shows that one line, and neither touches the Worker's `wrangler.jsonc`, which already has the
 * binding. The capability is a stand-in installed into the scaffolded project, as `bun add` would link it.
 */

const PKG = "@pithy-sh/secrets";
const VERSION = "0.6.8";
const LIMITER = { kind: "ratelimit", name: "SECRETS_LIMITER", limit: 100, period: 60 } as const;
const MANIFEST = {
  name: "secrets",
  package: PKG,
  requiredBindings: [{ type: "ratelimit", name: LIMITER.name }],
  configOptions: [],
  testBindings: [LIMITER],
};

let dir: string;
let worker: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-add-test-ratelimit-"));
  await scaffoldProject({ targetDir: dir, appName: "replay", worker: "board" });
  worker = join(dir, "apps", "board");
  await writeFile(join(dir, "bun.lock"), "{}\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Put the stand-in package where Bun's isolated linker would, and link it into `base`. */
async function link(base: string): Promise<void> {
  const at = join(dir, "node_modules", ".bun", `${PKG.replace("/", "+")}@${VERSION}`, "node_modules", PKG);
  await mkdir(join(at, "src"), { recursive: true });
  await writeFile(join(at, "package.json"), JSON.stringify({ name: PKG, version: VERSION }));
  await writeFile(join(at, "pithy.manifest.json"), JSON.stringify(MANIFEST));
  await writeFile(join(at, "src", "index.ts"), "export const secrets = () => ({});\n");
  const into = join(base, "node_modules", ...PKG.split("/"));
  await rm(into, { recursive: true, force: true });
  await mkdir(dirname(into), { recursive: true });
  await symlink(relative(dirname(into), at), into);
}

const bunAdd: InstallRunner = async (_command, _args, cwd) => {
  await link(cwd);
  const path = join(cwd, "package.json");
  const doc = JSON.parse(await readFile(path, "utf8")) as { dependencies?: Record<string, string> };
  doc.dependencies = { ...doc.dependencies, [PKG]: `^${VERSION}` };
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
};

const base = () => ({ account: null, projectDir: dir, workerDir: worker, project: "replay", capability: "secrets" });

const realAdd = () =>
  runAdd({
    ...base(),
    install: (input) => installPackage({ ...input, run: bunAdd }),
    sync: async () => {},
    migrate: async () => [],
    bootstrap: async () => [],
  });

describe("pithy add over a test rate limiter with no namespace_id", () => {
  test("fills the id in, shows it under --dry-run, and leaves wrangler.jsonc alone", async () => {
    await realAdd();
    const configPath = join(dir, WORKERS_TEST_CONFIG);
    const written = await readFile(configPath, "utf8");
    expect(written).toContain(`${LIMITER.name}: { namespace_id: "`);
    const stale = written.replace(/namespace_id: "\d+", /, "");
    await writeFile(configPath, stale);
    expect(incompleteTestBindings(stale, [LIMITER]).map((binding) => binding.name)).toEqual([LIMITER.name]);
    const wrangler = await readFile(join(worker, "wrangler.jsonc"), "utf8");

    const { plan } = await planAdd(base());
    expect(plan.files.map((file) => file.path)).toEqual([WORKERS_TEST_CONFIG]);
    expect(plan.files[0]?.diff).toMatch(/^\+.*SECRETS_LIMITER: \{ namespace_id: "\d+", simple:/m);
    expect(await readFile(configPath, "utf8")).toBe(stale);

    await realAdd();
    expect(await readFile(configPath, "utf8")).toBe(written);
    expect(incompleteTestBindings(written, [LIMITER])).toEqual([]);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(wrangler);
  });
});
