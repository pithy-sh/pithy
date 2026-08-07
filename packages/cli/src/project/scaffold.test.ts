// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { PACKAGE_NAME, PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ejectCapability } from "../capabilities/eject";
import { defaultRemoveSteps } from "../capabilities/remove";
import { wireFeatureDevVars } from "../feature/devVars";
import { writeSeedArtifact } from "../seed/prepare";
import { scaffoldFiles } from "../ui/scaffold";
import {
  ensureEmptyTarget,
  ensureScaffoldable,
  ensureScaffoldPath,
  kitRange,
  pathExists,
  RENAMED_ON_LANDING,
  removeScaffoldPath,
  resolveTemplateSource,
  scaffoldProject,
  templateContents,
  unpublishedKitNotice,
} from "./scaffold";
import { committedFiles } from "./templateFiles";
import { addWorker, removeWorker } from "./workerCommand";
import { scaffoldWorker } from "./workerScaffold";

/** The template manifest the stamp rewrites — read directly, to hold the template to what the rule covers. */
const TEMPLATE_WORKER_PACKAGE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../templates/starter/apps/api/package.json",
);

/** The `@pithy-sh/*` dependency names in a manifest's `dependencies`. */
function kitDependencies(manifest: { dependencies?: Record<string, string> }): string[] {
  return Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@pithy-sh/"));
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-init-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scaffoldProject", () => {
  test("writes the root project files and the first worker under apps/", async () => {
    const target = join(dir, "my-app");
    await scaffoldProject({ targetDir: target, appName: "my-app" });

    // Root: identity + policy + the apps/* workspace. No worker lives here.
    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
    expect(pkg.workspaces).toEqual(["apps/*"]);
    const rootConfig = await readFile(join(target, "pithy.config.ts"), "utf8");
    expect(rootConfig).toContain('name: "my-app"');
    // Capabilities are per-worker — the root config must not declare the array (prose about it is fine).
    expect(rootConfig).not.toMatch(/^\s*capabilities:\s*\[/m);
    await expect(readFile(join(target, "wrangler.jsonc"), "utf8")).rejects.toThrow();

    // The first worker: its own config, wrangler, manifest, and entrypoint.
    const api = join(target, "apps", "api");
    expect(JSON.parse(await readFile(join(api, "package.json"), "utf8")).name).toBe("my-app-api");
    expect(await readFile(join(api, "wrangler.jsonc"), "utf8")).toContain('"name": "my-app-api"');
    expect(await readFile(join(api, "pithy.config.ts"), "utf8")).toContain("// pithy:capabilities");
    await readFile(join(api, "pithy.worker.jsonc"), "utf8");
    await readFile(join(api, "src", "index.ts"), "utf8");
    await readFile(join(api, "tsconfig.json"), "utf8");

    // gitignore ships unprefixed (npm strips dotfiles) and lands as .gitignore.
    expect(await readFile(join(target, ".gitignore"), "utf8")).toContain(".dev.vars");
    await readFile(join(target, ".dev.vars.example"), "utf8");
  });

  test("writes the three gates, and a solution file that keeps the type worlds apart", async () => {
    // A scaffold with `dev` and `deploy` and nothing else cannot be checked by CI at all, and the adopter
    // who wires it discovers the hard part unaided: the Worker and a client cannot share one program.
    await scaffoldProject({ targetDir: dir, appName: "gated" });

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts).toMatchObject({ typecheck: "tsc -b", test: "vitest run", lint: "biome check ." });
    // Every gate's tool is declared, or the first `bun install` leaves three scripts that cannot run.
    expect(Object.keys(pkg.devDependencies)).toEqual(
      expect.arrayContaining(["@biomejs/biome", "@cloudflare/vitest-pool-workers", "typescript", "vitest"]),
    );

    // `tsc -b` needs a solution file: `files: []` and references, never one program over both worlds.
    const solution = parse(await readFile(join(dir, "tsconfig.json"), "utf8")) as unknown as {
      files: string[];
      references: { path: string }[];
    };
    expect(solution.files).toEqual([]);
    expect(solution.references.map((reference) => reference.path)).toEqual([
      "./tsconfig.tools.json",
      "./apps/api/tsconfig.json",
    ]);

    // Referenced means composite, and composite means build state — under the project's dist/, which the
    // gitignore already covers, and never under a Worker's, which Vite empties on every client build.
    const worker = parse(await readFile(join(dir, "apps", "api", "tsconfig.json"), "utf8")) as unknown as {
      compilerOptions: { composite: boolean; tsBuildInfoFile: string };
    };
    expect(worker.compilerOptions.composite).toBe(true);
    expect(worker.compilerOptions.tsBuildInfoFile).toBe("../../dist/api.server.tsbuildinfo");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toMatch(/^dist\/$/m);

    await readFile(join(dir, "biome.jsonc"), "utf8");
    await readFile(join(dir, "vitest.config.ts"), "utf8");
    await readFile(join(dir, "vitest.workers.config.ts"), "utf8");
    await readFile(join(dir, "tsconfig.tools.json"), "utf8");
  });

  test("ships the logging gate, registered in the project's own biome config", async () => {
    // The gate is a scaffolded default, not something Pithy enforces from outside: both halves land in
    // the adopter's repo, so they can narrow the scope or delete the pair. It ships on because a Worker
    // that logs through console is a Worker whose logs cannot be filtered, and nobody discovers that
    // until they need to.
    await scaffoldProject({ targetDir: dir, appName: "logged" });

    // The plugin file names the replacement — a gate that only prohibits gets ignored.
    const plugin = await readFile(join(dir, "plugins", "no-console.grit"), "utf8");
    expect(plugin).toContain("createWorkerLogger");

    const biome = parse(await readFile(join(dir, "biome.jsonc"), "utf8")) as unknown as {
      plugins: { path: string; includes: string[] }[];
    };
    const gate = biome.plugins.find((plugin) => plugin.path === "plugins/no-console.grit");
    // `apps/<worker>/src`, never `packages/*` — a scaffolded project has no packages/ at all, and the
    // Worker's own program is the `.ts` half of that directory. `.tsx` is the client.
    expect(gate?.includes).toEqual(["**/apps/*/src/**/*.ts", "!**/*.test.ts"]);

    // The sibling gate ships with it. `process.stdout.write` is the same hole reached through a Node
    // habit rather than a browser one, and an adopter who gets one rule and not the other learns the
    // convention half-way — which is how the second one arrives in a Workflow six months later.
    const streams = await readFile(join(dir, "plugins", "no-process-io.grit"), "utf8");
    expect(streams).toContain("createWorkerLogger");
    const streamGate = biome.plugins.find((plugin) => plugin.path === "plugins/no-process-io.grit");
    expect(streamGate?.includes).toEqual(["**/apps/*/src/**/*.ts", "!**/*.test.ts"]);
  });

  test("points the solution file and the build state at the worker's real name", async () => {
    // Both strings name `apps/api` in the template. Left unstamped, `tsc -b` fails on a reference to a
    // directory that does not exist — so `--worker` alone would break the typecheck gate it just wrote.
    await scaffoldProject({ targetDir: dir, appName: "acme", worker: "edge" });

    const solution = parse(await readFile(join(dir, "tsconfig.json"), "utf8")) as unknown as {
      references: { path: string }[];
    };
    expect(solution.references.map((reference) => reference.path)).toContain("./apps/edge/tsconfig.json");

    const worker = parse(await readFile(join(dir, "apps", "edge", "tsconfig.json"), "utf8")) as unknown as {
      compilerOptions: { tsBuildInfoFile: string };
    };
    // Per worker, because two composite programs sharing one build-state file overwrite each other's.
    expect(worker.compilerOptions.tsBuildInfoFile).toBe("../../dist/edge.server.tsbuildinfo");
  });

  test("scaffolds the first worker under the chosen name, not the default", async () => {
    await scaffoldProject({ targetDir: dir, appName: "acme", worker: "edge" });

    // The directory, the deploy name, and the package name all follow the chosen worker.
    expect(await readFile(join(dir, "apps", "edge", "wrangler.jsonc"), "utf8")).toContain('"name": "acme-edge"');
    expect(JSON.parse(await readFile(join(dir, "apps", "edge", "package.json"), "utf8")).name).toBe("acme-edge");
    await readFile(join(dir, "apps", "edge", "pithy.config.ts"), "utf8");
    // No leftover of the template's default worker.
    await expect(readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")).rejects.toThrow();
  });

  test("rejects a worker name that could not be a directory under apps/", async () => {
    await expect(scaffoldProject({ targetDir: dir, appName: "acme", worker: "Edge_Worker" })).rejects.toThrow(
      PithyError,
    );
  });

  test("the scaffolded worker carries dev, staging, and production config paths", async () => {
    await scaffoldProject({ targetDir: dir, appName: "envs" });
    const wrangler = await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"staging"');
    expect(wrangler).toContain('"prod"');
  });

  test("stamps PROJECT in every vars stanza, so the first worker can mint attributable assets", async () => {
    // Media mints Cloudflare Images/Stream uploads from this Worker, and those stores are account-flat —
    // an asset carries no name we chose, only the owner in its metadata. `assetOwner` refuses to mint
    // without `PROJECT`, so a scaffolded Worker that lacks it 500s on the first upload.
    await scaffoldProject({ targetDir: dir, appName: "acme" });
    const wrangler = parse(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")) as unknown as {
      vars: Record<string, string>;
      env: Record<string, { vars: Record<string, string> }>;
    };

    // `env.<name>.vars` replaces the top-level `vars` rather than merging, so all three stanzas carry it.
    expect(wrangler.vars?.PROJECT).toBe("acme");
    expect(wrangler.env.staging?.vars?.PROJECT).toBe("acme");
    expect(wrangler.env.prod?.vars?.PROJECT).toBe("acme");
  });

  test("the stamped PROJECT is the name requireProjectName resolves, not the raw input", async () => {
    // The Worker's stamp and the CLI's resource names must be the same string, or a sweep filtering on
    // `<project>-` finds nothing the Worker minted. `requireProjectName` kebabs, so the scaffold does too.
    await scaffoldProject({ targetDir: dir, appName: "Launch 2026" });
    const wrangler = parse(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")) as unknown as {
      vars: Record<string, string>;
    };
    expect(wrangler.vars?.PROJECT).toBe("launch-2026");
  });

  test("enables Workers Logs by default — Mode 2 structured logs are queryable with no adopter setup", async () => {
    await scaffoldProject({ targetDir: dir, appName: "obs" });
    const wrangler = parse(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")) as unknown as {
      observability?: { enabled?: boolean; head_sampling_rate?: number };
    };
    expect(wrangler.observability?.enabled).toBe(true);
    expect(wrangler.observability?.head_sampling_rate).toBe(1);
  });

  test("scaffolds into an existing empty directory", async () => {
    await scaffoldProject({ targetDir: dir, appName: "empty-ok" });
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("empty-ok");
  });

  test("normalizes a name with replacement-pattern characters instead of stamping it raw", async () => {
    // `$&`, `$1`, `$\`` are special in String.replace's replacement string, and none of them is legal in a
    // Cloudflare name. `assertValidProjectName` accepts this because it tests the kebabed form, so the
    // scaffold must stamp that same form — writing the raw string produced a wrangler.jsonc wrangler
    // refuses to parse ("alphanumeric and lowercase with dashes only").
    await scaffoldProject({ targetDir: dir, appName: "app-$&-$1-x" });
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("app-1-x");
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toContain('name: "app-1-x"');
    expect(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")).toContain('"name": "app-1-x-api"');
  });

  test("lowercases the name everywhere it is stamped, so the project can deploy", async () => {
    // wrangler rejects `"name": "Acme-api"` at config-parse time, which broke every wrangler command in
    // the worker — deploy and `wrangler dev` alike. The guard accepts `Acme` (it kebabs first), so the
    // only thing that kept the scaffold honest was stamping the kebabed form.
    await scaffoldProject({ targetDir: dir, appName: "Acme" });
    const wrangler = await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"name": "acme-api"');
    expect(wrangler).toContain('"PROJECT": "acme"');
    // Nothing uppercase survived into either stamped value — the assertions above would still pass if a
    // second `"name"` or `"PROJECT"` carried the typed form.
    expect(wrangler.match(/"(?:name|PROJECT)": "[^"]*"/g)).not.toContain('"name": "Acme-api"');
    for (const stamp of wrangler.match(/"(?:name|PROJECT)": "([^"]*)"/g) ?? []) {
      expect(stamp, stamp).not.toMatch(/: "[^"]*[A-Z]/);
    }
    // The config shows the adopter the exact string every resource name leads with — not what they typed.
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toContain('name: "acme"');
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("acme");
  });

  test("refuses the reserved pithy-int- prefix, and leaves nothing behind", async () => {
    const target = join(dir, "reserved");
    await expect(scaffoldProject({ targetDir: target, appName: "pithy-int-test" })).rejects.toThrow(PithyError);
    // The guard runs before the directory is even created — a refusal must not leave a half-scaffold.
    await expect(readFile(join(target, "package.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("the reservation is read after kebabing, so a spaced or capitalised variant is caught too", async () => {
    await expect(scaffoldProject({ targetDir: dir, appName: "Pithy Int Suite" })).rejects.toThrow(PithyError);
  });

  test("refuses the bare `pithy-int`, which composes `pithy-int-dev-db` and so is inside the namespace", async () => {
    // The name is not itself prefixed by `pithy-int-`; the composer's trailing hyphen puts every name it
    // generates in the reservation. A `startsWith` on the raw name would wave it through.
    await expect(scaffoldProject({ targetDir: dir, appName: "pithy-int" })).rejects.toThrow(PithyError);
  });

  test("a name that merely mentions pithy is fine — only the reserved prefix is refused", async () => {
    await scaffoldProject({ targetDir: dir, appName: "pithy-internal-tools" });
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("pithy-internal-tools");
  });

  test("refuses a project name that doesn't start with a letter, and leaves nothing behind", async () => {
    // `mkdir 1password-clone && pithy init` took the directory basename as the project name and scaffolded
    // happily. Every Cloudflare name it then composed was legal right up to the first host-worker deploy,
    // which refused it — after D1, KV, and R2 already existed. The refusal belongs here, before the copy.
    const target = join(dir, "1password-clone");
    await expect(scaffoldProject({ targetDir: target, appName: "1password-clone" })).rejects.toThrow(PithyError);
    await expect(readFile(join(target, "package.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("the rule is read after kebabing, so a spaced or capitalised name is judged as Cloudflare sees it", async () => {
    await expect(scaffoldProject({ targetDir: dir, appName: "2026 Launch" })).rejects.toThrow(PithyError);
    // The same shape with a letter in front is fine — this refuses illegal names, not unusual ones. And
    // since the rule was read after kebabing, the scaffold writes the kebabed form: `Launch 2026` is not a
    // legal npm package name either, so stamping it raw broke `bun install` as well as `wrangler deploy`.
    await scaffoldProject({ targetDir: dir, appName: "Launch 2026" });
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("launch-2026");
    expect(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")).toContain('"name": "launch-2026-api"');
  });

  test("refuses a target that already holds a file it would write", async () => {
    await writeFile(join(dir, "package.json"), "mine");
    await expect(scaffoldProject({ targetDir: dir, appName: "nope" })).rejects.toThrow(PithyError);
    // The adopter's file is untouched.
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe("mine");
    await expect(readFile(join(dir, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("scaffolds into a freshly cloned repo — a clone is how a project normally starts", async () => {
    // .git, a README, a licence, an editor config, and a CLAUDE.md. None of them is a project, and
    // refusing them meant `pithy init` could not run in the repo the adopter had just made for it.
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(dir, "README.md"), "# acme\n");
    await writeFile(join(dir, "LICENSE"), "MIT\n");
    await writeFile(join(dir, ".editorconfig"), "root = true\n");
    await writeFile(join(dir, "CLAUDE.md"), "rules\n");

    await scaffoldProject({ targetDir: dir, appName: "acme" });

    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("acme");
    await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8");
    // Everything that was there stays there.
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("# acme\n");
    expect(await readFile(join(dir, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  });

  test("merges into an existing apps/api rather than refusing it, and keeps what was there", async () => {
    // The default worker is copied, not renamed, so a directory that already exists is merged into.
    // Collision, not emptiness: only a file the template writes is in the way.
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "NOTES.md"), "mine\n");

    await scaffoldProject({ targetDir: dir, appName: "acme" });

    expect(await readFile(join(dir, "apps", "api", "NOTES.md"), "utf8")).toBe("mine\n");
    expect(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")).toContain('"name": "acme-api"');
  });

  test("refuses an occupied apps/<worker> instead of crashing mid-copy, and leaves nothing behind", async () => {
    // The rename target holds a file the template never writes, so no *file* collides — and the
    // rename then died on ENOTEMPTY as a raw Error, after package.json and pithy.config.ts had
    // already landed. A half-scaffolded repo, and a stack trace where the error envelope belongs.
    await mkdir(join(dir, "apps", "edge"), { recursive: true });
    await writeFile(join(dir, "apps", "edge", "NOTES.md"), "mine\n");

    await expect(scaffoldProject({ targetDir: dir, appName: "acme", worker: "edge" })).rejects.toThrow(PithyError);

    expect(await readdir(dir)).toEqual(["apps"]);
    expect(await readdir(join(dir, "apps"))).toEqual(["edge"]);
    expect(await readFile(join(dir, "apps", "edge", "NOTES.md"), "utf8")).toBe("mine\n");
  });

  test("refuses an occupied apps/api when another worker is named — the rename would sweep it along", async () => {
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "NOTES.md"), "mine\n");

    await expect(scaffoldProject({ targetDir: dir, appName: "acme", worker: "edge" })).rejects.toThrow(PithyError);
    expect(await readFile(join(dir, "apps", "api", "NOTES.md"), "utf8")).toBe("mine\n");
  });

  test("refuses a file where the scaffold needs a directory, and leaves nothing behind", async () => {
    await writeFile(join(dir, "apps"), "mine\n");
    await expect(scaffoldProject({ targetDir: dir, appName: "acme" })).rejects.toThrow(PithyError);
    expect(await readdir(dir)).toEqual(["apps"]);
    expect(await readFile(join(dir, "apps"), "utf8")).toBe("mine\n");
  });

  test("refuses a dangling symlink at a template path, and writes nothing outside the target", async () => {
    // The severity is the write, not the trigger: with the gate following the link, `cp` and
    // `stampPackageName` wrote the scaffolded package.json to wherever the link pointed — outside
    // targetDir — while the run reported success.
    const outside = join(dir, "outside", "package.json");
    await mkdir(join(dir, "outside"), { recursive: true });
    const target = join(dir, "my-app");
    await mkdir(target, { recursive: true });
    await symlink(outside, join(target, "package.json"));

    await expect(scaffoldProject({ targetDir: target, appName: "my-app" })).rejects.toThrow(PithyError);
    await expect(readFile(outside, "utf8")).rejects.toThrow();
  });

  test("refuses an adopter's undotted gitignore — the template's copy lands on it, then renames it away", async () => {
    await writeFile(join(dir, "gitignore"), "mine\n");
    await expect(scaffoldProject({ targetDir: dir, appName: "acme" })).rejects.toThrow(PithyError);
    expect(await readFile(join(dir, "gitignore"), "utf8")).toBe("mine\n");
  });

  test("writes a kit range that resolves, or none at all — the first bun install must not 404", async () => {
    await scaffoldProject({ targetDir: dir, appName: "acme", worker: "board" });

    const pkg = JSON.parse(await readFile(join(dir, "apps", "board", "package.json"), "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
    };

    // Asserted through `kitRange`, not as the literal `[]` today's unpublished kit produces. The rule is
    // "never write a range that cannot resolve", and it has two sides: no dependency while `PACKAGE_VERSION`
    // is `0.0.0`, and the real range the moment a release moves it. Pinning the empty half would turn this
    // suite red on the release commit — the one commit least able to absorb a mystery failure — and the
    // fix would look like deleting the assertion that was doing its job.
    const range = kitRange(PACKAGE_VERSION);
    if (range === null) expect(kitDependencies(pkg)).toEqual([]);
    else {
      expect(kitDependencies(pkg)).toEqual([PACKAGE_NAME]);
      expect(pkg.dependencies[PACKAGE_NAME]).toBe(range);
    }
    // Only the unresolvable range goes. Everything else the worker declares is untouched.
    expect(pkg.dependencies.hono).toBeDefined();
    expect(pkg.name).toBe("acme-board");
  });

  test("links the worker at the project's one .dev.vars, so the runtime reads what pithy add mints", async () => {
    // wrangler loads `.dev.vars` from the worker's own directory and looks nowhere else. Without the link
    // a scaffolded project has a root file the runtime never opens, and every secret in it reports as
    // *absent* — so the adopter hunts for a value they already have.
    await scaffoldProject({ targetDir: dir, appName: "acme", worker: "board" });

    const link = join(dir, "apps", "board", ".dev.vars");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    // Read through it, not at it: what the worker sees is the one file the project shares.
    await writeFile(join(dir, ".dev.vars"), "SECRETS_ENCRYPTION_KEYS=k\n");
    expect(await readFile(link, "utf8")).toBe("SECRETS_ENCRYPTION_KEYS=k\n");
    // Relative, so the project survives being moved, copied or built in a container. An absolute link
    // into someone's home directory dangles the moment the tree does, and a dangling `.dev.vars` reads
    // as "every secret absent" — the failure this link exists to prevent.
    expect(isAbsolute(await readlink(link))).toBe(false);
  });

  test("the .dev.vars it creates is readable only by its owner", async () => {
    // `cp` carries the template's own mode, so the project's credential file landed 0664 whatever the
    // umask said. `pithy add` and `pithy token mint` write CLOUDFLARE_API_TOKEN and the secrets
    // encryption keys into this file.
    await scaffoldProject({ targetDir: dir, appName: "acme" });
    expect((await lstat(join(dir, ".dev.vars"))).mode & 0o777).toBe(0o600);
  });

  test("refuses when the worker already holds a .dev.vars — that file is git-ignored and has no other copy", async () => {
    const own = join(dir, "apps", "api", ".dev.vars");
    await mkdir(dirname(own), { recursive: true });
    await writeFile(own, "API_ONLY_SECRET=super-secret-value\n");

    const failure = await scaffoldProject({ targetDir: dir, appName: "acme" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toContain(join("apps", "api", ".dev.vars"));
    expect(await readFile(own, "utf8")).toBe("API_ONLY_SECRET=super-secret-value\n");
  });

  test("seeds the shared .dev.vars from the example, since a link needs a file to point at", async () => {
    await scaffoldProject({ targetDir: dir, appName: "acme" });
    expect(await readFile(join(dir, ".dev.vars"), "utf8")).toBe(await readFile(join(dir, ".dev.vars.example"), "utf8"));
  });

  test("never writes over a .dev.vars already in the target — those are the adopter's secrets", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_API_TOKEN=mine\n");
    await scaffoldProject({ targetDir: dir, appName: "acme" });
    expect(await readFile(join(dir, ".dev.vars"), "utf8")).toBe("CLOUDFLARE_API_TOKEN=mine\n");
    expect(await readFile(join(dir, "apps", "api", ".dev.vars"), "utf8")).toBe("CLOUDFLARE_API_TOKEN=mine\n");
  });

  test("the template declares only the kit package the stamp knows a version for", async () => {
    // The rule is narrow on purpose: Changesets versions these packages independently, so core's version
    // is a fact about core alone. A second kit dependency in the template would be stamped with a version
    // that is not its own — this fails first, and whoever adds it teaches the stamp that package's version.
    const template = JSON.parse(await readFile(TEMPLATE_WORKER_PACKAGE, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(kitDependencies(template)).toEqual([PACKAGE_NAME]);
  });
});

describe("kitRange", () => {
  test("no range while the kit is unpublished — 0.0.0 is on no registry", () => {
    expect(kitRange("0.0.0")).toBeNull();
  });

  test("the day the packages publish, the range is the version this CLI ships against", () => {
    expect(kitRange("1.4.2")).toBe("^1.4.2");
  });
});

describe("ensureScaffoldable", () => {
  test("a missing directory is fine — scaffoldProject creates it", async () => {
    await expect(ensureScaffoldable(join(dir, "nope"))).resolves.toBeUndefined();
  });

  test("an existing empty directory is fine", async () => {
    await expect(ensureScaffoldable(dir)).resolves.toBeUndefined();
  });

  test("files the template never writes are fine — .git and a README are not a project", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "README.md"), "");
    await writeFile(join(dir, ".editorconfig"), "");
    await expect(ensureScaffoldable(dir)).resolves.toBeUndefined();
  });

  test("names every colliding path, so the adopter knows what is in the way", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "mine");
    await mkdir(join(dir, "apps", "api", "src"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "src", "index.ts"), "mine");

    const error = await ensureScaffoldable(dir).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    const { message } = (error as PithyError).payload;
    expect(message).toContain("pithy.config.ts");
    expect(message).toContain(join("apps", "api", "src", "index.ts"));
  });

  test("the .gitignore the template lands as is checked under the name it lands under", async () => {
    // The template ships it as `gitignore` (npm strips dotfiles) and it is renamed on the way in.
    // Checking the shipped name would have waved an adopter's own .gitignore straight through.
    await writeFile(join(dir, ".gitignore"), "node_modules\n");
    await expect(ensureScaffoldable(dir)).rejects.toThrow(PithyError);
  });

  test("apps/api is checked whatever the first worker is called — the copy lands there, then renames", async () => {
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "wrangler.jsonc"), "mine");
    await expect(ensureScaffoldable(dir, "edge")).rejects.toThrow(PithyError);
    // And so is the name it will be renamed to.
    await rm(join(dir, "apps", "api"), { recursive: true });
    await mkdir(join(dir, "apps", "edge"), { recursive: true });
    await writeFile(join(dir, "apps", "edge", "wrangler.jsonc"), "mine");
    await expect(ensureScaffoldable(dir, "edge")).rejects.toThrow(PithyError);
  });

  test("an occupied apps/<worker> collides even when nothing in it is a template file", async () => {
    // Pithy renames `apps/api` onto this path and owns it outright for the length of the operation,
    // so emptiness is the question here — the file-by-file rule is the project root's, not this one's.
    await mkdir(join(dir, "apps", "edge"), { recursive: true });
    await writeFile(join(dir, "apps", "edge", "NOTES.md"), "mine");

    const error = await ensureScaffoldable(dir, "edge").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(join("apps", "edge"));
  });

  test("an empty apps/<worker> is fine — the rename replaces it", async () => {
    await mkdir(join(dir, "apps", "edge"), { recursive: true });
    await expect(ensureScaffoldable(dir, "edge")).resolves.toBeUndefined();
  });

  test("an occupied apps/api collides when another worker is named — the rename would carry it along", async () => {
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "NOTES.md"), "mine");
    await expect(ensureScaffoldable(dir, "edge")).rejects.toThrow(PithyError);
    // The same directory is fine for the default worker: that copy merges, and nothing is swept anywhere.
    await expect(ensureScaffoldable(dir)).resolves.toBeUndefined();
  });

  test("a file where a directory belongs collides — mkdir and cp both die on it", async () => {
    await writeFile(join(dir, "apps"), "mine");
    const error = await ensureScaffoldable(dir).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("apps");
  });

  test("a symlink where a directory belongs collides — cp refuses to copy a directory onto one", async () => {
    await mkdir(join(dir, "elsewhere"), { recursive: true });
    await symlink(join(dir, "elsewhere"), join(dir, "apps"), "dir");
    await expect(ensureScaffoldable(dir)).rejects.toThrow(PithyError);
  });

  test("the template's undotted gitignore is checked too — the copy lands on it before the rename", async () => {
    // `gitignore` (no dot) is a known git footgun and a file an adopter can genuinely have. The copy
    // overwrote it and the rename then moved it to `.gitignore`: gone, silently, from a gate whose
    // whole purpose is not to clobber.
    await writeFile(join(dir, "gitignore"), "mine\n");
    const error = await ensureScaffoldable(dir).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("gitignore");
  });

  test("a dangling symlink where a template file belongs collides — the copy writes through it", async () => {
    // `access` follows the link, so a dangling one read as "does not exist", cleared the gate, and was
    // never named in the refusal. Then `cp` and `stampPackageName` both wrote *through* it: the
    // scaffolded package.json landed outside targetDir. `lstat`, for the reason blocksDirectory gives —
    // the symlink itself is the problem. Node and Bun disagree on the copy here, which is worse, not
    // better: the unit tests and the shipped CLI would answer differently on the same input.
    const outside = join(dir, "outside", "package.json");
    await mkdir(dirname(outside), { recursive: true });
    const target = join(dir, "app");
    await mkdir(target, { recursive: true });
    await symlink(outside, join(target, "package.json"));

    const error = await ensureScaffoldable(target).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("package.json");
  });

  test("an unreadable directory refuses through PithyError, never a raw node:fs error", async () => {
    // `occupied` read the directory outside its try, so an EACCES escaped the PithyError contract this
    // module promises: `pithy init --json` printed a stack trace where a CI wrapper parses {"error":{…}}.
    // A directory that cannot be read is certainly occupied. Relies on the test NOT running as root,
    // where chmod has no effect — standard CI and dev are fine.
    const edge = join(dir, "apps", "edge");
    await mkdir(edge, { recursive: true });
    await chmod(edge, 0o000);

    const error = await ensureScaffoldable(dir, "edge").catch((cause: unknown) => cause);
    await chmod(edge, 0o755); // restore before asserting, so the temp dir is removable either way

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(join("apps", "edge"));
  });

  test("an illegal worker name is refused before any path is probed", async () => {
    // The gate builds `apps/<worker>/…` out of the name, so `pithy init --worker ../../etc` had it
    // walking paths outside the project and echoing hits back. Validate first; probe after.
    await expect(ensureScaffoldable(dir, "../../etc")).rejects.toThrow(PithyError);
    await expect(ensureScaffoldable(dir, "")).rejects.toThrow(PithyError);
  });
});

/**
 * The one gate. Four producers of the same escape wrote four versions of this question and three got it
 * wrong, so the rule is tested once, here, and every gate is tested for *routing through it* rather than
 * for re-deriving it.
 */
describe("ensureScaffoldPath", () => {
  test("a chain of real directories is fine", async () => {
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await expect(ensureScaffoldPath(dir, join(dir, "apps", "board"))).resolves.toBeUndefined();
  });

  test("a missing chain is fine — the scaffold is what creates it", async () => {
    await expect(ensureScaffoldPath(dir, join(dir, "apps", "board", "src"))).resolves.toBeUndefined();
  });

  test("the root itself is never judged — it is the directory the adopter handed us", async () => {
    // A project kept behind a symlink is the adopter's arrangement and none of our business. What has to
    // be real is every path *we* invent out of a name, which is exactly what starts below the root.
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    const root = join(dir, "project");
    await symlink(outside, root);

    await expect(ensureScaffoldPath(root, root)).resolves.toBeUndefined();
  });

  test("a symlink between the root and the target is refused, and named", async () => {
    // The gap #147 left: it lstat'd `apps/<name>` and never looked at `apps`. A link one level up carries
    // the scaffold out of the project just as completely, and `pithy worker add` walked straight through it.
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(dir, "apps"));

    const error = await ensureScaffoldPath(dir, join(dir, "apps", "board")).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("apps");
    expect((error as PithyError).payload.message).toContain("symlink");
  });

  test("a symlink at the target itself is refused", async () => {
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(join(dir, "apps"), { recursive: true });
    await symlink(outside, join(dir, "apps", "escape"));

    await expect(ensureScaffoldPath(dir, join(dir, "apps", "escape"))).rejects.toThrow(PithyError);
  });

  test("a dangling symlink is refused through PithyError, never a raw ENOENT", async () => {
    // `access` and a plain `existsSync` both follow the link and answer "missing", which cleared every
    // gate that asked them. `lstat` sees the link itself — which is the thing in the way.
    await mkdir(join(dir, "apps"), { recursive: true });
    await symlink(join(dir, "nowhere"), join(dir, "apps", "gone"));

    await expect(ensureScaffoldPath(dir, join(dir, "apps", "gone"))).rejects.toThrow(PithyError);
  });

  test("a file where a directory belongs is refused, rather than left to mkdir's raw ENOTDIR", async () => {
    await writeFile(join(dir, "apps"), "mine");
    const error = await ensureScaffoldPath(dir, join(dir, "apps", "board")).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("apps");
  });

  test("a target outside the root is this code's bug, and says so rather than probing on", async () => {
    // Nothing would be checked: the walk would leave the loop at the filesystem root. A caller that builds
    // such a path has already lost the argument, so it fails loudly here instead of passing quietly.
    await expect(ensureScaffoldPath(join(dir, "project"), join(dir, "elsewhere"))).rejects.toThrow(InternalError);
  });
});

/**
 * The delete gate, and it is deliberately stricter than the write gate above it.
 *
 * Every other producer in this series writes a file where it should not, and recovery is deleting the
 * file. These remove a tree, and there is nothing to recover — so the answer to "may this path be
 * removed" is its own function, and the `rm` lives inside it where no caller can forget it.
 */
describe("removeScaffoldPath", () => {
  test("removes a real directory under the root, and everything in it", async () => {
    const target = join(dir, "apps", "board");
    await mkdir(join(target, "src"), { recursive: true });
    await writeFile(join(target, "src", "index.ts"), "export default {};\n");

    await removeScaffoldPath(dir, target);
    expect(await pathExists(target)).toBe(false);
    expect(await pathExists(join(dir, "apps"))).toBe(true);
  });

  test("a missing target is not a delete — nothing there, nothing to refuse", async () => {
    await expect(removeScaffoldPath(dir, join(dir, "apps", "gone"))).resolves.toBeUndefined();
  });

  test("refuses a symlink between the root and the target, and deletes nothing through it", async () => {
    // #158. `pithy worker remove board` with `apps` linked outside the project deleted the link's
    // destination recursively and printed "Done." — reproduced with the real CLI against a canary tree.
    const outside = join(dir, "outside");
    await mkdir(join(outside, "board"), { recursive: true });
    await writeFile(join(outside, "board", "photos.txt"), "the adopter's\n");
    await symlink(outside, join(dir, "apps"));

    const error = await removeScaffoldPath(dir, join(dir, "apps", "board")).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    // The refusal says what this command was doing. Borrowing the write wording told an adopter "the
    // files would land outside the project" about a command that writes nothing.
    expect((error as PithyError).payload.action).toContain("delete through a link");
    expect(await readdir(join(outside, "board"))).toEqual(["photos.txt"]);
  });

  test("refuses a symlink at the target itself, and leaves the link standing", async () => {
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(join(dir, "apps"), { recursive: true });
    const link = join(dir, "apps", "board");
    await symlink(outside, link);

    await expect(removeScaffoldPath(dir, link)).rejects.toThrow(PithyError);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  test("refuses a target that resolves outside the root even with no link on the way", async () => {
    // The half a write gate does not have. `ensureScaffoldPath` judges each component and stops at the
    // first missing one; this asks the kernel where the whole path actually lands. A bind mount, a
    // hard-linked directory, or a link swapped in after the walk all end here rather than in an `rm -rf`.
    const root = join(dir, "project");
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, root); // the root itself may be a link — that is the adopter's arrangement

    await expect(removeScaffoldPath(root, join(dir, "outside", "board"))).rejects.toThrow(PithyError);
  });

  test("refuses the project root itself — a delete gate that permits that permits everything", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    await expect(removeScaffoldPath(dir, dir)).rejects.toThrow(PithyError);
    expect(await pathExists(join(dir, "pithy.config.ts"))).toBe(true);
  });
});

/**
 * #158, driven through the two commands that delete: `pithy worker remove` and `pithy remove <cap>` on an
 * ejected capability. Both built `apps/…` out of a name and handed it straight to a recursive `rm`.
 *
 * Reproduced with the real CLI before the fix. A project scaffolded `--name replay --worker board`, `apps`
 * replaced with a symlink to a canary directory holding a `board/` of ordinary files, then
 * `pithy worker remove board`: the canary's `board/` and everything under it was gone, and the command
 * printed "Removed replay-board." and "Done."
 */
describe("a symlinked apps/ in front of a delete", () => {
  let outside: string;
  let project: string;

  beforeEach(async () => {
    outside = join(dir, "outside");
    project = join(dir, "project");
    await mkdir(join(outside, "board", "deep"), { recursive: true });
    await writeFile(join(outside, "board", "photos.txt"), "the adopter's\n");
    await mkdir(project, { recursive: true });
    await symlink(outside, join(project, "apps"));
  });

  test("pithy worker remove refuses it, and the canary tree is untouched", async () => {
    const error = await removeWorker({
      projectDir: project,
      name: "board",
      mainRoot: project,
      discoverWorkers: async () => [{ name: "replay-board", dir: join(project, "apps", "board") }],
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PithyError);
    expect(await readdir(join(outside, "board"))).toEqual(["deep", "photos.txt"]);
  });

  test("pithy remove on an ejected capability refuses it too", async () => {
    // The same shape one directory lower: `apps/<worker>/capabilities/<cap>`, deleted for a capability
    // the config says was ejected. The steps are the real ones — this is the seam `pithy remove` uses.
    const workerDir = join(project, "apps", "board");
    const steps = defaultRemoveSteps({
      projectDir: project,
      workerDir,
      loadCapabilities: async () => [],
      project: "replay",
    });

    await expect(steps.deleteSource(join(workerDir, "capabilities", "turnstile"))).rejects.toThrow(PithyError);
    expect(await readdir(join(outside, "board"))).toEqual(["deep", "photos.txt"]);
  });
});

describe("ensureEmptyTarget", () => {
  test("a missing directory is fine", async () => {
    await expect(ensureEmptyTarget(dir, join(dir, "nope"))).resolves.toBeUndefined();
  });

  test("an existing empty directory is fine", async () => {
    await expect(ensureEmptyTarget(dir, dir)).resolves.toBeUndefined();
  });

  test("anything at all in the directory refuses it — this guards a path Pithy owns outright", async () => {
    await writeFile(join(dir, "README.md"), "not a project, still in the way");
    await expect(ensureEmptyTarget(dir, dir)).rejects.toThrow(PithyError);
  });

  test("a symlink is refused however empty its destination — the gate asks about the path", async () => {
    // `readdir` follows the link and answers about the *destination*. A link at `apps/<name>` pointing at
    // an empty directory therefore cleared the gate, and the whole worker was written through it, outside
    // the project. Same class as the dangling-symlink escape above, in the sibling gate that fix missed.
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    const link = join(dir, "apps", "escape");
    await mkdir(dirname(link), { recursive: true });
    await symlink(outside, link);

    await expect(ensureEmptyTarget(dir, link)).rejects.toThrow(PithyError);
  });

  test("a dangling symlink refuses through PithyError, never a raw ENOENT", async () => {
    // The other half of the same fixture, and the reason the gate runs before `mkdir`: a recursive
    // `mkdir` onto a dangling link is ENOENT, a raw node:fs error escaping the PithyError contract.
    const link = join(dir, "apps", "gone");
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(dir, "nowhere"), link);

    await expect(ensureEmptyTarget(dir, link)).rejects.toThrow(PithyError);
  });

  test("a symlinked parent is refused too, not just the target — that is the gap #147 left", async () => {
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(dir, "apps"));

    await expect(ensureEmptyTarget(dir, join(dir, "apps", "board"))).rejects.toThrow(PithyError);
  });
});

/**
 * The gate on the gate: **a module that writes to the filesystem may not decide where with a probe that
 * follows links.**
 *
 * This escape has had five producers, each one a hand-rolled `exists()` over a following probe or a
 * `readdir` that followed a link, and each one found by review after the last fix shipped.
 * {@link ensureScaffoldPath} is the answer; this is what stops a sixth from being written beside it.
 * Without it the primitive is a convention, and a convention is what the last five fixes already were.
 *
 * **The tripwire had the blind spot of the sweep that missed the bug.** It banned `access` and
 * `accessSync` and nothing else, so it went green on `capabilities/eject.ts` — the fifth producer, which
 * asked with `stat`. `stat`, `statSync` and `existsSync` follow a symlink exactly as completely as
 * `access` does; {@link ensureScaffoldPath}'s own docstring names two of them. So the rule is the whole
 * class now, and a module that follows on purpose says so in {@link FOLLOWS_ON_PURPOSE}, in writing.
 *
 * **And "a module that writes" was `node:fs`, which is not what it means.** `ui/flow.ts` probed with
 * `access` and then handed the answer to `scaffoldFiles`, which writes — and the rule never looked at it,
 * because it imports no writer of its own. A module that writes *through* this package's own writers writes
 * exactly as much as one calling `writeFile`, so {@link LOCAL_WRITES} names them and they count the same.
 * That is the seventh producer's shape, closed before it had one.
 *
 * **Why a test and not a Biome grit plugin.** The rule that holds with no exemptions is a conditional —
 * a follower is wrong in a module that *writes*, and unremarkable in one that only reads. `config.ts`,
 * `workerScope.ts` and `packageManager.ts` probe for a file they are
 * only going to read; following a link there decides nothing and leaks nothing. That conjunction is a fact
 * about a whole module, and Biome's grit plugins match expressions — the three this repo already ships
 * (`no-console`, `no-process-io`, `no-raw-request-input`) are all "never, anywhere in this scope" rules,
 * which this one is not. Scoping a plugin by `includes` would have meant hand-listing the writing modules
 * in `biome.jsonc`, which is a fifth place to forget.
 *
 * `readdir` is deliberately **not** banned: listing a directory is its ordinary use, all over this package.
 * What made it dangerous was asking it first. `occupied` asks `lstat` first, and that is what the primitive
 * exists to keep true.
 */
describe("the gate on the gate", () => {
  const CLI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  /** Anything that puts bytes on disk. A module importing one of these is a module that writes. */
  const WRITES = new Set([
    "appendFile",
    "appendFileSync",
    "chmod",
    "chmodSync",
    "copyFile",
    "copyFileSync",
    "cp",
    "cpSync",
    "link",
    "linkSync",
    "mkdir",
    "mkdirSync",
    "rename",
    "renameSync",
    "rm",
    "rmdir",
    "rmdirSync",
    "rmSync",
    "symlink",
    "symlinkSync",
    "truncate",
    "truncateSync",
    "unlink",
    "unlinkSync",
    "writeFile",
    "writeFileSync",
  ]);

  /**
   * The link-following probes. Every one of them answers about a symlink's *destination*, so a dangling
   * link reads as missing and clears any gate that asks. `lstat` answers about the path itself.
   */
  const FOLLOWS = new Set(["access", "accessSync", "existsSync", "stat", "statSync"]);

  /**
   * The writing modules that follow a link on purpose: path → the probes it may import, and why.
   *
   * An entry is a claim, and the test holds it to both halves — an unlisted follower fails, and a listed
   * one that stopped following, or that swapped its probe for another, fails too. So the list cannot go
   * stale and cannot quietly widen. Adding a line is the reviewable act; that is the point of it.
   *
   * Every entry here is a module asking about a path it does **not** compose and then write to. That is
   * the whole distinction: the escape is a probe answering for a link's destination while the write lands
   * on the link's own path. A `stat` read for a mode or an mtime is a different question, and following
   * is sometimes the only correct answer to it — `node_modules/<pkg>` is a symlink under every package
   * manager that shares a store.
   */
  const FOLLOWS_ON_PURPOSE: Record<string, { probes: string; why: string }> = {
    "capabilities/remove.ts": {
      probes: "stat",
      why: "Asks whether `node_modules/<pkg>` is installed. Nothing is written there, and following is the right answer — a shared-store package manager links that path.",
    },
    "feature/devVars.ts": {
      probes: "stat",
      why: "The destination *is* the question: it compares what the worker's link reaches with the project's shared file, behind an `lstat` that answers about the link.",
    },
    "feature/ports.ts": {
      probes: "stat",
      why: "Reads `mtimeMs` off a lock file it created itself, to age it out. Not an existence probe.",
    },
    "feature/sync.ts": {
      probes: "access",
      why: "Asks whether a worktree directory and its gitlink are still there, to decide whether a pinned port block belongs to a live feature. Nothing is composed from that answer and nothing is written through it.",
    },
    "feature/worktree.ts": {
      probes: "existsSync",
      why: "Asks about a git worktree directory before handing it to `git worktree add`, which does its own refusing. Nothing is composed and written through the answer.",
    },
    "platform/rc.ts": {
      probes: "existsSync, statSync",
      why: "Follows deliberately, and documents it: an `lstatSync` escape guard refuses a link out of the home directory first, and the mode behind it is then the real file's.",
    },
  };

  /**
   * This package's own writers. A module reaching one of these puts bytes on disk as surely as one calling
   * `writeFile`, and the rule was blind to every module that only did it this way — `ui/flow.ts` probed
   * with `access` and wrote through `scaffoldFiles`, and was never even in the set being examined.
   *
   * Gates are deliberately absent. `ensureScaffoldPath` and `pathExists` are the answer to the question,
   * not a way of writing, and a module that imports one has already done the right thing.
   */
  const LOCAL_WRITES = new Set(["removeScaffoldPath", "scaffoldFiles", "wireFeatureDevVars", "writeFileAtomic"]);

  /** Every `import { … } from "…"` in a module: the specifier, and the names it binds. */
  function namedImports(source: string): { specifier: string; names: string[] }[] {
    const found: { specifier: string; names: string[] }[] = [];
    for (const statement of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
      const names = (statement[1] ?? "")
        .split(",")
        .map((clause) =>
          clause
            .trim()
            .split(/\s+as\s+/)[0]
            ?.trim(),
        )
        .filter((name): name is string => Boolean(name));
      found.push({ specifier: statement[2] ?? "", names });
    }
    return found;
  }

  /** The names a module imports from `node:fs` or `node:fs/promises`, local aliases resolved to the original. */
  function fsImports(source: string): string[] {
    return namedImports(source)
      .filter(({ specifier }) => /^node:fs(\/promises)?$/.test(specifier))
      .flatMap(({ names }) => names);
  }

  /** Whether a module puts bytes on disk — through `node:fs`, or through one of this package's writers. */
  function writes(source: string): boolean {
    if (fsImports(source).some((name) => WRITES.has(name))) return true;
    return namedImports(source).some(
      ({ specifier, names }) => specifier.startsWith(".") && names.some((name) => LOCAL_WRITES.has(name)),
    );
  }

  /** Every module this rule covers: the CLI's shipped source, tests and their harnesses excluded. */
  async function modules(): Promise<string[]> {
    const entries = await readdir(CLI_SRC, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => !path.includes(`${sep}test-utils${sep}`))
      .sort();
  }

  /** Every writing module that imports a link-following probe: path → the probes, sorted. */
  async function followers(): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    for (const path of await modules()) {
      const source = await readFile(path, "utf8");
      const probes = fsImports(source)
        .filter((name) => FOLLOWS.has(name))
        .sort();
      if (probes.length > 0 && writes(source)) found[relative(CLI_SRC, path)] = probes.join(", ");
    }
    return found;
  }

  test("no module that writes to the filesystem probes with something that follows a link", async () => {
    const found = await followers();
    const declared = Object.fromEntries(Object.entries(FOLLOWS_ON_PURPOSE).map(([path, { probes }]) => [path, probes]));

    // One equality, and it fails from both sides. A writing module that starts following is not in
    // `declared` and shows up; a listed one that stopped, or swapped `stat` for `existsSync`, no longer
    // matches and shows up too. The message is for the first case, which is the one that ships a bug.
    expect(
      found,
      "route the check through ensureScaffoldPath/pathExists in project/scaffold.ts, or say why it follows in FOLLOWS_ON_PURPOSE",
    ).toEqual(declared);
  });

  test("and every exemption says why, in a sentence somebody has to disagree with", async () => {
    // A reason nobody wrote is a reason nobody reviewed, and the list is only worth having if adding to
    // it costs an argument.
    for (const [path, { why }] of Object.entries(FOLLOWS_ON_PURPOSE)) {
      expect(why.trim().length, path).toBeGreaterThan(40);
    }
  });

  /**
   * The modules allowed to call a recursive delete themselves: path → why.
   *
   * Not a second convention — the same one, asked of the other half. The previous rounds banned a probe
   * that follows and a hand-rolled temp-plus-rename, and neither noticed an `rm -rf` on a path built out
   * of a name. That is what #158's two producers were, and it is the shape the seventh will take unless
   * this is here.
   */
  const REMOVES_ON_PURPOSE: Record<string, string> = {
    "capabilities/eject.ts":
      "Discards the fork it is about to re-copy under `--force`, on the exact path `ensureScaffoldPath(projectDir, dest)` cleared on the line above and `pathExists` then confirmed with an `lstat`. The gate is there; only the `rm` is local.",
  };

  test("no module runs its own recursive delete on a path it composed", async () => {
    // `rm` itself is not banned: `feature/destroy.ts` and `feature/provision.ts` each remove one named
    // file, which unlinks exactly what it names. What escapes is the recursive form — it walks whatever
    // the path resolves to, so one symlink anywhere above it takes an unrelated tree with it.
    const found: string[] = [];
    for (const path of await modules()) {
      // The primitive's own module. `removeScaffoldPath` is where the `rm` is supposed to be.
      if (path === fileURLToPath(import.meta.url).replace(/\.test\.ts$/, ".ts")) continue;
      const source = await readFile(path, "utf8");
      if (/\brm(?:Sync)?\(\s*[^;]{0,200}?recursive:\s*true/.test(source)) found.push(relative(CLI_SRC, path));
    }

    expect(found.sort(), "route it through removeScaffoldPath, or say why it deletes its own way").toEqual(
      Object.keys(REMOVES_ON_PURPOSE).sort(),
    );
  });

  test("and every recursive delete that stays says why", () => {
    for (const [path, why] of Object.entries(REMOVES_ON_PURPOSE)) {
      expect(why.trim().length, path).toBeGreaterThan(40);
    }
  });

  test("and none of them reaches node:fs sideways, which would make the check above blind", async () => {
    // A namespace or default import puts every `fs.access` behind a member expression the rule cannot see.
    // Nothing in this package needs one, so the hole is closed rather than measured.
    const sideways: string[] = [];
    for (const path of await modules()) {
      const source = await readFile(path, "utf8");
      if (/import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+"node:fs(?:\/promises)?"/.test(source)) {
        sideways.push(relative(CLI_SRC, path));
      }
    }
    expect(sideways).toEqual([]);
  });
});

/**
 * The escape {@link ensureEmptyTarget} exists to stop, driven through the two callers that reach it.
 *
 * Reproduced against the real CLI before it was fixed: `pithy init --name replay --worker board`, a
 * symlink at `apps/escape` pointing anywhere on disk, then `pithy worker add escape`. Every file of the
 * worker landed at the link's destination — outside the project — along with a `.dev.vars` symlink, and
 * the command printed the escaped path and exited 0.
 */
describe("a symlinked apps/<name>", () => {
  let outside: string;
  let project: string;
  let link: string;

  beforeEach(async () => {
    outside = join(dir, "outside");
    project = join(dir, "project");
    link = join(project, "apps", "escape");
    await mkdir(outside, { recursive: true });
    await mkdir(join(project, "apps"), { recursive: true });
    await writeFile(join(project, "pithy.config.ts"), 'export default { name: "replay" };\n');
    await symlink(outside, link);
  });

  test("scaffoldWorker refuses it, and writes nothing through the link", async () => {
    await expect(scaffoldWorker({ projectDir: project, name: "escape", project: "replay" })).rejects.toThrow(
      PithyError,
    );

    expect(await readdir(outside)).toEqual([]);
  });

  test("the refusal leaves the adopter's link alone — there is nothing to roll back", async () => {
    // #138's rollback made the escape worse, not better: `addWorker` removes `apps/<name>` on failure,
    // and `rm` unlinks the *link* — so the escaped files stayed outside the project while the command
    // reported a clean rollback. Refusing before anything is created is what makes that unreachable.
    const failing = async () => {
      throw new InternalError({ message: "install failed", action: "Retry." });
    };
    const error = await addWorker({
      projectDir: project,
      name: "escape",
      mainRoot: project,
      install: failing,
      discoverWorkers: async () => [],
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PithyError);
    expect(error).not.toBeInstanceOf(InternalError); // refused by the gate, never by the install
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});

/**
 * The same escape one directory higher, driven through the two commands that write *inside* an existing
 * worker. Both reached {@link ensureScaffoldPath} already; both handed it a root too low to see the link.
 *
 * Reproduced against the real CLI. `pithy init --name replay --worker board`, then `apps` replaced by a
 * symlink to a directory outside the project, then `pithy ui add react --worker board`: ten files of a
 * React front end landed outside the project and the command printed "10 files created." and "Done."
 * `pithy add turnstile --worker board --eject` does the same with `apps/board/capabilities` linked — its
 * `exists()` asked `stat`, which follows, so the fork read as absent and `cp` wrote through the link.
 *
 * Driven here rather than from each module's own suite because the escape is one bug with two exits, and
 * splitting it across two files is how the last four fixes each covered one producer.
 */
describe("a symlink above the file being written", () => {
  let outside: string;
  let project: string;
  let workerDir: string;

  beforeEach(async () => {
    outside = join(dir, "outside");
    project = join(dir, "project");
    workerDir = join(project, "apps", "board");
    await mkdir(join(outside, "board"), { recursive: true });
    await mkdir(project, { recursive: true });
  });

  test("pithy ui add refuses to write a front end through a symlinked apps/", async () => {
    await symlink(outside, join(project, "apps"));

    await expect(
      scaffoldFiles({ workerDir, files: { "index.html": "<!doctype html>\n", "src/client.tsx": "theirs\n" } }),
    ).rejects.toThrow(PithyError);

    expect(await readdir(join(outside, "board"))).toEqual([]);
  });

  test("pithy ui add refuses a symlinked apps/<worker> too — the segment between the two old roots", async () => {
    await mkdir(join(project, "apps"), { recursive: true });
    await symlink(join(outside, "board"), workerDir);

    await expect(scaffoldFiles({ workerDir, files: { "index.html": "<!doctype html>\n" } })).rejects.toThrow(
      PithyError,
    );

    expect(await readdir(join(outside, "board"))).toEqual([]);
  });

  test("pithy add --eject refuses to fork a capability through a symlinked capabilities/", async () => {
    await mkdir(workerDir, { recursive: true });
    await mkdir(join(project, "node_modules", "@pithy-sh", "turnstile", "src"), { recursive: true });
    await writeFile(
      join(project, "node_modules", "@pithy-sh", "turnstile", "src", "index.ts"),
      "export const turnstile = 1;\n",
    );
    await symlink(outside, join(workerDir, "capabilities"));

    await expect(
      ejectCapability({
        projectDir: project,
        workerDir,
        capability: "turnstile",
        package: "@pithy-sh/turnstile",
        promoteDeps: async () => {},
      }),
    ).rejects.toThrow(PithyError);

    expect(await readdir(join(outside, "board"))).toEqual([]);
    expect(await readdir(outside)).toEqual(["board"]);
  });

  test("pithy worker add refuses to wire a .dev.vars through a symlinked apps/<worker>", async () => {
    // The sixth exit, and it is not the worker being added. `scaffoldWorker` refuses the directory it
    // creates, but the wiring runs over *every worker discovered* — and discovery reads `apps/` through
    // whatever is there. Reproduced with the real CLI: `pithy worker add web`, with `apps/other` a link
    // to a directory outside the project, wrote a `.dev.vars` symlink into that directory. Where the
    // shared file is outside the tree — a worktree, which is the case `linkPath` writes absolute for —
    // the planted link points straight at it, and reading `CLOUDFLARE_API_TOKEN` through it was one
    // `cat` away. `pithy dev` runs the same wiring on every run, so the plant needs no unusual command.
    await mkdir(join(project, "apps"), { recursive: true });
    await writeFile(join(project, ".dev.vars"), "CLOUDFLARE_API_TOKEN=live\n");
    await symlink(outside, join(project, "apps", "other"));

    await expect(
      wireFeatureDevVars({
        mainRoot: project,
        worktreePath: project,
        workers: [{ name: "other", dir: join(project, "apps", "other") }],
      }),
    ).rejects.toThrow(PithyError);

    expect(await pathExists(join(outside, ".dev.vars"))).toBe(false);
  });
});

/**
 * What `pithy init` is allowed to copy out of the starter: **what git has committed, and nothing else.**
 *
 * Reproduced against the real CLI from a checkout. A `.dev.vars` in `templates/starter` — gitignored,
 * invisible to `git status`, the file `pithy add` and `pithy token mint` write `CLOUDFLARE_API_TOKEN` and
 * `SECRETS_ENCRYPTION_KEYS` into — was copied straight into the adopter's new project, mode and all. `cp`
 * preserves the source's mode, so a maintainer's credentials landed in someone else's repository
 * world-readable, and `seedDevVars` then found a `.dev.vars` already there and left it exactly as it was.
 *
 * #145 fixed the same defect for the published tarball and stopped at the packer. `pithy init` from a
 * checkout is the other reader of that directory, and it had no filter at all.
 */
describe("the template copy", () => {
  const STARTER = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../templates/starter");

  test("carries no file the template's working tree merely happens to hold", async () => {
    const planted = join(STARTER, ".dev.vars");
    const scratch = join(STARTER, "apps", "api", "notes.local.md");
    await writeFile(planted, "CLOUDFLARE_API_TOKEN=a-maintainers-real-token\n");
    await writeFile(scratch, "half-written thought\n");
    try {
      await scaffoldProject({ targetDir: dir, appName: "leaky", worker: "board" });

      // The project's own `.dev.vars` is seeded from the example and owner-only. It is never the
      // maintainer's, and the mode is the tell: a copied one arrives with the source file's bits.
      const seeded = await readFile(join(dir, ".dev.vars"), "utf8");
      expect(seeded).not.toContain("a-maintainers-real-token");
      expect((await lstat(join(dir, ".dev.vars"))).mode & 0o777).toBe(0o600);
      // Ignored is not the rule — untracked is. An exclusion filter has to predict the next artefact.
      expect(await pathExists(join(dir, "apps", "board", "notes.local.md"))).toBe(false);
    } finally {
      await rm(planted, { force: true });
      await rm(scratch, { force: true });
    }
  });

  test("carries every file it has committed — the allowlist is the index, not a hand-kept list", async () => {
    await scaffoldProject({ targetDir: dir, appName: "complete", worker: "board" });

    const committed = committedFiles(STARTER) ?? [];
    expect(committed.length).toBeGreaterThan(10);
    for (const path of committed) {
      // Two files land under another name, and the first worker lands under the name the run chose.
      const landed = RENAMED_ON_LANDING[path] ?? path.replace(`apps${sep}api${sep}`, `apps${sep}board${sep}`);
      expect(await pathExists(join(dir, landed)), landed).toBe(true);
    }
  });
});

/**
 * The last two writers in this package that put a file on disk their own way.
 *
 * Driven from here for the reason every other exit in this series is: the escape is one bug, the producers
 * are scattered, and splitting the coverage across each module's own suite is exactly how the last five
 * fixes each covered one of them.
 *
 * `writeSeedArtifact` writes the **live dev-login session cookie** — a plain `writeFile`, so it arrived at
 * whatever the umask allowed and a foreign-owned symlink at `logs/dev-login.json` carried it straight out
 * of the project. `writeFileAtomic` is the rule for both halves: the link ownership check, and a mode the
 * file is *born* with rather than widened from.
 */
describe("the seed writers", () => {
  test("writes the dev-login artifact owner-only, because it holds a live session cookie", async () => {
    const path = await writeSeedArtifact(dir, { file: "dev-login.json", contents: '{"cookie":"live"}\n' });

    expect(path).toBe(join(dir, "logs", "dev-login.json"));
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  test("leaves a mode the adopter set on a file that is already there", async () => {
    // The same rule `.dev.vars` gets: `options.mode` is for creating a file, never for overruling one.
    await mkdir(join(dir, "logs"), { recursive: true });
    const path = join(dir, "logs", "dev-login.json");
    await writeFile(path, "{}\n");
    await chmod(path, 0o640);

    await writeSeedArtifact(dir, { file: "dev-login.json", contents: '{"cookie":"live"}\n' });
    expect((await lstat(path)).mode & 0o777).toBe(0o640);
  });
});

/**
 * `null` from the index reader means **git could not answer**, and that is not the same fact as "this is
 * the vendored copy".
 *
 * #145's fix read the same `null` as permission to copy the directory wholesale, which is right for one of
 * the two states and puts the whole leak back for the other: in a real checkout where git is missing, or
 * the repository is broken, or `templates/starter` has been added but not committed, `pithy init` went
 * straight back to copying whatever the maintainer's working tree happened to hold — `.dev.vars` included.
 * Silently, and only on the machines where it is hardest to notice.
 *
 * The two states are told apart by **which layout the template was resolved from**, which is a fact the
 * resolver already has. A checkout's `templates/starter` always has an index; the copy `prepack` vendored
 * into the package never does, and it was built from this same allowlist when there was one to read.
 */
describe("the starter's allowlist when git cannot answer", () => {
  test("a checkout with no index is refused rather than copied wholesale", async () => {
    const starter = join(dir, "starter");
    await mkdir(starter, { recursive: true });
    await writeFile(join(starter, ".dev.vars"), "CLOUDFLARE_API_TOKEN=a-maintainers-real-token\n");
    await writeFile(join(starter, "package.json"), "{}\n");

    // Not a repository, so the reader answers `null` exactly as a broken git would.
    expect(committedFiles(starter)).toBeNull();
    await expect(templateContents({ dir: starter, vendored: false })).rejects.toThrow(PithyError);
  });

  test("the vendored copy has no index by construction, and is taken as it stands", async () => {
    const starter = join(dir, "starter");
    await mkdir(join(starter, "apps", "api"), { recursive: true });
    await writeFile(join(starter, "package.json"), "{}\n");
    await writeFile(join(starter, "apps", "api", "package.json"), "{}\n");

    const contents = await templateContents({ dir: starter, vendored: true });
    expect(contents.files.sort()).toEqual([join("apps", "api", "package.json"), "package.json"]);
    expect(contents.directories).toContain(join("apps", "api"));
  });

  test("the layout is what says which one it is", async () => {
    // A checkout: `<root>/packages/cli/src/project` with the source of truth at `<root>/templates/starter`.
    const checkout = join(dir, "checkout");
    const moduleDir = join(checkout, "packages", "cli", "src", "project");
    await mkdir(moduleDir, { recursive: true });
    await mkdir(join(checkout, "templates", "starter"), { recursive: true });
    await writeFile(join(checkout, "templates", "starter", "package.json"), "{}\n");
    expect(resolveTemplateSource(moduleDir)).toEqual({ dir: join(checkout, "templates", "starter"), vendored: false });

    // An install: `<node_modules>/@pithy-sh/cli/src/project`, with the template `prepack` vendored in.
    const installed = join(dir, "installed", "node_modules", "@pithy-sh", "cli");
    await mkdir(join(installed, "src", "project"), { recursive: true });
    await mkdir(join(installed, "templates", "starter"), { recursive: true });
    await writeFile(join(installed, "templates", "starter", "package.json"), "{}\n");
    expect(resolveTemplateSource(join(installed, "src", "project"))).toEqual({
      dir: join(installed, "templates", "starter"),
      vendored: true,
    });
  });
});

describe("unpublishedKitNotice", () => {
  /** Every command that scaffolds a manifest `kitRange` can drop a `@pithy-sh/*` line from. */
  const COMMANDS = ["../commands/init.ts", "../commands/worker.ts", "../commands/ui.ts"];

  test("says something exactly when the scope is unpublished, and nothing when it is not", () => {
    expect(unpublishedKitNotice() === null).toBe(kitRange(PACKAGE_VERSION) !== null);
  });

  test("is the wording all three commands print — the drift gate", async () => {
    // `pithy init` printed this notice; `pithy worker add` and `pithy ui add` dropped the same kit line
    // from the manifest they wrote and then said "Done." Three commands, one gap, one sentence.
    //
    // A source read rather than a captured run, because the third command needs a scaffolded project, a
    // wired worker and a package manager to say anything at all — and what is on trial is the wording,
    // which is a fact about the source. Each command either calls the function or holds the exact words:
    // `init` still holds them, because folding it in belongs to whoever owns that file next. Say anything
    // else and this goes red.
    const lines = unpublishedKitNotice();
    if (lines === null) return; // published: there is no notice to hold anything to
    for (const command of COMMANDS) {
      const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), command), "utf8");
      const speaks = source.includes("unpublishedKitNotice") || lines.every((line) => source.includes(line));
      expect(speaks, command).toBe(true);
    }
  });
});
