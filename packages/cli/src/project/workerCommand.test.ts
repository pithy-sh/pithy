// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { devConfigPath, readDevConfig } from "../feature/devConfig";
import { addWorker, type DeployedScriptProbe, listWorkers, removeWorker, renameWorker } from "./workerCommand";
import type { WorkerTarget } from "./workers";

/** A discover-workers seam over the current apps/ dirs, so tests fix the set without real discovery. */
function discover(root: string, names: string[]): () => Promise<WorkerTarget[]> {
  return async () =>
    names.map((name) => ({
      name,
      dir: name === "app" ? root : join(root, "apps", name),
      dev: { autostart: true, readySignal: "Ready on https?://" },
      hasWrangler: true,
    }));
}

describe("addWorker", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-worker-add-"));
    // Every project has a root config; the scaffold reads the project name from it rather than guessing.
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("in a plain checkout: scaffolds, skips port reconcile, reports no port", async () => {
    let installed = false;
    const report = await addWorker({
      projectDir: dir,
      name: "web",
      mainRoot: dir, // projectDir === mainRoot → not a feature worktree
      install: async () => {
        installed = true;
      },
      discoverWorkers: discover(dir, ["app", "web"]),
    });

    expect(installed).toBe(true);
    expect(report).toEqual({ name: "web", dir: join(dir, "apps", "web"), port: null, reconciled: false, kept: [] });
    await stat(join(dir, "apps", "web", "wrangler.jsonc")); // the scaffold landed
  });

  test("reports the sibling that kept its own .dev.vars, rather than dropping the list on the floor", async () => {
    // `worker add web` wires *every* worker it discovers. apps/board keeping its own secrets is the
    // situation `pithy dev` now names out loud, and the command that caused it said nothing at all.
    await writeFile(join(dir, ".dev.vars"), "SHARED=abc\n");
    const boardDir = join(dir, "apps", "board");
    await mkdir(boardDir, { recursive: true });
    await writeFile(join(boardDir, ".dev.vars"), "BOARD_ONLY=super-secret\n");

    const report = await addWorker({
      projectDir: dir,
      name: "web",
      mainRoot: dir,
      skipInstall: true,
      discoverWorkers: discover(dir, ["board", "web"]),
    });

    expect(report.kept).toEqual([{ dir: boardDir, reason: "file" }]);
    expect(await readFile(join(boardDir, ".dev.vars"), "utf8")).toBe("BOARD_ONLY=super-secret\n");
  });

  test("in a feature worktree it reports the kept list too — the sync that wires them does not carry it", async () => {
    const mainRoot = await mkdtemp(join(tmpdir(), "pithy-main-"));
    const worktree = join(mainRoot, ".worktrees", "73-demo");
    const boardDir = join(worktree, "apps", "board");
    await mkdir(boardDir, { recursive: true });
    await writeFile(join(worktree, "pithy.config.ts"), 'export default { name: "acme" };\n');
    await writeFile(join(mainRoot, ".dev.vars"), "SHARED=abc\n");
    await writeFile(join(boardDir, ".dev.vars"), "BOARD_ONLY=super-secret\n");
    try {
      const report = await addWorker({
        projectDir: worktree,
        name: "web",
        mainRoot,
        branch: "feature/73-demo",
        skipInstall: true,
        discoverWorkers: discover(worktree, ["board", "web"]),
      });

      expect(report.kept).toEqual([{ dir: boardDir, reason: "file" }]);
    } finally {
      await rm(mainRoot, { recursive: true, force: true });
    }
  });

  test("threads the root project name into the new worker's PROJECT var", async () => {
    // A Worker added later must be able to mint attributable Images/Stream assets exactly like the one
    // `pithy init` scaffolded — the project is read from the root config, never guessed from the directory.
    await addWorker({
      projectDir: dir,
      name: "web",
      mainRoot: dir,
      skipInstall: true,
      discoverWorkers: discover(dir, ["app", "web"]),
    });

    const wrangler = parse(await readFile(join(dir, "apps", "web", "wrangler.jsonc"), "utf8")) as unknown as {
      vars: Record<string, string>;
      env: Record<string, { vars: Record<string, string> }>;
    };
    expect(wrangler.vars?.PROJECT).toBe("acme");
    expect(wrangler.env.staging?.vars?.PROJECT).toBe("acme");
    expect(wrangler.env.prod?.vars?.PROJECT).toBe("acme");
  });

  test("--skip-install does not run the workspace install", async () => {
    let installed = false;
    await addWorker({
      projectDir: dir,
      name: "web",
      mainRoot: dir,
      skipInstall: true,
      install: async () => {
        installed = true;
      },
      discoverWorkers: discover(dir, ["app", "web"]),
    });
    expect(installed).toBe(false);
  });

  test("degrades gracefully when the project is not a git repo (fresh init before git init)", async () => {
    // No mainRoot passed, and git fails — worker add must still scaffold, treating the dir as its own root.
    const report = await addWorker({
      projectDir: dir,
      name: "web",
      skipInstall: true,
      git: async () => {
        throw new Error("fatal: not a git repository");
      },
      discoverWorkers: discover(dir, ["app", "web"]),
    });
    expect(report).toEqual({ name: "web", dir: join(dir, "apps", "web"), port: null, reconciled: false, kept: [] });
    await stat(join(dir, "apps", "web", "wrangler.jsonc"));
  });

  test("in a feature worktree: reconciles .dev.config.json and pins a port", async () => {
    const mainRoot = await mkdtemp(join(tmpdir(), "pithy-main-"));
    const worktree = join(mainRoot, ".worktrees", "73-demo");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "pithy.config.ts"), 'export default { name: "acme" };\n');
    try {
      const report = await addWorker({
        projectDir: worktree,
        name: "web",
        mainRoot,
        branch: "feature/73-demo",
        skipInstall: true,
        discoverWorkers: discover(worktree, ["app", "web"]),
      });

      expect(report.reconciled).toBe(true);
      expect(report.port).toBeGreaterThanOrEqual(8787);

      const config = await readDevConfig(devConfigPath(worktree));
      expect(config?.workers.web?.port).toBe(report.port);
    } finally {
      await rm(mainRoot, { recursive: true, force: true });
    }
  });

  test("wires .dev.vars before the install, so a failed install cannot be why a worker has none", async () => {
    // The ordering that broke every worker after the first: the install ran first and threw, and the
    // dev-vars link below it never ran at all. The link is the convention `pithy init` established —
    // one `.dev.vars` at the project root, symlinked into every worker.
    await writeFile(join(dir, ".dev.vars"), "SHARED=1\n");
    const order: string[] = [];
    await addWorker({
      projectDir: dir,
      name: "web",
      mainRoot: dir,
      install: async () => {
        order.push("install");
        // Whatever the worker looks like when the install runs is what it looks like afterwards.
        order.push((await lstat(join(dir, "apps", "web", ".dev.vars"))).isSymbolicLink() ? "linked" : "plain");
      },
      discoverWorkers: discover(dir, ["app", "web"]),
    });

    expect(order).toEqual(["install", "linked"]);
  });

  test("a failed install leaves nothing behind, so the same command works on the retry", async () => {
    // `apps/<name>` is a directory pithy owns outright — `ensureEmptyTarget` refuses to scaffold into
    // one that holds anything. A half-made worker therefore blocks its own retry, and the adopter's
    // only way out was `rm -rf`. All-or-nothing instead: the failure rolls the directory back.
    const failing = async () => {
      throw new InternalError({ message: "npm install failed after scaffolding the worker.", action: "Retry." });
    };
    await expect(
      addWorker({
        projectDir: dir,
        name: "web",
        mainRoot: dir,
        install: failing,
        discoverWorkers: discover(dir, ["app", "web"]),
      }),
    ).rejects.toBeInstanceOf(InternalError);

    await expect(stat(join(dir, "apps", "web"))).rejects.toThrow();

    // The whole point: the same command, unchanged, now succeeds.
    const report = await addWorker({
      projectDir: dir,
      name: "web",
      mainRoot: dir,
      skipInstall: true,
      discoverWorkers: discover(dir, ["app", "web"]),
    });
    expect(report.dir).toBe(join(dir, "apps", "web"));
    await stat(join(dir, "apps", "web", "wrangler.jsonc"));
  });

  test("a worker that was already there survives a failed run — the rollback removes only what it made", async () => {
    // The rollback must never reach a sibling, and must never reach a directory this run did not create.
    await addWorker({
      projectDir: dir,
      name: "admin",
      mainRoot: dir,
      skipInstall: true,
      discoverWorkers: discover(dir, ["app", "admin"]),
    });

    await expect(
      addWorker({
        projectDir: dir,
        name: "web",
        mainRoot: dir,
        install: async () => {
          throw new InternalError({ message: "install failed.", action: "Retry." });
        },
        discoverWorkers: discover(dir, ["app", "admin", "web"]),
      }),
    ).rejects.toBeInstanceOf(InternalError);

    await stat(join(dir, "apps", "admin", "wrangler.jsonc"));
    await expect(stat(join(dir, "apps", "web"))).rejects.toThrow();
  });
});

describe("listWorkers", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-worker-list-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reports autostart state and pinned port from .dev.config.json", async () => {
    await writeFile(
      devConfigPath(dir),
      `${JSON.stringify({
        version: 1,
        branch: "feature/73-demo",
        ports: { index: 0, base: 8787, size: 10 },
        workers: { app: { port: 8787, origin: "http://localhost:8787" } },
      })}\n`,
    );

    const workers = await listWorkers({
      projectDir: dir,
      discoverWorkers: discover(dir, ["app", "web"]),
    });

    expect(workers).toEqual([
      { name: "app", dir, autostart: true, hasWrangler: true, port: 8787 },
      { name: "web", dir: join(dir, "apps", "web"), autostart: true, hasWrangler: true, port: null },
    ]);
  });
});

describe("removeWorker", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-worker-remove-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("deletes apps/<name> in a plain checkout", async () => {
    await mkdir(join(dir, "apps", "web"), { recursive: true });
    await writeFile(join(dir, "apps", "web", "wrangler.jsonc"), "{}");

    const report = await removeWorker({
      projectDir: dir,
      name: "web",
      mainRoot: dir,
      discoverWorkers: discover(dir, ["app", "web"]),
    });

    expect(report).toEqual({ name: "web", dir: join(dir, "apps", "web"), reconciled: false });
    await expect(stat(join(dir, "apps", "web"))).rejects.toThrow();
  });

  test("removes a worker by the wrangler name that worker list showed, even when it differs from the directory", async () => {
    // apps/api holds a worker whose wrangler `name` is "my-service" — the name `worker list` prints.
    const apiDir = join(dir, "apps", "api");
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(apiDir, "wrangler.jsonc"), JSON.stringify({ name: "my-service" }));
    const discoverRenamed = async () => [
      { name: "my-service", dir: apiDir, dev: { autostart: true, readySignal: "x" }, hasWrangler: true },
    ];

    const report = await removeWorker({
      projectDir: dir,
      name: "my-service",
      mainRoot: dir,
      discoverWorkers: discoverRenamed,
    });

    expect(report).toEqual({ name: "my-service", dir: apiDir, reconciled: false });
    await expect(stat(apiDir)).rejects.toThrow();
  });

  test("throws NotFoundError when the worker does not exist", async () => {
    await expect(
      removeWorker({ projectDir: dir, name: "ghost", mainRoot: dir, discoverWorkers: discover(dir, ["app"]) }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("renameWorker", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-worker-rename-"));
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A scaffolded worker on disk: the directory, the deploy name, the `WORKER` var in every stanza. */
  async function scaffold(name: string): Promise<string> {
    const workerDir = join(dir, "apps", name);
    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      `{
  // The Worker's own directory — what tells two Workers' audit events apart.
  "name": "acme-${name}",
  "vars": { "ENVIRONMENT": "dev", "PROJECT": "acme", "WORKER": "${name}" },
  "env": {
    "staging": { "vars": { "ENVIRONMENT": "staging", "PROJECT": "acme", "WORKER": "${name}" } },
    "prod": { "vars": { "ENVIRONMENT": "prod", "PROJECT": "acme", "WORKER": "${name}" } }
  }
}
`,
    );
    await writeFile(
      join(workerDir, "package.json"),
      `${JSON.stringify({ name: `acme-${name}`, private: true, type: "module" }, null, 2)}\n`,
    );
    return workerDir;
  }

  /** An account that answers, holding exactly `live`. */
  const account = (...live: string[]): DeployedScriptProbe => {
    return async (_projectDir, scripts) => ({ live: scripts.filter((script) => live.includes(script)), checked: true });
  };

  /** An account nothing could be learned from — no credentials, offline, a refused listing. */
  const unreachable: DeployedScriptProbe = async () => ({ live: [], checked: false });

  /** The renamed worker's `wrangler.jsonc`, parsed. */
  async function wranglerOf(name: string): Promise<{
    name?: string;
    vars?: Record<string, string>;
    env?: Record<string, { vars?: Record<string, string> }>;
  }> {
    const raw = await readFile(join(dir, "apps", name, "wrangler.jsonc"), "utf8");
    return parse(raw) as unknown as {
      name?: string;
      vars?: Record<string, string>;
      env?: Record<string, { vars?: Record<string, string> }>;
    };
  }

  test("moves the directory and reconciles all three stamps", async () => {
    await scaffold("api");

    const report = await renameWorker({
      projectDir: dir,
      from: "api",
      to: "board",
      mainRoot: dir,
      discoverWorkers: discover(dir, ["api"]),
      probeDeployed: account(),
    });

    expect(report).toEqual({
      from: "api",
      to: "board",
      dir: join(dir, "apps", "board"),
      script: { from: "acme-api", to: "acme-board" },
      orphaned: [],
      accountChecked: true,
      reconciled: false,
    });

    await expect(stat(join(dir, "apps", "api"))).rejects.toThrow();
    const wrangler = await wranglerOf("board");
    expect(wrangler.name).toBe("acme-board");
    expect(wrangler.vars?.WORKER).toBe("board");
    expect(wrangler.env?.staging?.vars?.WORKER).toBe("board");
    expect(wrangler.env?.prod?.vars?.WORKER).toBe("board");
    const pkg = JSON.parse(await readFile(join(dir, "apps", "board", "package.json"), "utf8")) as { name: string };
    expect(pkg.name).toBe("acme-board");
  });

  test("keeps the comments in wrangler.jsonc", async () => {
    await scaffold("api");
    await renameWorker({
      projectDir: dir,
      from: "api",
      to: "board",
      mainRoot: dir,
      discoverWorkers: discover(dir, ["api"]),
      probeDeployed: account(),
    });
    expect(await readFile(join(dir, "apps", "board", "wrangler.jsonc"), "utf8")).toContain(
      "// The Worker's own directory",
    );
  });

  test("asks the account about every script name the old worker deploys under", async () => {
    await scaffold("api");
    let asked: string[] = [];
    await renameWorker({
      projectDir: dir,
      from: "api",
      to: "board",
      mainRoot: dir,
      discoverWorkers: discover(dir, ["api"]),
      probeDeployed: async (_projectDir, scripts) => {
        asked = scripts;
        return { live: [], checked: true };
      },
    });
    // The top-level name is the dev script; wrangler names an env stanza `<name>-<env>` unless it says otherwise.
    expect(asked).toEqual(["acme-api", "acme-api-staging", "acme-api-prod"]);
  });

  test("refuses when a script is live under the old name, and moves nothing", async () => {
    await scaffold("api");

    await expect(
      renameWorker({
        projectDir: dir,
        from: "api",
        to: "board",
        mainRoot: dir,
        discoverWorkers: discover(dir, ["api"]),
        probeDeployed: account("acme-api-prod"),
      }),
    ).rejects.toThrow(ConflictError);

    // The refusal is the whole point: nothing has moved, so the deployed Worker still matches its source.
    await stat(join(dir, "apps", "api"));
    await expect(stat(join(dir, "apps", "board"))).rejects.toThrow();
  });

  test("the refusal names the script that would be left live", async () => {
    await scaffold("api");
    await expect(
      renameWorker({
        projectDir: dir,
        from: "api",
        to: "board",
        mainRoot: dir,
        discoverWorkers: discover(dir, ["api"]),
        probeDeployed: account("acme-api-prod"),
      }),
    ).rejects.toThrow(/acme-api-prod/);
  });

  test("--force renames anyway and reports what it orphaned", async () => {
    await scaffold("api");
    const report = await renameWorker({
      projectDir: dir,
      from: "api",
      to: "board",
      force: true,
      mainRoot: dir,
      discoverWorkers: discover(dir, ["api"]),
      probeDeployed: account("acme-api", "acme-api-prod"),
    });
    expect(report.orphaned).toEqual(["acme-api", "acme-api-prod"]);
    expect(report.accountChecked).toBe(true);
    await stat(join(dir, "apps", "board"));
  });

  test("an unreachable account does not block the rename, and the report says it was not checked", async () => {
    await scaffold("api");
    const report = await renameWorker({
      projectDir: dir,
      from: "api",
      to: "board",
      mainRoot: dir,
      discoverWorkers: discover(dir, ["api"]),
      probeDeployed: unreachable,
    });
    // Degraded honestly: `orphaned` is empty because nothing was established, not because nothing is live.
    expect(report).toMatchObject({ orphaned: [], accountChecked: false });
    await stat(join(dir, "apps", "board"));
  });

  test("refuses a new name that is not kebab-case, on the rule scaffoldWorker uses", async () => {
    await scaffold("api");
    await expect(
      renameWorker({
        projectDir: dir,
        from: "api",
        to: "Admin_API",
        mainRoot: dir,
        discoverWorkers: discover(dir, ["api"]),
        probeDeployed: account(),
      }),
    ).rejects.toThrow(ValidationError);
    await stat(join(dir, "apps", "api"));
  });

  test("refuses a destination that already exists", async () => {
    await scaffold("api");
    await scaffold("board");
    await expect(
      renameWorker({
        projectDir: dir,
        from: "api",
        to: "board",
        mainRoot: dir,
        discoverWorkers: discover(dir, ["api", "board"]),
        probeDeployed: account(),
      }),
    ).rejects.toThrow(ConflictError);
    await stat(join(dir, "apps", "api"));
  });

  test("a dangling symlink at the destination refuses through PithyError, never a raw ENOTDIR", async () => {
    // `renameWorker` had its own `exists()` over `access`, which follows the link — so a dangling one read
    // as "nothing there", cleared the gate, and `rename` threw ENOTDIR straight through the PithyError
    // contract `--json` callers parse. Reproduced against the real CLI: `pithy worker rename board moved`
    // with a dangling link at `apps/moved` printed a node:fs stack trace and exited 0.
    await scaffold("api");
    await symlink(join(dir, "nowhere"), join(dir, "apps", "board"));

    const error = await renameWorker({
      projectDir: dir,
      from: "api",
      to: "board",
      mainRoot: dir,
      discoverWorkers: discover(dir, ["api"]),
      probeDeployed: account(),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictError);
    await stat(join(dir, "apps", "api")); // untouched
  });

  test("a symlinked apps/ is refused — the move would carry the worker out of the project", async () => {
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(dir, "apps"));
    await scaffold("api"); // writes through the link, as an adopter's own layout would have

    await expect(
      renameWorker({
        projectDir: dir,
        from: "api",
        to: "board",
        mainRoot: dir,
        discoverWorkers: discover(dir, ["api"]),
        probeDeployed: account(),
      }),
    ).rejects.toThrow(ConflictError);
  });

  test("a symlink at apps/<from> is refused — the source is gated too, not only the destination", async () => {
    // #164, the seventh producer of this class and its third verb. The destination was gated and the
    // source was not, so `rename` moved the *link* to `apps/board` — still pointing outside the project —
    // and the `wrangler.jsonc` and `package.json` rewrites below then went straight through it. Reproduced
    // against a canary directory: the command reported success and left the canary's files renamed.
    const canary = join(dir, "canary");
    await mkdir(canary, { recursive: true });
    await writeFile(join(canary, "wrangler.jsonc"), '{ "name": "acme-api" }\n');
    await writeFile(join(canary, "package.json"), `${JSON.stringify({ name: "acme-api" }, null, 2)}\n`);
    await mkdir(join(dir, "apps"), { recursive: true });
    await symlink(canary, join(dir, "apps", "api"));

    const error = await renameWorker({
      projectDir: dir,
      from: "api",
      to: "board",
      mainRoot: dir,
      discoverWorkers: discover(dir, ["api"]),
      probeDeployed: account(),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictError);
    // The sentence is the move's, not the scaffold's: nothing was being scaffolded, and the wording an
    // adopter acts on has to describe the command that printed it.
    expect((error as ConflictError).payload.action).toContain("move through a link");
    // Nothing moved, and nothing was written through the link.
    expect((await lstat(join(dir, "apps", "api"))).isSymbolicLink()).toBe(true);
    await expect(stat(join(dir, "apps", "board"))).rejects.toThrow();
    const pkg = JSON.parse(await readFile(join(canary, "package.json"), "utf8")) as { name: string };
    expect(pkg.name).toBe("acme-api");
  });

  test("throws NotFoundError when the worker does not exist", async () => {
    await expect(
      renameWorker({
        projectDir: dir,
        from: "ghost",
        to: "board",
        mainRoot: dir,
        discoverWorkers: discover(dir, []),
        probeDeployed: account(),
      }),
    ).rejects.toThrow(NotFoundError);
  });

  test("leaves a script name the adopter chose alone, and says so", async () => {
    // `my-service` was never composed from `<project>-<worker>`, so renaming it would rename a Worker the
    // adopter named themselves — and, deployed, would strand it under a name pithy invented.
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      `${JSON.stringify({ name: "my-service", vars: { WORKER: "api" } }, null, 2)}\n`,
    );

    const report = await renameWorker({
      projectDir: dir,
      from: "api",
      to: "board",
      mainRoot: dir,
      discoverWorkers: async () => [{ name: "my-service", dir: workerDir, hasWrangler: true }],
      probeDeployed: account(),
    });

    expect(report.script).toBeNull();
    expect((await wranglerOf("board")).name).toBe("my-service");
    expect((await wranglerOf("board")).vars?.WORKER).toBe("board");
  });

  test("in a feature worktree it reconciles the port registry onto the new name", async () => {
    const mainRoot = await mkdtemp(join(tmpdir(), "pithy-main-"));
    const worktree = join(mainRoot, ".worktrees", "73-demo");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "pithy.config.ts"), 'export default { name: "acme" };\n');
    const workerDir = join(worktree, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: "acme-api", vars: { WORKER: "api" } }));
    try {
      const report = await renameWorker({
        projectDir: worktree,
        from: "api",
        to: "board",
        mainRoot,
        branch: "feature/73-demo",
        // Discovery answers from the tree, so the reconcile that runs after the move sees the new name —
        // which is the point of running it: the old name's port is released and the new one takes it.
        discoverWorkers: async () => {
          const moved = await stat(join(worktree, "apps", "board")).then(
            () => true,
            () => false,
          );
          return moved
            ? [{ name: "acme-board", dir: join(worktree, "apps", "board"), hasWrangler: true }]
            : [{ name: "acme-api", dir: join(worktree, "apps", "api"), hasWrangler: true }];
        },
        probeDeployed: account(),
      });

      expect(report.reconciled).toBe(true);
      const config = await readDevConfig(devConfigPath(worktree));
      expect(config?.workers["acme-board"]?.port).toBeGreaterThanOrEqual(8787);
      expect(config?.workers.api).toBeUndefined();
    } finally {
      await rm(mainRoot, { recursive: true, force: true });
    }
  });
});
