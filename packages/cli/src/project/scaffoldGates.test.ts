// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "comment-json";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runAdd } from "../capabilities/flow";
import { runUiAdd } from "../ui/flow";
import { scaffoldProject } from "./scaffold";
import { resolveSingleWorker } from "./workerScope";

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

/**
 * The fixture's two names, deliberately unequal.
 *
 * A worker deploys as `<project>-<worker>` and lives at `apps/<worker>`. Scaffolding this fixture as
 * `gates` alone made those two strings identical — `api` and `api` — so every path built from the wrong
 * one still landed on the right directory, and `pithy ui add` wrote `apps/gates-api/tsconfig.client.json`
 * into the solution file for a year of runs without a gate noticing. Two names that cannot collide is
 * what makes this file able to see that class of bug at all.
 */
const PROJECT = "gates";
const WORKER = "board";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-gates-"));
  await scaffoldProject({ targetDir: dir, appName: PROJECT, worker: WORKER });
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

  test("gates console in the worker's source, and names the replacement", async () => {
    // "lints clean" proves the scaffolded plugin does not misfire. This proves it fires at all — a
    // `path` or an `includes` that misses the scaffolded layout is a gate that passes everything,
    // silently, and the scaffold would ship a file that does nothing.
    //
    // Written and removed inside the test: every later gate here compiles or runs the worker's `src`.
    //
    // Addressed through `WORKER` rather than a literal, because the scaffolded plugin matches
    // `**/apps/*/src/**/*.ts` and a fixture whose worker is named for the default proves only that the
    // glob works for that one name. This fixture deliberately does not use it.
    const probe = join(dir, "apps", WORKER, "src", "probe.ts");
    await writeFile(probe, 'export const probe = (): void => console.log("hi");\n');
    try {
      const { code, output } = await run(dir, biome(dir), ["check", `apps/${WORKER}/src/probe.ts`]);
      expect({ code, output }).not.toMatchObject({ code: 0 });
      expect(output).toContain("createWorkerLogger()");
    } finally {
      await rm(probe, { force: true });
    }
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

/**
 * The path nobody ran end to end: composing a capability.
 *
 * `pithy add` renders one `key: default` per manifest option and nothing else, so an option the
 * capability *requires* and whose manifest did not state it was simply absent. `pithy add secrets`
 * wrote `secrets({ rotationIntervalDays: 30 })` against a `SecretsConfig` whose `registry` is required,
 * and the first `bun run typecheck` on a project the adopter had not touched failed TS2741 (#161).
 *
 * Secrets is the capability worth spending a gate on: it is the first one most projects add, because
 * auth, email and payments all read their credentials through it.
 *
 * `runAdd` rather than `addCapability`, for the reason the `ui add` block below calls the flow — the
 * manifest load is half of what broke, and a test handed a hand-built manifest never reads the file
 * that was wrong. Install and migrate are stubbed: the package is already in the link farm, and D1 is
 * not what this proves.
 *
 * Ahead of `ui add`, so the gate can be plain `tsc -b` — the whole solution file, exactly what the
 * adopter runs. Once the client is added, one program in that solution needs a package this monorepo
 * does not install; see the block below.
 */
describe("after pithy add secrets", () => {
  beforeAll(async () => {
    await runAdd({
      projectDir: dir,
      workerDir: join(dir, "apps", WORKER),
      worker: WORKER,
      project: PROJECT,
      capability: "secrets",
      install: async () => ({ packageManager: "bun" }),
      migrate: async () => [],
    });
  }, 60_000);

  test("registers the capability with every option its config requires", async () => {
    const config = await readFile(join(dir, "apps", WORKER, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { secrets } from "@pithy-sh/secrets/src/index";');
    // Empty, because the contents are the adopter's — and present, because the type is not optional.
    expect(config).toContain("registry: {},");
    expect(config).toContain("rotationIntervalDays: 30,");
  });

  test("still typechecks, with no edit by the adopter", async () => {
    const { code, output } = await run(dir, tsc(dir), ["-b"]);
    expect({ code, output }).toMatchObject({ code: 0, output: "" });
  }, 120_000);

  test("still lints clean", async () => {
    const { code, output } = await run(dir, biome(dir), ["check", "."]);
    expect({ code, output }).toMatchObject({ code: 0 });
  }, 60_000);
});

describe("after pithy ui add react", () => {
  beforeAll(async () => {
    // Resolved the way the command resolves it, not by hand: `pithy ui add` reaches the flow through
    // `resolveSingleWorker`, and it was that hand-off that carried the deployed name where a directory
    // belonged. A test that assembles the arguments itself never crosses the seam that broke.
    const target = await resolveSingleWorker({ projectDir: dir, worker: WORKER });
    // The fixture's guarantee, asserted rather than assumed: the deployed name is not the directory.
    expect(target.name).toBe(`${PROJECT}-${WORKER}`);
    expect(target.dir).toBe(join(dir, "apps", WORKER));
    await runUiAdd({
      projectDir: dir,
      workerDir: target.dir,
      config: target.config,
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
      `./apps/${WORKER}/tsconfig.json`,
      `./apps/${WORKER}/tsconfig.client.json`,
      `./apps/${WORKER}/tsconfig.node.json`,
    ]);
  });

  test("keeps the solution file buildable, every reference included", async () => {
    // `--dry` builds nothing and still resolves every reference, so this covers the one program the
    // compile below cannot: `tsconfig.node.json` needs `@cloudflare/vite-plugin`, which no package in
    // this monorepo installs. A reference to a directory that does not exist is TS6053 here, and TS6053
    // is the whole `typecheck` gate failing on a project the adopter has not touched yet.
    const { code, output } = await run(dir, tsc(dir), ["-b", "--dry"]);
    expect({ code, output }).toMatchObject({ code: 0 });
    expect(output).not.toMatch(/TS6053/);
  }, 120_000);

  test("still typechecks — the Worker and the client as two programs", async () => {
    const { code, output } = await run(dir, tsc(dir), [
      "-b",
      `apps/${WORKER}/tsconfig.json`,
      `apps/${WORKER}/tsconfig.client.json`,
    ]);
    expect({ code, output }).toMatchObject({ code: 0 });
  }, 120_000);

  test("still lints clean", async () => {
    const { code, output } = await run(dir, biome(dir), ["check", "."]);
    expect({ code, output }).toMatchObject({ code: 0 });
  }, 60_000);
});
