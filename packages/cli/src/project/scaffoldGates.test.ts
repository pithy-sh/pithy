// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "comment-json";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runUiAdd } from "../ui/flow";
import { loadWorkerConfig } from "./config";
import { scaffoldProject } from "./scaffold";

/**
 * The scaffold's own gates, run for real.
 *
 * `pithy init` used to write `dev` and `deploy` and nothing else: no `typecheck`, no `test`, no `lint`,
 * and no root `tsconfig.json`. So the three checks this repo's own conventions demand could not be run on
 * a fresh project until the adopter built the setup themselves — and the first thing they discover doing
 * it is that the Worker and the client cannot share one program. A scaffold whose own gates fail is worse
 * than none, so this file scaffolds a project, adds a React front end, and runs them.
 *
 * **The dependencies come from this monorepo, not from a registry.** A scaffolded project depends on
 * `@pithy-sh/core`, which is unpublished, so `bun install` in a temp directory cannot work. The link farm
 * below stitches a `node_modules` together out of packages this workspace has already installed, which is
 * also what a linked checkout looks like from the project's side.
 *
 * One program is deliberately left out of the post-`ui add` typecheck: `tsconfig.node.json`, which covers
 * `vite.config.ts`. It imports `@cloudflare/vite-plugin` and `@vitejs/plugin-react`, and neither is a
 * dependency of anything in this monorepo — `@pithy-sh/ui-react` skips that same file for that same
 * reason. The solution file is asserted to reference it; only the compile is out of reach here.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * Where the link farm takes packages from, first match wins. Two workspace packages between them install
 * everything a scaffolded project needs on both sides of the split — `@pithy-sh/testers` the Worker half
 * (hono, core, the Workers types, the Vitest pool, wrangler), `@pithy-sh/ui-react` the client half (React
 * and its types, Vite) — and the repo root supplies Biome.
 */
const FARM_SOURCES = [
  join(REPO, "packages", "testers", "node_modules"),
  join(REPO, "packages", "ui-react", "node_modules"),
  join(REPO, "node_modules"),
];

/** Symlink `target` at `path`, resolved absolute. An existing entry wins — the farm is first-source-wins. */
async function linkOne(target: string, path: string): Promise<void> {
  try {
    await symlink(await realpath(target), path);
  } catch {
    // Already linked by an earlier source, or the target is a broken link. Either way, leave it.
  }
}

/** Build `<projectDir>/node_modules` out of {@link FARM_SOURCES}, merging scopes one level deeper. */
async function linkFarm(projectDir: string): Promise<void> {
  const root = join(projectDir, "node_modules");
  await mkdir(root, { recursive: true });
  for (const source of FARM_SOURCES) {
    for (const entry of await readdir(source)) {
      if (!entry.startsWith("@")) {
        await linkOne(join(source, entry), join(root, entry));
        continue;
      }
      await mkdir(join(root, entry), { recursive: true });
      for (const scoped of await readdir(join(source, entry))) {
        await linkOne(join(source, entry, scoped), join(root, entry, scoped));
      }
    }
  }
}

/** Run a command in the scaffolded project and return its exit code with everything it printed. */
async function run(cwd: string, command: string, args: string[]): Promise<{ code: number; output: string }> {
  return await new Promise((settle) => {
    const child = spawn(command, args, {
      cwd,
      // NO_COLOR keeps a failure message readable in the assertion; CI stops any tool prompting.
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("close", (code) => settle({ code: code ?? 1, output }));
  });
}

let dir: string;
let scripts: Record<string, string>;

/** The scaffolded project's own binaries, reached through the farm. */
const tsc = (project: string) => join(project, "node_modules", "typescript", "bin", "tsc");
const vitest = (project: string) => join(project, "node_modules", "vitest", "vitest.mjs");
const biome = (project: string) => join(project, "node_modules", "@biomejs", "biome", "bin", "biome");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-gates-"));
  await scaffoldProject({ targetDir: dir, appName: "gates" });
  await linkFarm(dir);
  scripts = (JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> })
    .scripts;
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a freshly scaffolded project", () => {
  test("declares the three gates as root scripts", () => {
    expect(scripts.typecheck).toBe("tsc -b");
    expect(scripts.test).toBe("vitest run");
    expect(scripts.lint).toBe("biome check .");
  });

  test("lints clean", async () => {
    const { code, output } = await run(dir, biome(dir), ["check", "."]);
    expect(output).not.toMatch(/No configuration file found/);
    expect({ code, output }).toMatchObject({ code: 0 });
  }, 60_000);

  test("typechecks, through the solution file", async () => {
    const { code, output } = await run(dir, tsc(dir), ["-b"]);
    expect({ code, output }).toMatchObject({ code: 0 });
  }, 120_000);

  test("runs its tests", async () => {
    const { code, output } = await run(dir, vitest(dir), ["run"]);
    expect({ code, output }).toMatchObject({ code: 0 });
  }, 180_000);

  test("splits them into a node project and a Workers-runtime one", async () => {
    // A `--project` naming nothing is an error, not an empty run, so a clean exit from each of these is
    // proof the split is real — and the Workers one is the fiddly half: it boots workerd and hands the
    // scaffolded test a real D1 database and a real KV namespace.
    for (const project of ["node", "workers"]) {
      const { code, output } = await run(dir, vitest(dir), ["run", `--project=${project}`]);
      expect({ project, code, output }).toMatchObject({ project, code: 0 });
    }
  }, 180_000);

  test("keeps every .tsbuildinfo inside the ignored root dist/", async () => {
    // `composite` is what `references` costs, and it makes tsc emit build state. Under `dist/` it is
    // already gitignored; the project root's `dist/` rather than a Worker's, because Vite empties the
    // Worker's on every client build and would throw the incremental state away.
    const ignored = await readFile(join(dir, ".gitignore"), "utf8");
    expect(ignored).toMatch(/^dist\/$/m);
    const built = await readdir(join(dir, "dist"));
    expect(built.filter((name) => name.endsWith(".tsbuildinfo")).length).toBeGreaterThan(0);
  });
});

describe("after pithy ui add react", () => {
  beforeAll(async () => {
    const config = await loadWorkerConfig(join(dir, "apps", "api"));
    await runUiAdd({
      projectDir: dir,
      workerDir: join(dir, "apps", "api"),
      worker: "api",
      config,
      framework: "react",
      auth: false,
      payments: false,
      packageManager: "bun",
    });
  }, 60_000);

  test("extends the solution file with the client's programs", async () => {
    const solution = parse(await readFile(join(dir, "tsconfig.json"), "utf8")) as unknown as {
      files: string[];
      references: { path: string }[];
    };
    expect(solution.files).toEqual([]);
    expect(solution.references.map((reference) => reference.path)).toEqual([
      "./tsconfig.tools.json",
      "./apps/api/tsconfig.json",
      "./apps/api/tsconfig.client.json",
      "./apps/api/tsconfig.node.json",
    ]);
  });

  test("still typechecks — the Worker and the client as two programs", async () => {
    const { code, output } = await run(dir, tsc(dir), [
      "-b",
      "apps/api/tsconfig.json",
      "apps/api/tsconfig.client.json",
    ]);
    expect({ code, output }).toMatchObject({ code: 0 });
  }, 120_000);

  test("still lints clean", async () => {
    const { code, output } = await run(dir, biome(dir), ["check", "."]);
    expect({ code, output }).toMatchObject({ code: 0 });
  }, 60_000);
});
