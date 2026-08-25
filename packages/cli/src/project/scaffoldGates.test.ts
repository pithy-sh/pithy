// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "comment-json";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runAdd } from "../capabilities/flow";
import { localDevStateRoot, localDevStorePath } from "../devSecrets/store";
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
      account: null,
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

  test("runs the gates the front end seeds — in a project with no alias of the kit's in the path", async () => {
    // **The half that was missing, and the reason it mattered (#441).** `pithy ui add` seeds test files
    // into the adopter's repository — that is the whole of `docs/CONVENTIONS.md` § *Seeded files* — and
    // nothing here had ever run one. The suite above runs `vitest` before the front end exists, so every
    // seeded gate was proven only in `@pithy-sh/ui-react`, whose own Vitest config aliases the
    // `virtual:pithy/*` modules to stubs. A gate that reaches one of those resolves here and nowhere
    // else: `src/client.test.tsx` shipped in exactly that state, green in the kit and red on the first
    // `vitest run` in every repository it was written into.
    //
    // So this runs them where they will actually run. The scaffolded project has no alias of ours, so a
    // seeded gate that needs one fails here — which is the point, and is what a unit test over the
    // template text cannot see.
    // `--reporter=verbose` because the default one prints counts and no names on a green run, and the
    // name is the assertion: `passWithNoTests` is on in the starter, so an `include` that admits no
    // `.tsx` exits 0 with the whole front end untested — #245's other half, and silent by construction.
    const { code, output } = await run(dir, vitest(dir), ["run", "--reporter=verbose"]);
    expect({ code, output }).toMatchObject({ code: 0 });
    for (const gate of ["src/client.test.tsx", "src/pithy-locale.test.tsx", "src/router.test.tsx"]) {
      expect(output, `the scaffolded runner never collected ${gate}`).toContain(gate);
    }
  }, 180_000);

  /**
   * **#399's three contracts, each a relative path frozen into a file the adopter owns.**
   *
   * They were declined in #391's sweep, and the reason was the same for all three: the invariant is a
   * fact about *where the Worker sits in a scaffolded project*, not a fact about the template's text.
   * `../../` is right relative to `apps/<worker>/` and wrong anywhere else, and a unit test over the
   * template can only assert the string reads `"../../.wrangler/state"` — which is what a rename of the
   * layout sails straight through. So the gate belongs here, where a real layout exists to resolve
   * against, and the ledger in `packages/ui-react/src/seededGates.test.ts` names this file.
   */

  test("the client's local state resolves to the project's store, not this worker's", async () => {
    // `persistState` is a depth, and a wrong one is silent in the worst way: each Worker gets its own
    // Miniflare directory, so two Workers sharing a D1 binding read two separate copies of it. Nothing
    // errors. Rows written through one are simply not there in the other.
    const config = await readFile(join(dir, "apps", WORKER, "vite.config.ts"), "utf8");
    const declared = /persistState:\s*\{\s*path:\s*"([^"]+)"\s*\}/.exec(config)?.[1];
    expect(declared, "vite.config.ts no longer declares a persistState path").toBeTypeOf("string");
    // Resolved from the Worker's real directory in a real scaffold — the whole point, and the thing a
    // literal-presence assertion cannot do.
    const resolved = resolve(join(dir, "apps", WORKER), declared ?? "");
    // The other subject, and this test writes down no expectation of its own: `localDevStorePath` is
    // where `pithy seed` and `pithy migrate` put a project's local D1, `v3/d1` under the store root.
    // Two independent statements about one directory, made to agree from a scaffolded layout.
    //
    // A third statement exists — `dev/orchestrator.ts` builds the same root for `wrangler dev
    // --persist-to` — and is not reachable from here without exporting it. Filed as #404.
    expect(resolved).toBe(dirname(dirname(localDevStorePath(dir))));
    // And the same directory, from the function that is now its only statement. `#404` closed the third
    // derivation — `dev/orchestrator.ts` composed `join(projectDir, ".wrangler", "state")` itself — so
    // this asserts the template against the root rather than against a path two `dirname`s away from a
    // deeper one. A composed copy reappearing anywhere fails here without also having to guess where.
    expect(resolved).toBe(localDevStateRoot(dir));
  });

  test("each composite program writes its own build state, under the project's dist/", async () => {
    // The mild one of the three: two composite programs pointing at one `.tsbuildinfo` overwrite each
    // other's state on every build. It costs time and never correctness — which is exactly why nobody
    // would ever find it, and why it is worth one assertion rather than an argument.
    const programs = ["tsconfig.json", "tsconfig.client.json", "tsconfig.node.json"];
    const declared = new Map<string, string>();
    for (const program of programs) {
      const config = parse(await readFile(join(dir, "apps", WORKER, program), "utf8")) as unknown as {
        compilerOptions: { tsBuildInfoFile?: string };
      };
      const path = config.compilerOptions.tsBuildInfoFile;
      expect(path, `${program} is composite and names no tsBuildInfoFile`).toBeTypeOf("string");
      declared.set(program, resolve(join(dir, "apps", WORKER), path ?? ""));
    }
    for (const [program, path] of declared) {
      // Resolved, not matched. The project's `dist/`, which `.gitignore` covers — never this Worker's,
      // because Vite empties `apps/<worker>/dist` on every client build and would throw the state away.
      expect(dirname(path), `${program}'s build state lands outside the project's dist/`).toBe(join(dir, "dist"));
    }
    expect(new Set(declared.values()).size, "two programs share one .tsbuildinfo").toBe(programs.length);
    // And the declared path is where tsc actually wrote. The client program was built above, so its
    // state is on disk now — which is what turns a resolution into a fact.
    const built = await readdir(join(dir, "dist"));
    expect(built).toContain(basename(declared.get("tsconfig.client.json") ?? ""));
  });

  test("a screen with a type error fails the client build — the program is not empty", async () => {
    // **The worst of the three, and the only one whose failure mode is a green build that checked
    // nothing.** Narrow `tsconfig.client.json`'s `include` and `tsc -b` reports success over a program
    // that resolved no files, while the project's solution file still references it. `bun run
    // typecheck` stays green and the client's whole typecheck is gone. No output changes.
    //
    // So the gate plants a defect rather than reading the `include` array: a client file with a type
    // error must fail the client build. A program compiling nothing cannot fail, which is the point,
    // and it is the one shape no assertion about the template's text can take.
    //
    // Under `routes/app/`, deliberately, and the location is the whole gate. `composite` makes tsc
    // refuse a file imported but not listed (TS6307), so most narrowings are *loud* — planting
    // `include: ["src/client.tsx", "client-env.d.ts"]` fails the build with an error naming
    // `client.tsx`. The router reaches screens through `import.meta.glob` instead, so no static import
    // pulls them in and TS6307 never fires: `include: ["src/*.tsx", "client-env.d.ts"]` exits 0 with
    // empty output while every screen in the project goes unchecked. That is the silent one, and a
    // probe anywhere else would not see it.
    const probe = join(dir, "apps", WORKER, "src", "routes", "app", "probe.tsx");
    await writeFile(probe, 'export const probe: number = "not a number";\n');
    try {
      const { code, output } = await run(dir, tsc(dir), ["-b", "--force", `apps/${WORKER}/tsconfig.client.json`]);
      expect({ code, output }).not.toMatchObject({ code: 0 });
      expect(output).toContain("probe.tsx");
    } finally {
      await rm(probe, { force: true });
    }
  }, 120_000);

  test("and the client build is green again once it is removed", async () => {
    // The other half of the reading above. Without it, a client build failing for some unrelated
    // reason — a broken link farm, a compiler that will not start — would satisfy the planted defect
    // and the gate would report a defect it never actually planted.
    const { code, output } = await run(dir, tsc(dir), ["-b", "--force", `apps/${WORKER}/tsconfig.client.json`]);
    expect({ code, output }).toMatchObject({ code: 0 });
  }, 120_000);
});

/**
 * **One React, proven by planting a second one (#447).**
 *
 * Nothing under `@pithy-sh/*` is published, so an adopter consumes the kit from a sibling checkout by
 * symlink — and Vite resolves a symlinked package from its realpath, so a kit package importing `react`
 * gets the *kit checkout's* copy. Two Reacts is `invalid hook call` on the first kit component the
 * project mounts, and the stack blames that component (`TranslatorProvider`, `useNegotiatedLocale`)
 * rather than the resolution. Nobody debugs it from the error.
 *
 * `templates/starter/vitest.config.ts` answers it with an explicit `resolve.alias`, and the reason it is
 * an alias rather than `resolve.dedupe` is the whole subtlety: `dedupe` re-resolves the names it is given
 * from Vite's **root**, and this config's root is the project root, where React is not installed. It
 * finds nothing and changes nothing, silently — which is worse than nothing, because it reads as covered.
 *
 * **So this plants the second React rather than reading the config's text.** A linked checkout with its
 * own `node_modules/react` and one package inside it, symlinked into the project exactly as a linked kit
 * is; a seeded `.tsx` test asserting the project and that package hold one React; and then the same run
 * again with the alias removed, which must fail. A gate that only asserts the alias is present cannot
 * tell a rule that resolves from a rule that resolves nothing, and that distinction *is* the bug.
 *
 * Only `react` is duplicated. `react-dom` fails the same way and is aliased for the same reason, but one
 * duplicated package is enough to prove the resolution and a second would prove it twice.
 */
describe("one React, however many checkouts the packages live in", () => {
  /** The line the starter states the rule on. Stripped below, and a miss is a failure rather than a pass. */
  const ALIAS = "resolve: { alias: ONE_REACT },";

  // Empty until `beforeAll` says otherwise, so the teardown below removes nothing it never made.
  let linked = "";
  let config = "";
  let configPath = "";
  let seeded = "";

  beforeAll(async () => {
    linked = await mkdtemp(join(tmpdir(), "pithy-linked-"));

    // The second React. It only has to be a package named `react` that the resolver reaches first from
    // inside this checkout — what the assertion reads is whether the project's real one displaced it.
    const second = join(linked, "node_modules", "react");
    await mkdir(second, { recursive: true });
    await writeFile(
      join(second, "package.json"),
      JSON.stringify({ name: "react", version: "19.2.8", type: "module", main: "index.js" }),
    );
    await writeFile(join(second, "index.js"), "export const theOtherCheckoutsCopy = true;\n");

    // The linked package, shaped like a kit package: raw TypeScript reached through a `./src/*` export.
    const widget = join(linked, "widget");
    await mkdir(join(widget, "src"), { recursive: true });
    await writeFile(
      join(widget, "package.json"),
      JSON.stringify({ name: "linked-widget", version: "0.0.0", type: "module", exports: { "./src/*": "./src/*.ts" } }),
    );
    await writeFile(
      join(widget, "src", "hook.ts"),
      'import * as React from "react";\n\nexport const reactTheLinkedPackageGot = React;\n',
    );
    await symlink(widget, join(dir, "node_modules", "linked-widget"));

    // A `.tsx` test, because `.tsx` is what a front end's tests are and what the node project had to be
    // taught to collect (#245). It renders nothing: two module namespaces either are one object or are not.
    seeded = join(dir, "apps", WORKER, "src", "one-react.test.tsx");
    await writeFile(
      seeded,
      [
        'import * as React from "react";',
        'import { reactTheLinkedPackageGot } from "linked-widget/src/hook";',
        'import { expect, test } from "vitest";',
        "",
        'test("the linked package and this project hold one React", () => {',
        '  expect(typeof React.useMemo).toBe("function");',
        "  expect(reactTheLinkedPackageGot.useMemo).toBe(React.useMemo);",
        "});",
        "",
      ].join("\n"),
    );

    configPath = join(dir, "vitest.config.ts");
    config = await readFile(configPath, "utf8");
  }, 60_000);

  afterAll(async () => {
    if (seeded !== "") await rm(seeded, { force: true });
    if (linked !== "") {
      await rm(join(dir, "node_modules", "linked-widget"), { force: true });
      await rm(linked, { recursive: true, force: true });
    }
    // Restored whatever happened above, so nothing added after this block inherits a stripped config.
    if (config !== "") await writeFile(configPath, config);
  });

  test("a linked package resolves the project's React, not the one beside it", async () => {
    const { code, output } = await run(dir, vitest(dir), ["run", "--project=node", "--reporter=verbose", "one-react"]);
    expect({ code, output }).toMatchObject({ code: 0 });
    // `passWithNoTests` is on, so a filter that matched nothing would exit 0 with the whole gate unrun.
    expect(output, "the seeded runner never collected one-react.test.tsx").toContain("one-react.test.tsx");
  }, 180_000);

  test("and the alias is what does it — remove it and the second copy wins", async () => {
    // The half that separates a rule which resolves from a rule which resolves nothing. Without it this
    // file would pass just as happily against `resolve: { dedupe: [...] }`, which is the defect.
    const stripped = config.replace(ALIAS, "");
    expect(stripped, `templates/starter/vitest.config.ts no longer states \`${ALIAS}\``).not.toBe(config);
    await writeFile(configPath, stripped);
    try {
      const { code, output } = await run(dir, vitest(dir), ["run", "--project=node", "one-react"]);
      expect({ code, output }).not.toMatchObject({ code: 0 });
      // Failed for the stated reason, not because the run fell over. A config that no longer loads, or a
      // runner that never started, would satisfy a bare non-zero and prove nothing at all.
      expect(output).toContain("one-react.test.tsx");
      expect(output).toContain("the linked package and this project hold one React");
    } finally {
      await writeFile(configPath, config);
    }
  }, 180_000);
});

/**
 * **The three answers the fixture above never reaches (#447).**
 *
 * `oneReact` in `templates/starter/vitest.config.ts` walks `apps/*` in name order and takes the first
 * Worker that resolves both React packages. The scaffolded fixture has one Worker and resolves it on the
 * first iteration, so three of the function's four exits run in no gate: no `apps/` at all, a Worker that
 * resolves nothing and is skipped, and no Worker resolving anything. An unrun `continue` is the same
 * defect the alias exists to fix — a rule that reads as covered while resolving nothing.
 *
 * **And an empty `apps/<name>/` added to that fixture would not reach them.** Node resolves outward, the
 * link farm puts React in the project's own `node_modules`, and hoisting to the root is what npm and pnpm
 * do — so *every* directory under `apps/` resolves React there and the skip never happens. The skip is
 * real in the other layout, Bun's, where a workspace member's dependencies sit beside the member and a
 * Worker with no front end genuinely has no React above it. That is the layout built here.
 *
 * So this copies the template into throwaway roots and imports it. `PROJECT_ROOT` is that file's own
 * directory, which is what makes a copy a different project; each root holds a `node_modules` with
 * `vitest` alone, enough for the config's own import and deliberately no React, so nothing above `apps/`
 * answers. The exported config's alias list is the whole assertion — nothing is spawned, nothing is run.
 */
describe("the starter's alias when there is no React to point at", () => {
  /** `vitest` where this test file resolves it, which is the copy the copied config will import. */
  const VITEST = dirname(createRequire(import.meta.url).resolve("vitest/package.json"));

  const roots: string[] = [];

  /** A throwaway project root holding the starter's `vitest.config.ts` and nothing that resolves React. */
  async function starterRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pithy-onereact-"));
    roots.push(root);
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(VITEST, join(root, "node_modules", "vitest"));
    await cp(join(REPO, "templates", "starter", "vitest.config.ts"), join(root, "vitest.config.ts"));
    return root;
  }

  /** The alias rules the copied config resolved, read off the `node` project it is stated on. */
  async function aliasIn(root: string): Promise<{ find: RegExp; replacement: string }[]> {
    const module = (await import(join(root, "vitest.config.ts"))) as {
      default: { test: { projects: [{ resolve: { alias: { find: RegExp; replacement: string }[] } }] } };
    };
    return module.default.test.projects[0].resolve.alias;
  }

  /** A Worker with a front end: both packages beside it, as a workspace install leaves them. */
  async function withReact(worker: string): Promise<void> {
    for (const name of ["react", "react-dom"]) {
      const pkg = join(worker, "node_modules", name);
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name, version: "19.2.8", main: "index.js" }));
    }
  }

  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  test("a project with no apps/ at all resolves nothing, and does not throw doing it", async () => {
    // The defensive exit, and a scaffolded project never reaches it: `scaffoldProject` copies the whole
    // starter in one pass, `apps/api/` included, so the config and a Worker land together. What reaches
    // it is a config copied into a project that has no `apps/` yet — an adopter pasting the block in by
    // hand, following docs/UI.md § One React. Empty rather than a throw, because this file is the
    // adopter's and a missing directory is not a reason to fail their whole suite.
    expect(await aliasIn(await starterRoot())).toEqual([]);
  });

  test("a Worker with no React is skipped, and the next one answers", async () => {
    // The `continue`, and the reason the loop is a loop. `admin` sorts before `board` and has no front
    // end; a function that took the first *directory* rather than the first that resolves would alias
    // nothing here and leave every `.tsx` test on whatever the linked checkout brought.
    const root = await starterRoot();
    await mkdir(join(root, "apps", "admin"), { recursive: true });
    await mkdir(join(root, "apps", "board"), { recursive: true });
    await withReact(join(root, "apps", "board"));

    const alias = await aliasIn(root);
    expect(alias).toHaveLength(4);
    for (const rule of alias) {
      expect(rule.replacement, "the alias points somewhere other than the Worker that has React").toContain(
        join("apps", "board", "node_modules"),
      );
    }
  });

  test("apps/ with no React anywhere under it resolves nothing", async () => {
    // The exit after the loop. A backend-only project has Workers and no client, and this file is in it
    // either way — silence is the answer, and it is asserted rather than assumed.
    const root = await starterRoot();
    await mkdir(join(root, "apps", "admin"), { recursive: true });
    expect(await aliasIn(root)).toEqual([]);
  });
});
