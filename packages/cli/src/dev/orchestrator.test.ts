// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GENERATED_MARKER, generateDevVars } from "../devSecrets/generate";
import { buildDevConfig, type DevConfig, devConfigPath, readDevConfig, writeDevConfig } from "../feature/devConfig";
import { BASE_PORT, BLOCK_SIZE, type PortsRegistry } from "../feature/ports";
import { pruneFeatureBlocks } from "../feature/prune";
import type { WorkerTarget } from "../project/workers";
import type { DevEvent } from "./events";
import type { MaterializeHostConfigsOptions } from "./hostWorkers";
import {
  type ChildLike,
  type EnsureDevConfigOptions,
  ensureDevConfig,
  type LogSink,
  type SpawnDev,
  type StartDevOptions,
  startDev,
} from "./orchestrator";
import { READY_DEADLINE_MS, READY_REMINDER_MS, type Schedule } from "./readyWatch";
import { DevState } from "./state";

/** A fake child process: an EventEmitter with PassThrough stdout/stderr and a pid. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
}

/** Let stream `data` events flow and microtasks settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const config: DevConfig = {
  version: 1,
  branch: "feature/73-cli-commands",
  ports: { index: 0, base: 8787, size: 10 },
  workers: {
    api: { port: 8787, origin: "http://localhost:8787" },
    web: { port: 8788, origin: "http://localhost:8788" },
  },
};

/** The autostart worker set: `api` is a wrangler worker, `web` a custom-command Vite process. */
const workers: WorkerTarget[] = [
  {
    name: "api",
    dir: "/proj/apps/api",
    hasWrangler: true,
    dev: { readySignal: "Ready on https?://" },
  },
  {
    name: "web",
    dir: "/proj/apps/web",
    hasWrangler: false,
    dev: { readySignal: "ready in \\d+", command: ["vite", "--host"] },
  },
];

/** Build a harness: fake spawn/kill/state/log seams plus the options to drive `startDev`. */
function harness(overrides: Partial<StartDevOptions> = {}) {
  const spawned: {
    command: string;
    args: string[];
    opts: { cwd: string; env: Record<string, string>; detached: boolean };
    child: FakeChild;
  }[] = [];
  const killCalls: { pid: number; signal: string }[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const logLines: string[] = [];
  const livePids = new Set<number>();
  let seq = 5000;

  const spawn: SpawnDev = (command, args, opts) => {
    const child = new FakeChild(seq++);
    livePids.add(child.pid);
    spawned.push({ command, args, opts, child });
    return child as unknown as ChildLike;
  };

  const kill = (pid: number, signal: NodeJS.Signals) => {
    killCalls.push({ pid, signal });
    const real = Math.abs(pid);
    livePids.delete(real);
    const entry = spawned.find((s) => s.child.pid === real);
    if (entry) {
      entry.child.stdout.end();
      entry.child.stderr.end();
      entry.child.emit("exit", signal === "SIGKILL" ? null : 0);
    }
  };

  const logSink: LogSink = { write: (l) => logLines.push(l), end: () => {} };

  // A hand-driven clock for the ready deadline, so no case waits ninety real seconds and none leaves a
  // live timer behind. `advance` fires whatever is due.
  const timers: { at: number; run: () => void; done: boolean }[] = [];
  let elapsed = 0;
  const schedule: Schedule = (ms, run) => {
    const timer = { at: elapsed + ms, run, done: false };
    timers.push(timer);
    return () => {
      timer.done = true;
    };
  };
  const advance = (ms: number) => {
    elapsed += ms;
    for (const timer of [...timers]) {
      if (timer.done || timer.at > elapsed) continue;
      timer.done = true;
      timer.run();
    }
  };

  const written: DevState[] = [];
  let stored: DevState | null = null;
  const removed: number[] = [];

  const options: StartDevOptions = {
    projectDir: "/proj",
    // `null`, stated: this fixture project names no Cloudflare account. The credentialed child
    // environment is the `devCloudflareEnv` seam below, so no case here reaches a credentials file.
    account: null,
    discoverWorkers: async () => workers,
    // Stubbed: these workers are fixtures with no directories on disk, and generating each one's
    // `.dev.vars` is `devSecrets/generate.test.ts`'s subject rather than this file's.
    generateDevVars: async () => ({
      generated: [],
      unchanged: [],
      refused: [],
      relinked: [],
      names: [],
      unresolvable: [],
    }),
    loadDevConfig: async () => config,
    // Stubbed: which capability hosts a project composes is `hostWorkers.test.ts`'s subject, and these
    // fixtures have no `pithy.config.ts` on disk. The cases below that care hand over their own.
    projectName: async () => "acme",
    discoverHostWorkers: async () => ({ hosts: [], notes: [] }),
    materializeHostConfigs: async () => ({ notes: [], failed: [] }),
    devCloudflareEnv: (_account, base) => ({
      env: { ...(base as Record<string, string>), CLOUDFLARE_ACCOUNT_ID: "acct-1", CLOUDFLARE_API_TOKEN: "t" },
      identity: { accountId: "acct-1", hasToken: true, mismatch: null },
      overridden: [],
    }),
    // Stubbed for the same reason: which worker composes auth is read off a real `pithy.config.ts`, and
    // `devLoginTargets.test.ts` owns that question. `api` is the wrangler worker in this fixture set.
    devLoginTargets: async (started) =>
      started.filter((s) => s.name === "api").map(({ name, origin }) => ({ name, origin })),
    // No terminal by default: these cases drive the supervisor, not a keyboard. A case that wants keys
    // overrides this with a reader that hands its bindings back.
    readKeys: () => ({ active: false, stop: () => {} }),
    openUrl: async () => {},
    tryBind: async () => true,
    sweep: async () => [],
    spawn,
    kill,
    isAlive: (pid) => livePids.has(pid),
    sleep: async () => {},
    schedule,
    launchWrangler: (args) => ({ command: "bun", args: ["x", "wrangler", ...args] }),
    hasSetsid: true,
    stdout: (t) => stdoutLines.push(t.replace(/\n$/, "")),
    stderr: (t) => stderrLines.push(t.replace(/\n$/, "")),
    openLog: () => logSink,
    baseEnv: { PATH: "/usr/bin" },
    now: () => new Date("2026-07-27T00:00:00.000Z"),
    readState: async () => stored,
    writeState: async (_path, state) => {
      // **Validated through the real schema, exactly as `writeDevState` does.** A fake that merely
      // remembers what it was handed let a session record `port: 0` for a worker started from parked and
      // stay green, while the real writer threw a ZodError that reached the terminal as a raw JSON blob.
      // A double that does not enforce the contract its subject enforces is a double that hides bugs.
      DevState.parse(state);
      written.push(state);
      stored = state;
    },
    removeState: (_path, ownPid) => removed.push(ownPid),
    ownPid: 4242,
    ...overrides,
  };

  return {
    options,
    spawned,
    killCalls,
    stdoutLines,
    stderrLines,
    logLines,
    written,
    removed,
    livePids,
    advance,
    pendingTimers: () => timers.filter((timer) => !timer.done).length,
    setStored: (s: DevState | null) => {
      stored = s;
    },
  };
}

// One test forces color on and rebuilds the module graph to prove the log path strips it. Both are undone
// here rather than there, so a failure part-way through cannot leave `FORCE_COLOR` set for the file's
// remaining tests — every one of which asserts on plain strings.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("startDev — ports", () => {
  test("verifies every pinned port on both families before spawning", async () => {
    const h = harness();
    const bind = vi.fn().mockResolvedValue(true);
    await startDev({ ...h.options, tryBind: bind });
    expect(bind).toHaveBeenCalledWith(8787, "127.0.0.1");
    expect(bind).toHaveBeenCalledWith(8787, "::1");
    expect(bind).toHaveBeenCalledWith(8788, "127.0.0.1");
    expect(bind).toHaveBeenCalledWith(8788, "::1");
  });

  test("a busy pinned port aborts the whole session — nothing is spawned, never drifts", async () => {
    const h = harness();
    const bind = async (port: number, host: string) => !(port === 8788 && host === "::1");
    await expect(startDev({ ...h.options, tryBind: bind })).rejects.toBeInstanceOf(ConflictError);
    expect(h.spawned).toHaveLength(0);
  });

  test("no autostart worker errors actionably", async () => {
    const h = harness({ discoverWorkers: async () => [] });
    await expect(startDev(h.options)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("startDev — bootstrapping pinned ports", () => {
  test("a project with no .dev.config.json gets one assigned, then starts — the pithy init case", async () => {
    const calls: EnsureDevConfigOptions[] = [];
    const h = harness({
      loadDevConfig: async () => null,
      ensureDevConfig: async (options) => {
        calls.push(options);
        return config;
      },
    });

    const handle = await startDev(h.options);

    // Every discovered worker is offered, not just the autostart set, so a port survives an autostart flip.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.projectDir).toBe("/proj");
    expect(calls[0]?.workers.map((w) => w.name)).toEqual(["api", "web"]);
    expect(calls[0]?.existing).toBeNull();
    expect(handle.workers).toEqual([
      { name: "api", port: 8787, origin: "http://localhost:8787" },
      { name: "web", port: 8788, origin: "http://localhost:8788" },
    ]);
    expect(h.spawned).toHaveLength(2);
  });

  test("a worker missing from an existing config is topped up from that config, stickily", async () => {
    const partial: DevConfig = { ...config, workers: { api: config.workers.api as DevConfig["workers"][string] } };
    const calls: EnsureDevConfigOptions[] = [];
    const h = harness({
      loadDevConfig: async () => partial,
      ensureDevConfig: async (options) => {
        calls.push(options);
        return config;
      },
    });

    await startDev(h.options);
    expect(calls[0]?.existing).toEqual(partial);
  });

  test("a complete config is used as-is — no reassignment", async () => {
    const ensure = vi.fn();
    const h = harness({ ensureDevConfig: ensure });
    await startDev(h.options);
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe("ensureDevConfig", () => {
  /**
   * A temp project dir plus its own registry, so nothing touches the real repo — or, since #435, the
   * operator's own config directory. `blocks()` reads the branches filed under this checkout, which is
   * the registry's outer key now.
   */
  async function project() {
    const dir = await mkdtemp(join(tmpdir(), "pithy-dev-bootstrap-"));
    const registryPath = join(dir, "config", "dev-ports.json");
    return {
      dir,
      registryPath,
      registry: async () => JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry,
      blocks: async () => (JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry)[dir] ?? {},
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  test("allocates a block and pins one port per worker with no git branch to key on", async () => {
    const p = await project();
    try {
      const dev = await ensureDevConfig({
        projectDir: p.dir,
        workers,
        existing: null,
        registryPathFor: async () => p.registryPath,
        rootFor: async () => p.dir,
        branchFor: async () => null,
      });

      expect(dev.workers.api).toEqual({ port: 8787, origin: "http://localhost:8787" });
      expect(dev.workers.web).toEqual({ port: 8788, origin: "http://localhost:8788" });
      expect(await readDevConfig(devConfigPath(p.dir))).toEqual(dev);
      // Off a branch the checkout path is the registry key — one block per checkout, still centrally locked.
      expect((await p.blocks())[`local:${p.dir}`]).toEqual({ block: 0, base: 8787, size: BLOCK_SIZE });
    } finally {
      await p.cleanup();
    }
  });

  test("is idempotent — a second run reuses the same block and the same ports", async () => {
    const p = await project();
    try {
      const deps = {
        projectDir: p.dir,
        workers,
        registryPathFor: async () => p.registryPath,
        rootFor: async () => p.dir,
        branchFor: async () => "main",
      };
      const first = await ensureDevConfig({ ...deps, existing: null });
      const again = await ensureDevConfig({ ...deps, existing: await readDevConfig(devConfigPath(p.dir)) });

      expect(again).toEqual(first);
      expect(Object.keys(await p.blocks())).toEqual(["main"]);
      // One checkout, one key: the file is machine-wide now and this project must occupy exactly its own.
      expect(Object.keys(await p.registry())).toEqual([p.dir]);
    } finally {
      await p.cleanup();
    }
  });

  test("reclaims a block a worktree still holds, scanning the checkout and not the registry's own directory", async () => {
    // The scan used to be handed `dirname(registryPath)`, which was the main repo root only because the
    // registry sat in it. With the file in the config directory that argument resolves to `~/.config/pithy`
    // — a directory with no `.worktrees` and never one — so `scanPinnedBlocks` would return `[]` forever
    // and reclaim would short-circuit before it even took the lock. No error, no changed return value:
    // self-healing simply dead, surfacing much later as a live feature's ports handed to a new one (#435).
    const p = await project();
    try {
      const pinned = join(p.dir, ".worktrees", "12-live");
      await mkdir(pinned, { recursive: true });
      await writeFile(
        devConfigPath(pinned),
        JSON.stringify({
          version: 1,
          branch: "feature/12-live",
          ports: { index: 0, base: 8787, size: BLOCK_SIZE },
          workers: { api: { port: 8787, origin: "http://localhost:8787" } },
        }),
        "utf8",
      );

      const dev = await ensureDevConfig({
        projectDir: p.dir,
        workers,
        existing: null,
        registryPathFor: async () => p.registryPath,
        rootFor: async () => p.dir,
        branchFor: async () => "main",
      });

      // Block 0 is spoken for by the live worktree, so this run must not be handed it.
      expect(dev.ports.index).not.toBe(0);
      expect((await p.blocks())["feature/12-live"]).toEqual({ block: 0, base: 8787, size: BLOCK_SIZE });
    } finally {
      await p.cleanup();
    }
  });

  test("re-registers a pinned block the registry has lost, since a settled project never allocates", async () => {
    // The registry is machine-wide, so it can lose this project's entry to something this project never
    // did — a wiped config directory, a new machine, a moved checkout another project's allocation pruned
    // as gone. The whole reclaim used to sit on the no-config path, which a settled project never takes,
    // so `pithy dev` repaired nothing and a live feature's ports stayed on offer to whoever allocated
    // next (#435).
    const p = await project();
    try {
      const existing: DevConfig = {
        version: 1,
        branch: "feature/12-live",
        ports: { index: 0, base: 8787, size: BLOCK_SIZE },
        workers: { api: { port: 8787, origin: "http://localhost:8787" } },
      };

      await ensureDevConfig({
        projectDir: p.dir,
        workers,
        existing,
        registryPathFor: async () => p.registryPath,
        rootFor: async () => p.dir,
        branchFor: async () => "feature/12-live",
      });

      expect((await p.blocks())["feature/12-live"]).toEqual({ block: 0, base: 8787, size: BLOCK_SIZE });
    } finally {
      await p.cleanup();
    }
  });

  test("a lost registry it cannot write is not a reason to refuse to start", async () => {
    // The ports are already pinned and are verified on both stacks before anything binds, so an
    // unwritable config directory must leave `pithy dev` working off the config alone — as it did before
    // this path touched the registry at all.
    const p = await project();
    try {
      const existing: DevConfig = {
        version: 1,
        branch: "feature/12-live",
        ports: { index: 0, base: 8787, size: BLOCK_SIZE },
        workers: { api: { port: 8787, origin: "http://localhost:8787" } },
      };

      const dev = await ensureDevConfig({
        projectDir: p.dir,
        workers,
        existing,
        registryPathFor: async () => {
          throw new Error("config directory is unwritable");
        },
        rootFor: async () => p.dir,
        branchFor: async () => "feature/12-live",
      });

      expect(dev.workers.api?.port).toBe(8787);
    } finally {
      await p.cleanup();
    }
  });

  test("a worker added later takes a free port from the same block and never moves a sibling", async () => {
    const p = await project();
    try {
      const existing: DevConfig = {
        version: 1,
        branch: "feature/73-cli-commands",
        ports: { index: 0, base: 8787, size: 10 },
        workers: { web: { port: 8788, origin: "http://localhost:8788" } },
      };
      const dev = await ensureDevConfig({
        projectDir: p.dir,
        workers,
        existing,
        registryPathFor: async () => p.registryPath,
        rootFor: async () => p.dir,
        branchFor: async () => "some/other-branch",
      });

      expect(dev.branch).toBe("feature/73-cli-commands");
      expect(dev.workers.web?.port).toBe(8788);
      expect(dev.workers.api?.port).toBe(8787);
      // The pinned block is re-registered, never re-keyed: the branch the config names, not the branch
      // git is on. Allocating would have taken `some/other-branch` and moved every worker's address.
      expect(await p.blocks()).toEqual({ "feature/73-cli-commands": { block: 0, base: 8787, size: 10 } });
    } finally {
      await p.cleanup();
    }
  });
});

describe("startDev — spawn commands and env", () => {
  test("wrangler worker gets `wrangler dev --port … --inspector-port 0`; custom command runs verbatim", async () => {
    const h = harness();
    await startDev(h.options);
    const api = h.spawned.find((s) => s.opts.cwd === "/proj/apps/api");
    const web = h.spawned.find((s) => s.opts.cwd === "/proj/apps/web");
    expect(api).toMatchObject({
      command: "bun",
      args: [
        "x",
        "wrangler",
        "dev",
        "--port",
        "8787",
        "--inspector-port",
        "0",
        // One local store for the whole project, not one per apps/<name>/ — so workers that share a
        // binding share the data locally too.
        "--persist-to",
        join("/proj", ".wrangler", "state"),
        // The Worker's own address, from this checkout's allocation. It cannot derive it (`Host` is
        // caller-controlled) and it cannot write it down (a port is allocated per checkout), so this
        // is the only place it can come from — #462.
        "--var",
        "BASE_URL:http://localhost:8787",
      ],
    });
    expect(web).toMatchObject({ command: "vite", args: ["--host"] });
  });

  test("a second checkout's workers are told that checkout's origin, not the first one's", async () => {
    // The whole defect, at the layer that spawns. Two checkouts get two port blocks, so a `BASE_URL`
    // written down in `wrangler.jsonc` is right in one of them and wrong in the other — and the Worker
    // that believed it signed control-plane tokens as somebody else (`pithy-sh/dashboard#95`).
    const h = harness({
      loadDevConfig: async () => ({
        ...config,
        ports: { index: 1, base: 8807, size: 10 },
        workers: {
          api: { port: 8807, origin: "http://localhost:8807" },
          web: { port: 8808, origin: "http://localhost:8808" },
        },
      }),
    });
    await startDev(h.options);

    const api = h.spawned.find((s) => s.opts.cwd === "/proj/apps/api");
    expect(api?.args).toContain("BASE_URL:http://localhost:8807");
    expect(api?.args).not.toContain("BASE_URL:http://localhost:8787");
  });

  test("every child env carries each worker's *_PORT and *_ORIGIN", async () => {
    const h = harness();
    await startDev(h.options);
    const env = h.spawned[0]?.opts.env ?? {};
    expect(env.API_PORT).toBe("8787");
    expect(env.API_ORIGIN).toBe("http://localhost:8787");
    expect(env.WEB_PORT).toBe("8788");
    expect(env.WEB_ORIGIN).toBe("http://localhost:8788");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("every child env carries the project's Cloudflare credentials, not the shell's (#555)", async () => {
    // The defect, at the only place it is observable: the environment handed to `spawn`. `pithy dev`
    // copied the parent environment wholesale and added the port table, so `wrangler dev` authenticated
    // as whatever the shell held — and on a machine with two accounts a magic link went out through a
    // tenant that does not own the sending domain, five times, with nothing said.
    const h = harness();
    await startDev({
      ...h.options,
      baseEnv: { PATH: "/usr/bin", CLOUDFLARE_ACCOUNT_ID: "shell-account", CLOUDFLARE_API_TOKEN: "shell-token" },
    });
    const env = h.spawned[0]?.opts.env ?? {};
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("acct-1");
    expect(env.CLOUDFLARE_API_TOKEN).toBe("t");
    // And the rest of the environment still arrives: this replaces two keys, not a PATH.
    expect(env.PATH).toBe("/usr/bin");
  });

  test("**says nothing about overriding what the shell exported — the project's account is the expectation**", async () => {
    // This used to print a line whenever the shell held `CLOUDFLARE_*`, and a developer whose shell holds
    // a token for other work saw it on every run, forever, announcing that the normal thing happened.
    // The environment still overrides — the test above asserts the child gets the project's credentials —
    // and the case where the account is genuinely in question is the refusal below, which is a throw.
    const h = harness({
      devCloudflareEnv: (_account, base) => ({
        env: { ...(base as Record<string, string>), CLOUDFLARE_ACCOUNT_ID: "acct-1", CLOUDFLARE_API_TOKEN: "t" },
        identity: { accountId: "acct-1", hasToken: true, mismatch: null },
        overridden: ["CLOUDFLARE_API_TOKEN"],
      }),
    });
    await startDev(h.options);
    const said = [...h.stdoutLines, ...h.logLines].join("");
    expect(said).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(said).not.toContain("acct-1");
  });

  test("a pinned account the credentials contradict refuses before a single worker spawns", async () => {
    // #206's refusal, reaching `pithy dev` for the first time. It resolved no account at all before, so
    // there was nothing to compare — and the disagreement surfaced as five failed sends instead.
    const h = harness({
      devCloudflareEnv: () => {
        throw new ConflictError({ message: "This project pins Cloudflare account A, and the file supplies B." });
      },
    });
    await expect(startDev(h.options)).rejects.toThrow(/pins Cloudflare account A/);
    expect(h.spawned).toHaveLength(0);
  });

  test("children are spawned detached (process-group leaders)", async () => {
    const h = harness();
    await startDev(h.options);
    expect(h.spawned.every((s) => s.opts.detached)).toBe(true);
  });
});

/** Drive both fake workers past their ready signals, so the banner fires. */
async function signalReady(h: ReturnType<typeof harness>): Promise<void> {
  const child = (dir: string): FakeChild => {
    const entry = h.spawned.find((s) => s.opts.cwd === dir);
    if (!entry) throw new Error(`no worker spawned in ${dir}`);
    return entry.child;
  };
  child("/proj/apps/api").stdout.write("Ready on http://localhost:8787\n");
  child("/proj/apps/web").stdout.write("VITE ready in 300 ms\n");
  await flush();
}

/**
 * The claim the seed minted — a credential, and the value these tests hold the output against.
 *
 * `#572` put it in the URL, because the artifact is a file and a Worker has no filesystem to read it
 * from. It stays out of the terminal in every run that can open a browser itself, which is what the
 * assertions below are about; `dev/devLogin.ts` carries the boundary and `claimIsPrinted` names it.
 */
const CLAIM = "eyJ1IjoiZXhhbXBsZS1hZGEifQ%3D%3D.c2ln";

/** What `pithy seed` wrote, as `readDevLogins` hands it over — a record keyed by user id (`#667`). */
const seededLogin = async () => ({
  "example-ada": {
    email: "ada@example.com",
    userId: "example-ada",
    claim: CLAIM,
    expiresAt: new Date("2027-07-27T00:00:00.000Z"),
  },
});

/** A record of `count` seeded identities — the shape that gives `l` something to ask about. */
function seededLogins(count: number) {
  return async () =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const userId = `example-${index + 1}`;
        return [
          userId,
          {
            email: `user${index + 1}@example.com`,
            userId,
            claim: `${CLAIM}-${index + 1}`,
            expiresAt: new Date("2027-07-27T00:00:00.000Z"),
          },
        ];
      }),
    );
}

/** A key reader that hands its bindings back, so a test can press a key without a terminal. */
function pressable(): {
  readKeys: StartDevOptions["readKeys"];
  press: (key: string) => Promise<void>;
  stops: number;
  readerCount: number;
} {
  const state = { bindings: [] as { key: string; run: () => void | Promise<void> }[], stops: 0, readers: 0 };
  return {
    readKeys: (options) => {
      state.bindings = [...options.bindings];
      state.readers += 1;
      return {
        active: true,
        stop: () => {
          state.stops += 1;
        },
      };
    },
    press: async (key) => {
      await state.bindings.find((binding) => binding.key === key)?.run();
      await flush();
    },
    get stops() {
      return state.stops;
    },
    get readerCount() {
      return state.readers;
    },
  };
}

describe("startDev — the l keypress", () => {
  test("**with several identities, l numbers them and a digit opens the one it named**", async () => {
    // `#667`. The user axis composes in front of the worker logic: `l` resolves *who*, and what happens
    // then is the same four shapes it always was.
    const keys = pressable();
    const opened: string[] = [];
    const h = harness({
      readDevLogins: seededLogins(3),
      readKeys: keys.readKeys,
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");
    expect(h.stdoutLines).toContain("Which identity? Press 1–3.");
    expect(h.stdoutLines).toContain("  2  user2@example.com");
    // Naming the identities is not printing their claims: the list is emails, and the URL is opened.
    for (const line of h.stdoutLines) expect(line).not.toContain(CLAIM);

    await keys.press("2");
    expect(opened).toEqual([`http://localhost:8787/__pithy/dev-login?t=${CLAIM}-2`]);
    expect(h.stdoutLines).toContain("Opening the dev login for user2@example.com.");
  });

  test("**one digit consumes the choice, so a later stray digit opens nothing**", async () => {
    // Press `l`, read the list, then think better of it. The arm must not outlive the interaction: a port
    // number typed or pasted into the terminal an hour later would otherwise open a signed-in browser as
    // whoever that index happens to name.
    const keys = pressable();
    const opened: string[] = [];
    const h = harness({
      readDevLogins: seededLogins(3),
      readKeys: keys.readKeys,
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");
    await keys.press("9"); // out of range: consumes the choice and opens nothing
    expect(opened).toEqual([]);
    await keys.press("2"); // no longer armed
    expect(opened).toEqual([]);

    // And `l` re-arms, so declining a choice never costs the feature.
    await keys.press("l");
    await keys.press("2");
    expect(opened).toEqual([`http://localhost:8787/__pithy/dev-login?t=${CLAIM}-2`]);
  });

  test("**refuses before asking who, when nothing it could open is running**", async () => {
    // The refusal is about what is running, and no identity changes it. Asking first would make somebody
    // choose and then be told there was nothing to open.
    const keys = pressable();
    const h = harness({
      readDevLogins: seededLogins(3),
      devLoginTargets: async () => [],
      readKeys: keys.readKeys,
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");
    expect(h.stdoutLines).toContain("No running worker composes auth, so there is nothing to open.");
    expect(h.stdoutLines).not.toContain("Which identity? Press 1–3.");
  });

  test("a digit before `l` opens nothing, because no choice is pending", async () => {
    const keys = pressable();
    const opened: string[] = [];
    const h = harness({
      readDevLogins: seededLogins(3),
      readKeys: keys.readKeys,
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("2");
    expect(opened).toEqual([]);
  });

  test("one identity opens straight away, with no choice to make", async () => {
    // The acceptance criterion the whole design turns on: a project seeding one user behaves as it did
    // before there was an axis at all.
    const keys = pressable();
    const opened: string[] = [];
    const h = harness({
      readDevLogins: seededLogins(1),
      readKeys: keys.readKeys,
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");
    expect(opened).toEqual([`http://localhost:8787/__pithy/dev-login?t=${CLAIM}-1`]);
    expect(h.stdoutLines).not.toContain("Which identity? Press 1–1.");
  });

  test("**ten or more identities get the filterable select**, and the chosen one opens", async () => {
    const keys = pressable();
    const opened: string[] = [];
    const asked: number[] = [];
    const h = harness({
      readDevLogins: seededLogins(12),
      readKeys: keys.readKeys,
      openUrl: async (url) => void opened.push(url),
      chooseDevLogin: async (logins) => {
        asked.push(logins.length);
        return "example-7";
      },
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");
    expect(asked).toEqual([12]);
    expect(opened).toEqual([`http://localhost:8787/__pithy/dev-login?t=${CLAIM}-7`]);
  });

  test("the select gives the terminal back while it runs, and takes it again after", async () => {
    // A `@clack/prompts` prompt reads its own stdin, so raw mode has to come off for it and go back on
    // afterwards — otherwise the session is left with a terminal nobody owns.
    const keys = pressable();
    const h = harness({
      readDevLogins: seededLogins(12),
      readKeys: keys.readKeys,
      chooseDevLogin: async () => {
        expect(keys.stops).toBe(1);
        return undefined;
      },
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");
    expect(keys.readerCount).toBe(2);
  });

  test("a value the select hands back that names nobody is refused by name, and opens nothing", async () => {
    const keys = pressable();
    const opened: string[] = [];
    const h = harness({
      readDevLogins: seededLogins(12),
      readKeys: keys.readKeys,
      openUrl: async (url) => void opened.push(url),
      chooseDevLogin: async () => "nobody@example.com",
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");
    expect(opened).toEqual([]);
    expect(h.stdoutLines.some((line) => line.includes("No seeded identity is nobody@example.com."))).toBe(true);
  });

  test("**a session that shut down while the select was open does not take the terminal back**", async () => {
    // `keys.stop()` is what gives the terminal its own Ctrl-C handling back, and shutdown calls it. If the
    // prompt then restarted a reader on its way out, the process would exit with raw mode still on and
    // leave a shell that echoes nothing — the failure `stop()` exists to prevent, reached from the far side.
    const keys = pressable();
    let handle: Awaited<ReturnType<typeof startDev>> | undefined;
    const h = harness({
      readDevLogins: seededLogins(12),
      readKeys: keys.readKeys,
      chooseDevLogin: async () => {
        await handle?.shutdown("interrupted");
        return undefined;
      },
    });
    handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");
    expect(keys.readerCount).toBe(1);
  });

  test("a canceled select opens nothing and says so", async () => {
    const keys = pressable();
    const opened: string[] = [];
    const h = harness({
      readDevLogins: seededLogins(12),
      readKeys: keys.readKeys,
      openUrl: async (url) => void opened.push(url),
      chooseDevLogin: async () => undefined,
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");
    expect(opened).toEqual([]);
    expect(h.stdoutLines).toContain("Nothing opened.");
  });

  test("opens the worker that carries the route, and says what it opened", async () => {
    const keys = pressable();
    const opened: string[] = [];
    const h = harness({
      readDevLogins: seededLogin,
      readKeys: keys.readKeys,
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");

    // The claim rides in the URL the browser is handed, and in nothing the terminal prints — `#572`.
    expect(opened).toEqual([`http://localhost:8787/__pithy/dev-login?t=${CLAIM}`]);
    expect(h.stdoutLines).toContain("Opening the dev login for ada@example.com.");
  });

  test("names pithy seed rather than opening a URL that 404s", async () => {
    const keys = pressable();
    const opened: string[] = [];
    const h = harness({
      readDevLogins: async () => undefined,
      readKeys: keys.readKeys,
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");

    expect(opened).toEqual([]);
    expect(h.stdoutLines).toContain("No dev login is seeded. Run pithy seed, then press l again.");
  });

  test("a browser that will not open is a sentence, not a dead session", async () => {
    const keys = pressable();
    const h = harness({
      readDevLogins: seededLogin,
      readKeys: keys.readKeys,
      openUrl: () => Promise.reject(new ValidationError({ message: "Could not open a browser." })),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");

    expect(h.stdoutLines).toContain("Could not open a browser.");
    // The supervisor is still up: no browser is not a reason to tear a dev session down.
    expect(h.stdoutLines).not.toContain("Stopping — interrupted.");
  });

  test("gives the terminal back on shutdown, before anything that can take time", async () => {
    const keys = pressable();
    const h = harness({ readDevLogins: seededLogin, readKeys: keys.readKeys });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.shutdown("interrupted");

    expect(keys.stops).toBe(1);
  });

  test("Ctrl-C still stops the session — raw mode is what takes that away", async () => {
    let interrupt: (() => void) | undefined;
    const h = harness({
      readDevLogins: seededLogin,
      readKeys: (options) => {
        interrupt = options.onInterrupt;
        return { active: true, stop: () => {} };
      },
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    interrupt?.();
    await handle.closed;

    expect(h.stdoutLines).toContain("Stopping — interrupted.");
  });

  test("under CI it offers nothing and opens nothing — the capability registers no route there", async () => {
    const keys = pressable();
    const opened: string[] = [];
    const h = harness({
      readDevLogins: seededLogin,
      baseEnv: { PATH: "/usr/bin", CI: "true" },
      readKeys: keys.readKeys,
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    expect(h.stdoutLines).toContain("Dev login: ada@example.com — the dev-login route is not registered under CI.");

    await keys.press("l");
    expect(opened).toEqual([]);
    expect(h.stdoutLines).toContain("Not opening — the dev-login route is not registered under CI.");
  });

  test("--json enters no raw mode at all — its output is being read by a script", async () => {
    let started = false;
    const h = harness({
      json: true,
      readDevLogins: seededLogin,
      readKeys: () => {
        started = true;
        return { active: true, stop: () => {} };
      },
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    expect(started).toBe(false);
  });
});

describe("startDev — ready banner", () => {
  test("fires only once every started worker matches its ready signal", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    const api = h.spawned.find((s) => s.opts.cwd === "/proj/apps/api")?.child as FakeChild;
    const web = h.spawned.find((s) => s.opts.cwd === "/proj/apps/web")?.child as FakeChild;

    api.stdout.write("Ready on http://localhost:8787\n");
    await flush();
    expect(h.stdoutLines).not.toContain("Ready.");

    web.stdout.write("VITE ready in 300 ms\n");
    await flush();
    await handle.ready;
    expect(h.stdoutLines.filter((l) => l === "Ready.")).toHaveLength(1);
    expect(h.stdoutLines).toContain("api: http://localhost:8787");
    expect(h.stdoutLines).toContain("web: http://localhost:8788");

    // A further matching line does not re-print the banner.
    web.stdout.write("ready in 5 ms\n");
    await flush();
    expect(h.stdoutLines.filter((l) => l === "Ready.")).toHaveLength(1);
  });

  test("offers the seeded dev login, so the banner is where signing in is discovered", async () => {
    const h = harness({ readDevLogins: seededLogin });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    // No terminal in this harness, so the URL is what the banner can honestly offer.
    expect(h.stdoutLines).toContain(
      `Dev login: ada@example.com — open http://localhost:8787/__pithy/dev-login?t=${CLAIM} to sign in.`,
    );
  });

  test("no session cookie reaches the terminal or logs/dev.log", async () => {
    // The reason this feature exists. `pithy dev`'s output is read, piped, tee'd and screenshotted, so a
    // session token printed once is a session token at rest. Since `#572` the seed mints none at all.
    const h = harness({ readDevLogins: seededLogin });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    for (const line of [...h.stdoutLines, ...h.logLines]) {
      expect(line).not.toContain("better-auth.session_token");
      expect(line).not.toContain("document.cookie");
    }
  });

  test("**and neither does the claim, on the run that can open a browser itself**", async () => {
    // The interactive single-worker run — the ordinary one. The URL goes to `openUrl`; the terminal is
    // told a name. A non-interactive run has no keypress and must print a link, which is the documented
    // boundary rather than a leak.
    const h = harness({ readDevLogins: seededLogin, readKeys: () => ({ active: true, stop: () => {} }) });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    for (const line of [...h.stdoutLines, ...h.logLines]) expect(line).not.toContain(CLAIM);
  });

  test("offers the keypress where there is a terminal to press it on", async () => {
    const h = harness({ readDevLogins: seededLogin, readKeys: () => ({ active: true, stop: () => {} }) });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    expect(h.stdoutLines).toContain("Dev login: ada@example.com — press l to open a signed-in browser.");
  });

  test("says so rather than offering a keypress when no running worker composes auth", async () => {
    const h = harness({
      readDevLogins: seededLogin,
      devLoginTargets: async () => [],
      readKeys: () => ({ active: true, stop: () => {} }),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    expect(h.stdoutLines).toContain(
      "Dev login: ada@example.com — no running worker composes auth, so there is nothing to open.",
    );
  });

  test("says nothing about signing in when no seed wrote a login", async () => {
    const h = harness({ readDevLogins: async () => undefined });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    expect(h.stdoutLines.some((line) => line.startsWith("Dev login:"))).toBe(false);
  });
});

describe("startDev — ready deadline", () => {
  /** Start a session where `api` comes up and `web` never does — a worker whose build failed. */
  async function halfReady(overrides: Partial<StartDevOptions> = {}) {
    const h = harness(overrides);
    const handle = await startDev(h.options);
    const api = h.spawned.find((s) => s.opts.cwd === "/proj/apps/api")?.child as FakeChild;
    api.stdout.write("Ready on http://localhost:8787\n");
    await flush();
    return { h, handle };
  }

  test("names the worker that started and never became ready", async () => {
    const { h } = await halfReady();
    expect(h.stdoutLines.some((line) => line.startsWith("Still waiting on:"))).toBe(false);

    h.advance(READY_DEADLINE_MS);

    expect(h.stdoutLines).toContain("Still waiting on: web.");
    // The set, never the count — and the reason nothing else in the session was going to say it.
    expect(h.stdoutLines.some((line) => line.includes("keeps running, so nothing else reports it"))).toBe(true);
  });

  test("repeats the line while it stays true — one report scrolls away like the error did", async () => {
    const { h } = await halfReady();
    h.advance(READY_DEADLINE_MS);
    h.advance(READY_REMINDER_MS);
    h.advance(READY_REMINDER_MS);
    expect(h.stdoutLines.filter((line) => line === "Still waiting on: web.")).toHaveLength(3);
  });

  test("the report lands in logs/dev.log too, and carries no color when it gets there", async () => {
    // **Forcing color on is what makes this testable at all.** `terminal/style.ts` latches its decision
    // at import from `process.stdout.isTTY`, and no test runner has a TTY — so under the ordinary import
    // `dim()` is the identity function, nothing on this path ever produces an escape sequence, and
    // "the log carries no ANSI" is equally true of a build that strips it and one that never did. The
    // assertion was empty for exactly that reason. With `FORCE_COLOR` set and the module graph rebuilt,
    // the action lines really are wrapped, the terminal and the log say different bytes, and only one of
    // them may carry the escape — which is the claim.
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    vi.resetModules();
    const { startDev: startDevInColor } = await import("./orchestrator");

    const h = harness();
    await startDevInColor(h.options);
    const api = h.spawned.find((s) => s.opts.cwd === "/proj/apps/api")?.child as FakeChild;
    api.stdout.write("Ready on http://localhost:8787\n");
    await flush();
    h.advance(READY_DEADLINE_MS);

    const action = "  A worker that never becomes ready keeps running, so nothing else reports it.";
    // The guard on the guard: color really is on for this run, so nothing below can pass vacuously.
    expect(h.stdoutLines).toContain(`\x1b[2m${action}\x1b[22m`);
    expect(h.logLines).toContain("Still waiting on: web.");
    expect(h.logLines).toContain(action);
    expect(h.logLines.filter((line) => line.includes("\x1b"))).toEqual([]);
  });

  test("--json gets a record, not the prose — the agent's half of the report", async () => {
    // A session that never emits its ready line, read by a script: the sentence a person gets is not an
    // answer, so the deadline writes one JSON line per report. `logs/dev.log` still gets the prose.
    const { h } = await halfReady({ json: true });
    h.advance(READY_DEADLINE_MS);

    const records = h.stdoutLines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as unknown);
    expect(records).toEqual([{ command: "dev", event: "still-waiting", waiting: ["web"] }]);
    // And no prose report on stdout to confuse a reader parsing line by line.
    expect(h.stdoutLines.some((line) => line.startsWith("Still waiting on:"))).toBe(false);
    expect(h.logLines).toContain("Still waiting on: web.");
  });

  /**
   * **A session's stdout is a stream, and `--json` pretty-printing must not reframe it (#666).**
   *
   * `docs/commands/dev.md` §`--json` promises one object per line, because a session never ends and a
   * consumer can only read it line by line. When `--json` learned to indent for a person, this emitter
   * was global and latched — so at a terminal, or under any PTY-allocating agent harness, every record
   * here became a multi-line painted blob and the first line a consumer read was `{`.
   */
  test("stays one compact line per record even when this run is latched pretty", async () => {
    const { latchJsonFormat } = await import("../terminal/output");
    latchJsonFormat({ stdout: { mode: "pretty", color: true }, stderr: { mode: "pretty", color: true } });
    try {
      const { h } = await halfReady({ json: true });
      h.advance(READY_DEADLINE_MS);

      const records = h.stdoutLines.filter((line) => line.startsWith("{"));
      expect(records).toEqual(['{"command":"dev","event":"still-waiting","waiting":["web"]}']);
      // The guard that matters to a consumer: nothing it reads line by line can be a fragment.
      for (const line of h.stdoutLines) expect(line).not.toContain("\n");
      expect(records.map((line) => JSON.parse(line) as unknown)).toEqual([
        { command: "dev", event: "still-waiting", waiting: ["web"] },
      ]);
    } finally {
      latchJsonFormat({ stdout: { mode: "compact", color: false }, stderr: { mode: "compact", color: false } });
    }
  });

  test("a cold first build that arrives in time produces no report", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    // Nothing is left ticking once the banner has fired — the watch is stopped there, not left to wake
    // up at the deadline and find its set empty.
    expect(h.pendingTimers()).toBe(0);
    h.advance(READY_DEADLINE_MS * 10);
    expect(h.stdoutLines.some((line) => line.startsWith("Still waiting on:"))).toBe(false);
  });

  test("the worker that never arrives is reported, never killed — the session keeps supervising", async () => {
    const { h } = await halfReady();
    h.advance(READY_DEADLINE_MS);
    h.advance(READY_REMINDER_MS);

    expect(h.killCalls).toEqual([]);
    expect(h.stdoutLines.some((line) => line.startsWith("Stopping"))).toBe(false);
    expect(h.removed).toEqual([]);
    // And the banner still fires if the worker does arrive — the watch reports, it does not condemn.
    const web = h.spawned.find((s) => s.opts.cwd === "/proj/apps/web")?.child as FakeChild;
    web.stdout.write("VITE ready in 300 ms\n");
    await flush();
    expect(h.stdoutLines).toContain("Ready.");
  });

  test("shutdown stops the watch — a torn-down session says nothing more", async () => {
    const { h, handle } = await halfReady();
    await handle.shutdown("interrupted");
    h.advance(READY_DEADLINE_MS * 2);
    expect(h.stdoutLines.some((line) => line.startsWith("Still waiting on:"))).toBe(false);
  });
});

describe("startDev — --json is a stream a script can parse", () => {
  /**
   * The rule `docs/commands/dev.md` states, held here: under `--json`, **every line on stdout is one JSON
   * object**. Nothing else in this session writes to stdout — not the `Starting …` line, not the delivery
   * verdict, and not the workers' own output, which is the bulk of the stream and every line wrangler and
   * Vite print. They go to stderr, where a person still sees them and no parser has to skip them.
   *
   * A doc sentence alone would not have survived the next line somebody adds. This is the gate on it.
   */
  test("stdout carries JSON and nothing else; the prose goes to stderr", async () => {
    const h = harness({ json: true });
    await startDev(h.options);
    const api = h.spawned.find((s) => s.opts.cwd === "/proj/apps/api")?.child as FakeChild;
    api.stdout.write("Ready on http://localhost:8787\n");
    api.stderr.write("▲ [WARNING] a warning wrangler prints\n");
    await flush();
    // The still-waiting record, which is the only thing `startDev` itself puts on stdout under `--json`.
    h.advance(READY_DEADLINE_MS);

    for (const line of h.stdoutLines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(h.stdoutLines).toContain('{"command":"dev","event":"still-waiting","waiting":["web"]}');
    expect(h.stderrLines).toContain("Starting api, web.");
    expect(h.stderrLines.some((line) => line.includes("a warning wrangler prints"))).toBe(true);
  });

  /** Without `--json` nothing moves: the terminal is the audience, and stderr stays empty. */
  test("the ordinary session still says everything on stdout", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    expect(h.stdoutLines).toContain("Starting api, web.");
    expect(h.stdoutLines).toContain("Ready.");
    expect(h.stderrLines).toEqual([]);
  });
});

describe("startDev — log tee", () => {
  test("log lines are ANSI-stripped and CR-normalized, prefixed with the worker name", async () => {
    const h = harness();
    await startDev(h.options);
    const api = h.spawned.find((s) => s.opts.cwd === "/proj/apps/api")?.child as FakeChild;
    api.stdout.write("\x1b[34mspinner\x1b[0m\rdone\n");
    await flush();
    expect(h.logLines).toContain("[api] spinner");
    expect(h.logLines).toContain("[api] done");
  });
});

describe("startDev — state", () => {
  test("writes .dev-state.json with pid, child pids, and per-worker port + pid", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    expect(h.written).toHaveLength(1);
    const state = h.written[0] as DevState;
    expect(state.pid).toBe(4242);
    expect(state.childPids).toEqual(h.spawned.map((s) => s.child.pid));
    expect(state.workers.api).toEqual({ port: 8787, pid: h.spawned[0]?.child.pid });
    expect(handle.state).toEqual(state);
  });
});

describe("startDev — re-run stops the previous session", () => {
  test("SIGINTs a live previous session before spawning", async () => {
    const prev: DevState = {
      pid: 3000,
      startedAt: "2026-07-26T00:00:00.000Z",
      childPids: [3001],
      workers: { api: { port: 8787, pid: 3001 } },
    };
    const h = harness();
    h.livePids.add(3000);
    h.setStored(prev);

    await startDev(h.options);
    const sigint = h.killCalls.find((k) => k.pid === 3000 && k.signal === "SIGINT");
    expect(sigint).toBeTruthy();
    // The previous session was stopped before this run wrote its own state.
    expect(h.spawned).toHaveLength(2);
  });

  test("the port sweep is told which pids were ours, so it reaps orphans and reports strangers", async () => {
    const prev: DevState = {
      pid: 3000,
      startedAt: "2026-07-26T00:00:00.000Z",
      childPids: [3001, 3002],
      workers: { api: { port: 8787, pid: 3001 } },
    };
    const sweepCalls: { ports: number[]; knownPids: readonly number[] }[] = [];
    const h = harness({
      sweep: async (ports, knownPids) => {
        sweepCalls.push({ ports, knownPids });
        return [];
      },
    });
    h.setStored(prev); // pid 3000 is not in livePids — a crashed session.

    await startDev(h.options);
    expect(sweepCalls).toEqual([{ ports: [8787, 8788], knownPids: [3001, 3002] }]);
  });
});

describe("startDev — shutdown", () => {
  test("SIGTERMs each child group and removes state race-safely", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    const pids = h.spawned.map((s) => s.child.pid);

    await handle.shutdown("test");
    await handle.closed;

    // Group kills use the negated pid (kill(-pgid)).
    for (const pid of pids) {
      expect(h.killCalls).toContainEqual({ pid: -pid, signal: "SIGTERM" });
    }
    expect(h.removed).toEqual([4242]);
  });

  test("a child exiting on its own triggers shutdown", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    const api = h.spawned[0]?.child as FakeChild;
    api.stdout.end();
    api.stderr.end();
    api.emit("exit", 1);
    await handle.closed;
    expect(h.removed).toEqual([4242]);
  });
});

describe("startDev — spawn error", () => {
  test("a spawn failure (missing dev.command binary) is reported and shuts down, never thrown", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    const api = h.spawned[0]?.child as FakeChild;

    // A ChildProcess emits 'error' (and never 'exit') when the binary is missing (ENOENT). Without an
    // 'error' listener Node would re-throw this as an uncaught exception, crashing dev.
    api.emit("error", new Error("spawn vite ENOENT"));
    await flush();
    await handle.closed;

    expect(h.stdoutLines.some((l) => l.includes("api failed to start"))).toBe(true);
    expect(h.removed).toEqual([4242]);
  });
});

describe("startDev — entitlement composition check", () => {
  test("a Worker gating routes with no provider composed is warned about, by file, before starting", async () => {
    const h = harness({
      checkEntitlements: async (dir) => (dir === "/proj/apps/api" ? ["src/routes/reports.ts"] : []),
    });
    await startDev(h.options);

    const warning = h.stdoutLines.findIndex((l) => l.includes("routes gate on an entitlement"));
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(h.stdoutLines[warning]).toContain("api:");
    expect(h.stdoutLines[warning + 1]).toContain("src/routes/reports.ts");
    expect(h.stdoutLines[warning + 2]).toContain("pithy add payments");
    // Reported before the run starts, so it is read rather than buried under worker output.
    expect(h.stdoutLines.findIndex((l) => l.startsWith("Starting "))).toBeGreaterThan(warning);
  });

  test("the warning does not stop the session — it is wiring, not a reason to refuse to run", async () => {
    const h = harness({ checkEntitlements: async () => ["src/routes/reports.ts"] });
    await startDev(h.options);
    expect(h.spawned.map((s) => s.opts.cwd)).toEqual(["/proj/apps/api", "/proj/apps/web"]);
  });

  test("no gap says nothing — the check is silent on the projects that are not paid", async () => {
    const h = harness({ checkEntitlements: async () => [] });
    await startDev(h.options);
    expect(h.stdoutLines.some((l) => l.includes("entitlement"))).toBe(false);
  });
});

describe("startDev — dev secrets", () => {
  /** An empty seeding report — the state of a project whose secrets are all already where they belong. */
  const quiet = {
    seeded: [],
    unchanged: [],
    minted: [],
    devVars: [],
    missing: [],
    undeclared: [],
    skipped: [],
  };

  test("seeds before anything spawns — a store filled after startup missed the first sign-in", async () => {
    const order: string[] = [];
    const h = harness({
      seedSecrets: async (dir) => {
        order.push(`seed:${dir}`);
        return { ...quiet, seeded: ["auth-session-secret"] };
      },
    });
    const spawn = h.options.spawn;
    h.options.spawn = (command, args, opts) => {
      order.push("spawn");
      return (spawn as NonNullable<typeof spawn>)(command, args, opts);
    };

    await startDev(h.options);

    expect(order[0]).toBe("seed:/proj");
    expect(order).toContain("spawn");
    expect(h.stdoutLines.some((l) => l.includes("Seeded auth-session-secret"))).toBe(true);
    // Before the Starting line, so it is read rather than buried under worker output.
    expect(h.stdoutLines.findIndex((l) => l.startsWith("Starting "))).toBeGreaterThan(
      h.stdoutLines.findIndex((l) => l.includes("Seeded")),
    );
  });

  test("a run that changed nothing is silent — pithy dev seeds on every start", async () => {
    const h = harness({ seedSecrets: async () => ({ ...quiet, unchanged: ["auth-session-secret"] }) });
    await startDev(h.options);
    expect(h.stdoutLines.some((l) => l.toLowerCase().includes("secret"))).toBe(false);
  });

  test("a malformed secrets file is said out loud and the session still starts", async () => {
    const h = harness({
      seedSecrets: async () => {
        throw new ValidationError({ message: "/cfg/pithy/acme/secrets.jsonc is not valid JSONC." });
      },
    });
    await startDev(h.options);

    expect(h.stdoutLines.some((l) => l.includes("Secrets not seeded"))).toBe(true);
    // One malformed file must not stop every Worker. The capability that needs the secret has its own error.
    expect(h.spawned.map((s) => s.opts.cwd)).toEqual(["/proj/apps/api", "/proj/apps/web"]);
  });

  test("a Worker whose store cannot be opened is named with the one thing it needs", async () => {
    const h = harness({
      seedSecrets: async () => ({ ...quiet, skipped: [{ worker: "api", reason: "Run pithy migrate." }] }),
    });
    await startDev(h.options);
    expect(h.stdoutLines.some((l) => l === "api: secrets not seeded. Run pithy migrate.")).toBe(true);
  });
});

describe("startDev — the .dev.vars a checkout cannot inherit", () => {
  /** A real project on disk: `pithy dev` writes real files, so nothing here is faked. */
  async function project(): Promise<{
    dir: string;
    config: string;
    apiDir: string;
    options: Partial<StartDevOptions>;
  }> {
    const dir = await mkdtemp(join(tmpdir(), "pithy-dev-vars-"));
    const configDir = await mkdtemp(join(tmpdir(), "pithy-dev-vars-config-"));
    const apiDir = join(dir, "apps", "api");
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
    await mkdir(join(configDir, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(join(configDir, "replay", "dev.json"), JSON.stringify({ vars: { SECRETS_ENCRYPTION_KEYS: "k" } }));
    return {
      dir,
      config: configDir,
      apiDir,
      options: {
        projectDir: dir,
        checkEntitlements: async () => [],
        discoverWorkers: async () => [
          { name: "api", dir: apiDir, hasWrangler: true, dev: { readySignal: "Ready on https?://" } },
        ],
        loadDevConfig: async () => ({ ...config, workers: { api: { port: 8787, origin: "http://localhost:8787" } } }),
        generateDevVars: (projectDir, workerDirs) =>
          generateDevVars({
            projectDir,
            workerDirs,
            paths: { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: configDir } },
          }),
      },
    };
  }

  test("a fresh clone gets its .dev.vars written for it, since the file can never be committed", async () => {
    // `.dev.vars` is git-ignored, so the second developer on a project clones and has none. There used
    // to be a symlink to make, which was also git-ignored, so nothing in the project re-made it and
    // wrangler reported every secret absent while the value sat at the root. Generated, the question
    // does not exist: `pithy dev` runs after the sources exist, every time.
    const { dir, config: configDir, apiDir, options } = await project();
    try {
      const h = harness(options);

      await startDev(h.options);

      const source = await readFile(join(apiDir, ".dev.vars"), "utf8");
      expect((await lstat(join(apiDir, ".dev.vars"))).isSymbolicLink()).toBe(false);
      expect(source).toContain("SECRETS_ENCRYPTION_KEYS=k");
      expect(source.startsWith(GENERATED_MARKER)).toBe(true);
      // Silence when it worked. A line per Worker per start is how a block stops being read.
      expect(h.stdoutLines.some((line) => line.includes(".dev.vars"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    }
  });

  test("a .dev.vars pithy did not write is named, never overwritten, and the session still starts", async () => {
    const { dir, config: configDir, apiDir, options } = await project();
    try {
      await writeFile(join(apiDir, ".dev.vars"), "API_ONLY_SECRET=super-secret-value\n");
      const h = harness(options);

      await startDev(h.options);

      expect(await readFile(join(apiDir, ".dev.vars"), "utf8")).toBe("API_ONLY_SECRET=super-secret-value\n");
      const said = h.stdoutLines.find((line) => line.includes(".dev.vars"));
      expect(said).toContain(join(apiDir, ".dev.vars"));
      expect(said).toContain(".dev.vars.local");
      // Reported, not fatal: one Worker's file is not a reason to refuse to run the project.
      expect(h.spawned).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    }
  });

  test("a second run writes no bytes — wrangler watches this file", async () => {
    const { dir, config: configDir, apiDir, options } = await project();
    try {
      await startDev(harness(options).options);
      const before = (await lstat(join(apiDir, ".dev.vars"))).mtimeMs;

      await startDev(harness(options).options);

      expect((await lstat(join(apiDir, ".dev.vars"))).mtimeMs).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe("startDev — a Worker whose config will not import", () => {
  test("says so, names the Worker, and states that it has no bindings (#199)", async () => {
    // The silent path this closes. Since #179 a `cf-secrets-store` secret is materialized only if the
    // Worker's `pithy.config.ts` imports — correct, because the registry decides which secrets a Worker
    // gets and an unreadable registry has no honest answer. But an unresolvable Worker reached the
    // generator as an empty target list, which is also what a project with no secrets looks like. So
    // `pithy dev` rewrote the Worker's `.dev.vars` down to its header, started it with no bindings at
    // all, and printed one line: `Starting replay-board.`
    //
    // The adopter breaking their own config is the *likely* reader of this, and they are mid-edit with
    // something else on their mind. The run that costs them their bindings has to be the run that says
    // so, and it has to say both halves in one sentence — there is no second block to correlate with.
    const h = harness({
      generateDevVars: async () => ({
        generated: [],
        unchanged: [],
        refused: [],
        relinked: [],
        names: [],
        unresolvable: ["replay-board: its pithy.config.ts did not import, so it starts with no bindings. Boom."],
      }),
    });

    await startDev(h.options);

    const said = h.stdoutLines.find((line) => line.includes("replay-board"));
    expect(said).toContain("no bindings");
    expect(said).toContain("did not import");
    // Reported, never fatal. One Worker's broken config is not a reason to refuse to run the project —
    // and refusing would take away the dev loop they are using to fix it.
    expect(h.spawned.length).toBeGreaterThan(0);
  });
});

describe("startDev — naming what starts", () => {
  /**
   * `--app` narrows what runs. It never narrows what gets a port, and it never narrows what the ports
   * are computed over — `buildDevConfig` rebuilds its map from `{}` rather than merging into the
   * previous one, so a narrowed call would delete every other member's pin and renumber the project on
   * the next full run. These are the cases that hold that line.
   */

  /** The dev config a project with an email host gets: the two apps plus the host, all pinned. */
  const withHost: DevConfig = {
    ...config,
    workers: { ...config.workers, email: { port: 8789, origin: "http://localhost:8789" } },
  };

  const emailHost = {
    capability: "email",
    sourceDir: "/proj/apps/api",
    spec: { capability: "email", entry: "@pithy-sh/email/src/workflows/worker", package: "@pithy-sh/email" },
    worker: {
      name: "email",
      dir: "/proj/.wrangler/pithy/hosts/email",
      hasWrangler: true,
      dev: { readySignal: "Ready on https?://" },
    },
  };

  function hosted(overrides: Partial<StartDevOptions> = {}) {
    return harness({
      loadDevConfig: async () => withHost,
      discoverHostWorkers: async () => ({ hosts: [emailHost as never], notes: [] }),
      ...overrides,
    });
  }

  test("starts exactly the workers it names", async () => {
    const h = harness();
    const handle = await startDev({ ...h.options, apps: ["web"] });

    expect(handle.workers).toEqual([{ name: "web", port: 8788, origin: "http://localhost:8788" }]);
    expect(h.spawned.map((s) => s.opts.cwd)).toEqual(["/proj/apps/web"]);
  });

  test("starts a named worker even when this branch has turned it off", async () => {
    const h = harness({});

    const handle = await startDev({ ...h.options, apps: ["web"], autostartOverrides: { web: false } });

    expect(handle.workers.map((w) => w.name)).toEqual(["web"]);
  });

  test("an unknown name refuses the whole run, above every write", async () => {
    const ensure = vi.fn();
    const openLog = vi.fn();
    const h = harness({ ensureDevConfig: ensure, loadDevConfig: async () => null });

    await expect(startDev({ ...h.options, openLog, apps: ["nope"] })).rejects.toMatchObject({
      payload: { code: "core/not_found" },
    });
    expect(h.spawned).toHaveLength(0);
    expect(ensure).not.toHaveBeenCalled();
    expect(openLog).not.toHaveBeenCalled();
  });

  test("never narrows what gets a port — the bootstrap seam still sees every member", async () => {
    const seen: EnsureDevConfigOptions[] = [];
    const h = hosted({
      loadDevConfig: async () => null,
      ensureDevConfig: async (o) => {
        seen.push(o);
        return withHost;
      },
    });

    await startDev({ ...h.options, apps: ["web"] });

    expect(seen[0]?.workers.map((w) => w.name)).toEqual(["api", "web", "email"]);
  });

  /**
   * The acceptance criterion's own test, against real disk and a real `ensureDevConfig`.
   *
   * A run of one hands that one worker exactly the port a run of all of them would, and leaves the file
   * byte-identical. It breaks silently if the member set ever narrows: `feature/devConfig.ts` rebuilds
   * `workers` from `{}`, so the file would stay valid, atomic and Zod-clean while holding one name.
   */
  test("a worker's port is the same every run, whatever else is running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-dev-app-"));
    try {
      const registryPath = join(dir, "config", "dev-ports.json");
      const ensureDeps = {
        registryPathFor: async () => registryPath,
        rootFor: async () => dir,
        branchFor: async () => "main",
      };
      const run = async (apps?: string[], set: WorkerTarget[] = workers) => {
        const h = harness({
          projectDir: dir,
          discoverWorkers: async () => set,
          loadDevConfig: (at: string) => readDevConfig(devConfigPath(at)),
          ensureDeps,
        });
        return startDev({ ...h.options, ...(apps ? { apps } : {}) });
      };

      const all = await run();
      const afterAll = await readDevConfig(devConfigPath(dir));

      // The case that actually discriminates: a worker added since the last run, named on its own. A
      // narrowed member set would hand `zeta` the block's first port — the one `api` already holds —
      // and write a file holding one name, so the next full run renumbers everything around it.
      const withZeta = [...workers, { name: "zeta", dir: "/proj/apps/zeta", hasWrangler: true }];
      const narrowed = await run(["zeta"], withZeta);
      const afterNarrowed = await readDevConfig(devConfigPath(dir));
      const again = await run(undefined, withZeta);

      expect(Object.keys(afterNarrowed?.workers ?? {}).sort()).toEqual(["api", "web", "zeta"]);
      expect(afterNarrowed?.workers.api).toEqual(afterAll?.workers.api);
      expect(afterNarrowed?.workers.web).toEqual(afterAll?.workers.web);
      expect(narrowed.workers).toEqual([{ name: "zeta", port: 8789, origin: "http://localhost:8789" }]);
      // And a full run after it hands every worker exactly what the narrowed run reported.
      expect(await readDevConfig(devConfigPath(dir))).toEqual(afterNarrowed);
      expect(again.workers).toEqual([
        all.workers[0] as (typeof all.workers)[number],
        all.workers[1] as (typeof all.workers)[number],
        { name: "zeta", port: 8789, origin: "http://localhost:8789" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("names a worker this branch turned off that has no pin, and it gets a port rather than a refusal", async () => {
    // `unpinned` is computed over every member, not over the autostart set — a turned-off or newly added
    // worker is invisible to that filter, so the bootstrap is skipped, `config` stays the partial one,
    // and the run dies on `no port in .dev.config.json`, whose action says to delete the file and
    // renumber everything.
    const partial: DevConfig = { ...config, workers: { api: config.workers.api as DevConfig["workers"][string] } };
    const ensure = vi.fn(async () => config);
    const h = harness({
      loadDevConfig: async () => partial,
      ensureDevConfig: ensure,
    });

    const handle = await startDev({ ...h.options, apps: ["web"] });

    expect(ensure).toHaveBeenCalled();
    expect(handle.workers).toEqual([{ name: "web", port: 8788, origin: "http://localhost:8788" }]);
  });

  test("is literal — naming an app Worker materializes no capability host", async () => {
    const materialize = vi.fn(async () => ({ notes: [], failed: [] }));
    const h = hosted({ materializeHostConfigs: materialize });

    await startDev({ ...h.options, apps: ["api"] });

    expect(materialize).not.toHaveBeenCalled();
    expect(h.spawned.map((s) => s.opts.cwd)).toEqual(["/proj/apps/api"]);
  });

  test("names a capability host, and starts exactly that host", async () => {
    const seen: MaterializeHostConfigsOptions[] = [];
    const h = hosted({
      materializeHostConfigs: async (o) => {
        seen.push(o);
        return { notes: [], failed: [] };
      },
    });

    const handle = await startDev({ ...h.options, apps: ["email"] });

    expect(handle.workers.map((w) => w.name)).toEqual(["email"]);
    expect(seen[0]?.hosts.map((host) => host.worker.name)).toEqual(["email"]);
  });

  test("the app it builds links against is one a plain run would start, not merely one with a port", async () => {
    // `admin` sorts first and is pinned, but this branch turned it off — so it is not where the app
    // answers.
    // Picking it would make `pithy dev` and `pithy dev --app email` disagree about the same project,
    // and mail a magic link to an address nobody runs.
    const admin: WorkerTarget = {
      name: "admin",
      dir: "/proj/apps/admin",
      hasWrangler: true,
      dev: { readySignal: "Ready on https?://" },
    };
    const seen: MaterializeHostConfigsOptions[] = [];
    const h = hosted({
      discoverWorkers: async () => [admin, ...workers],
      loadDevConfig: async () => ({
        ...withHost,
        workers: { ...withHost.workers, admin: { port: 8790, origin: "http://localhost:8790" } },
      }),
      materializeHostConfigs: async (o) => {
        seen.push(o);
        return { notes: [], failed: [] };
      },
    });

    await startDev({ ...h.options, apps: ["email"], autostartOverrides: { admin: false } });

    expect(seen[0]?.baseUrl).toBe("http://localhost:8787");
  });

  test("falls back to any pinned app when no app autostarts — never to the host's own address", async () => {
    // Every app Worker turned off on this branch (run by hand under a debugger, say), so there is no
    // autostart app to prefer. The chain used to end at `started[0]`, which in this run is the host
    // itself — a Worker holding no public route, and the exact failure the fallback exists to prevent.
    const seen: MaterializeHostConfigsOptions[] = [];
    const h = hosted({
      materializeHostConfigs: async (o) => {
        seen.push(o);
        return { notes: [], failed: [] };
      },
    });

    await startDev({
      ...h.options,
      apps: ["email"],
      autostartOverrides: Object.fromEntries(workers.map((w) => [w.name, false])),
    });

    expect(seen[0]?.baseUrl).toBe("http://localhost:8787");
  });

  test("a host started alone still builds its links against the app's pinned address", async () => {
    // Nothing non-host is running, and the old fallback was `started[0]` — which in this run is the
    // host itself, a Worker holding no public route. A callback link belongs at the app's address.
    const seen: MaterializeHostConfigsOptions[] = [];
    const h = hosted({
      materializeHostConfigs: async (o) => {
        seen.push(o);
        return { notes: [], failed: [] };
      },
    });

    await startDev({ ...h.options, apps: ["email"] });

    expect(seen[0]?.baseUrl).toBe("http://localhost:8787");
  });
});

describe("startDev — capability hosts", () => {
  /**
   * `apps/` is the app-Worker registry, and nine capabilities ship a prebuilt host Worker that lives
   * nowhere near it. None of them had ever run under `pithy dev`, which is why every email enqueued
   * locally sat `pending` forever while the sign-in screen said "Check your inbox"
   * (pithy-sh/pithy#410). A host is an ordinary member of the dev set, and these pin that it is one.
   */

  /** The dev config a project with an email host gets: the two apps plus the host, all pinned. */
  const withHost: DevConfig = {
    ...config,
    workers: { ...config.workers, email: { port: 8789, origin: "http://localhost:8789" } },
  };

  /** The host as discovery hands it over: a plain `WorkerTarget` with a generated config directory. */
  const emailHost = {
    capability: "email",
    sourceDir: "/proj/apps/api",
    spec: { capability: "email", entry: "@pithy-sh/email/src/workflows/worker", package: "@pithy-sh/email" },
    worker: {
      name: "email",
      dir: "/proj/.wrangler/pithy/hosts/email",
      hasWrangler: true,
      dev: { readySignal: "Ready on https?://" },
    },
  };

  /** A harness whose project composes email, so the dev set is `api`, `web` and the email host. */
  function hosted(overrides: Partial<StartDevOptions> = {}) {
    return harness({
      loadDevConfig: async () => withHost,
      discoverHostWorkers: async () => ({ hosts: [emailHost as never], notes: [] }),
      ...overrides,
    });
  }

  test("starts the host of every capability the project's Workers compose", async () => {
    const h = hosted();
    const handle = await startDev(h.options);
    expect(handle.workers.map((w) => w.name)).toEqual(["api", "web", "email"]);
    expect(h.spawned.map((s) => s.opts.cwd)).toContain("/proj/.wrangler/pithy/hosts/email");
  });

  test("the host is an ordinary member: a pinned port, a state entry, and the same teardown", async () => {
    const h = hosted();
    const handle = await startDev(h.options);
    expect(handle.workers).toContainEqual({ name: "email", port: 8789, origin: "http://localhost:8789" });
    expect(h.written[0]?.workers.email?.port).toBe(8789);
    // Every child, host included, is signaled on shutdown — no orphaned workerd after a session.
    await handle.shutdown("done");
    const hostPid = h.spawned[2]?.child.pid ?? 0;
    expect(h.killCalls.map((k) => k.pid)).toContain(-hostPid);
  });

  test("its port is verified on both loopback families before anything spawns, like every other", async () => {
    const h = hosted();
    const bind = vi.fn().mockResolvedValue(true);
    await startDev({ ...h.options, tryBind: bind });
    expect(bind).toHaveBeenCalledWith(8789, "127.0.0.1");
    expect(bind).toHaveBeenCalledWith(8789, "::1");
  });

  test("adding a capability reconciles the port block exactly as adding a Worker does", async () => {
    // The bootstrap seam is called with every member — apps *and* hosts — so a host that is not yet
    // pinned gets a port from the feature's own block rather than the `no port in .dev.config.json`
    // refusal.
    const h = hosted({ loadDevConfig: async () => config });
    const seen: EnsureDevConfigOptions[] = [];
    await startDev({
      ...h.options,
      ensureDevConfig: async (o) => {
        seen.push(o);
        return withHost;
      },
    });
    expect(seen[0]?.workers.map((w) => w.name)).toEqual(["api", "web", "email"]);
  });

  test("every app Worker is told the host's address, because the host env never crosses into workerd", async () => {
    // `<STEM>_ORIGIN` is in the child process env already; a Worker's own `process.env` is its vars and
    // nothing else. This `--var` is what lets core's loopback dispatcher find the host at all.
    const h = hosted();
    await startDev(h.options);
    const api = h.spawned.find((s) => s.opts.cwd === "/proj/apps/api");
    expect(api?.args).toContain("EMAIL_ORIGIN:http://localhost:8789");
    // And it is in the process env too, for every member of the set.
    expect(api?.opts.env.EMAIL_ORIGIN).toBe("http://localhost:8789");
  });

  test("the host is never handed its own address", async () => {
    const h = hosted();
    await startDev(h.options);
    const host = h.spawned.find((s) => s.opts.cwd === "/proj/.wrangler/pithy/hosts/email");
    expect(host?.args).not.toContain("EMAIL_ORIGIN:http://localhost:8789");
  });

  test("its config is resolved against the app's own local origin, not the host's", async () => {
    const h = hosted();
    const calls: { project: string; baseUrl: string; simulateDelivery?: boolean }[] = [];
    await startDev({
      ...h.options,
      materializeHostConfigs: async (o) => {
        calls.push({ project: o.project, baseUrl: o.baseUrl, simulateDelivery: o.simulateDelivery });
        return { notes: [], failed: [] };
      },
    });
    // `simulateDelivery` is `true` here because this fixture host declares no `delivery` at all: a
    // set with nothing that sends has nothing to send for real, and the flag is inert for every
    // capability but the one holding a send binding.
    expect(calls[0]).toEqual({ project: "acme", baseUrl: "http://localhost:8787", simulateDelivery: true });
  });

  /** The host as discovery hands it over when the capability does put messages on the wire. */
  const sender = (requested: "remote" | "simulator", fromAddress: string) => ({
    ...emailHost,
    spec: { ...emailHost.spec, delivery: async () => ({ requested, fromAddress }) },
  });

  test("a login and a real sending address mean the session sends for real, and the banner says so", async () => {
    const h = hosted({
      discoverHostWorkers: async () => ({ hosts: [sender("remote", "hi@acme.dev") as never], notes: [] }),
    });
    const calls: boolean[] = [];
    const handle = await startDev({
      ...h.options,
      materializeHostConfigs: async (o) => {
        calls.push(o.simulateDelivery === true);
        return { notes: [], failed: [] };
      },
    });
    for (const s of h.spawned) s.child.stdout.write("Ready on http://localhost — ready in 12ms\n");
    await flush();
    await handle.ready;
    expect(calls).toEqual([false]);
    expect(h.stdoutLines.join("\n")).toContain("sending for real from hi@acme.dev");
  });

  /**
   * The preflight *decides*. A session with no Cloudflare login cannot deliver, so the host is
   * resolved for its simulator rather than for a binding that would fail at startup — said before
   * anybody is waiting on an inbox, and said again in the banner, which is where people look.
   */
  test("no Cloudflare login falls back to the simulator rather than to a binding that would fail", async () => {
    const h = hosted({
      discoverHostWorkers: async () => ({ hosts: [sender("remote", "hi@acme.dev") as never], notes: [] }),
      devCloudflareEnv: (_account, base) => ({
        env: { ...(base as Record<string, string>) },
        identity: { accountId: null, hasToken: false, mismatch: null },
        overridden: [],
      }),
    });
    const calls: boolean[] = [];
    const handle = await startDev({
      ...h.options,
      materializeHostConfigs: async (o) => {
        calls.push(o.simulateDelivery === true);
        return { notes: [], failed: [] };
      },
    });
    for (const s of h.spawned) s.child.stdout.write("Ready on http://localhost — ready in 12ms\n");
    await flush();
    await handle.ready;
    expect(calls).toEqual([true]);
    expect(h.stdoutLines.join("\n")).toContain("using the simulator");
    expect(h.stdoutLines.join("\n")).toContain("pithy init");
  });

  test("its output is labeled and tee'd like every other worker's", async () => {
    const h = hosted();
    await startDev(h.options);
    h.spawned[2]?.child.stdout.write("workflow started\n");
    await flush();
    expect(h.logLines.some((l) => l.startsWith("[email] workflow started"))).toBe(true);
  });

  test("a delivery failure in the host's output is rendered, and the session survives it", async () => {
    const h = hosted();
    const handle = await startDev(h.options);
    h.spawned[2]?.child.stdout.write("✘ [ERROR] could not establish remote binding for send_email\n");
    await flush();
    expect(h.stdoutLines.join("\n")).toContain("nothing will be delivered");
    expect(h.removed).toEqual([]);
    await handle.shutdown("done");
  });

  /**
   * The preflight is not the guarantee. A remote send binding is established when the Worker starts,
   * so a domain nobody onboarded most often fails there — after every decision this command made.
   * Reporting it and stopping leaves the one state the issue forbids: every magic link from here on
   * failing, quietly. So the host is re-resolved for its simulator, which sends nothing and logs the
   * recipient, subject and URL. `wrangler dev` watches its own config file, so the rewrite is the
   * reload.
   */
  test("a delivery failure at runtime falls the host back to the simulator", async () => {
    const h = hosted({
      discoverHostWorkers: async () => ({ hosts: [sender("remote", "hi@acme.dev") as never], notes: [] }),
    });
    const calls: { simulate: boolean; hosts: string[] }[] = [];
    const handle = await startDev({
      ...h.options,
      materializeHostConfigs: async (o) => {
        calls.push({ simulate: o.simulateDelivery === true, hosts: o.hosts.map((host) => host.worker.name) });
        return { notes: [], failed: [] };
      },
    });
    h.spawned[2]?.child.stdout.write("✘ [ERROR] could not establish remote binding for send_email\n");
    await flush();
    expect(calls).toEqual([
      { simulate: false, hosts: ["email"] },
      { simulate: true, hosts: ["email"] },
    ]);
    expect(h.stdoutLines.join("\n")).toContain("email: using the simulator from here");
    // Once, however many lines the failing binding prints — a rewrite per line would reload the
    // Worker on every one of them.
    h.spawned[2]?.child.stdout.write("✘ [ERROR] could not establish remote binding for send_email\n");
    await flush();
    expect(calls).toHaveLength(2);
    await handle.shutdown("done");
  });

  test("the delivery verdict is said once, in the banner", async () => {
    const h = hosted({
      discoverHostWorkers: async () => ({ hosts: [sender("remote", "hi@acme.dev") as never], notes: [] }),
      devCloudflareEnv: (_account, base) => ({
        env: { ...(base as Record<string, string>) },
        identity: { accountId: null, hasToken: false, mismatch: null },
        overridden: [],
      }),
    });
    const handle = await startDev(h.options);
    // Nothing before the banner: the pre-spawn copy and the banner copy were one sentence twice.
    expect(h.stdoutLines.filter((line) => line.includes("using the simulator"))).toEqual([]);
    for (const s of h.spawned) s.child.stdout.write("Ready on http://localhost — ready in 12ms\n");
    await flush();
    await handle.ready;
    expect(h.stdoutLines.filter((line) => line.includes("using the simulator"))).toHaveLength(1);
    // And the action line comes with it, because a problem without its remedy is half a report.
    expect(h.stdoutLines.join("\n")).toContain("pithy init");
  });

  test("a host whose config could not be resolved is not spawned, and the session still runs", async () => {
    // The note says "it will not run", and until now that sentence was false: the host stayed in the
    // started set and `wrangler dev` was spawned in a directory materialization never created. Node
    // answered ENOENT on the spawn, the `error` handler tore the whole session down, and the two app
    // Workers that were fine went with it.
    const h = hosted({
      materializeHostConfigs: async () => ({
        notes: ["email: its host worker could not be resolved, so it will not run."],
        failed: ["email"],
      }),
    });
    const handle = await startDev(h.options);
    expect(handle.workers.map((w) => w.name)).toEqual(["api", "web"]);
    expect(h.spawned.map((s) => s.opts.cwd)).not.toContain("/proj/.wrangler/pithy/hosts/email");
    // And no app Worker is told an address nothing is listening on.
    const api = h.spawned.find((s) => s.opts.cwd === "/proj/apps/api");
    expect(api?.args).not.toContain("EMAIL_ORIGIN:http://localhost:8789");
    // The banner still fires for the Workers that did start.
    for (const s of h.spawned) s.child.stdout.write("Ready on http://localhost — ready in 12ms\n");
    await flush();
    await handle.ready;
  });

  test("a project stating no name runs no host, and says why", async () => {
    const h = hosted({ projectName: async () => null });
    await startDev(h.options);
    expect(h.spawned.map((s) => s.opts.cwd)).not.toContain("/proj/.wrangler/pithy/hosts/email");
    expect(h.stdoutLines.join("\n")).toContain("No project name in pithy.config.ts");
  });
});

/**
 * **The reclaim and `pithy feature prune` answer one question, with one predicate** (#637). The reclaim
 * rebuilds a lost registry from the blocks worktrees still pin, and prune frees the blocks nothing holds.
 * If the two disagree, a block prune frees is put back by the next config-less `pithy dev`, and prune frees
 * it again — or a block prune keeps is left off a rebuilt registry and handed to somebody else.
 */
describe("ensureDevConfig — the reclaim agrees with prune", () => {
  let dir: string;
  let root: string;
  let registryPath: string;
  const git = (args: string[], cwd = root): string =>
    execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  const block = (index: number) => ({ block: index, base: BASE_PORT + index * BLOCK_SIZE, size: BLOCK_SIZE });
  /** Every seam but the registry's location is the real one: a real repository answers the rest. */
  const ensure = (projectDir: string) =>
    ensureDevConfig({ projectDir, workers: [], existing: null, registryPathFor: async () => registryPath });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A repository with a feature torn down the gitlink-drop way: its directory and pinned config stay. */
  async function tornDown(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "pithy-reclaim-"));
    registryPath = join(dir, "config", "dev-ports.json");
    await mkdir(join(dir, "config"));
    await mkdir(join(dir, "repo"));
    root = await realpath(join(dir, "repo"));
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "T"]);
    git(["commit", "-q", "--allow-empty", "-m", "init"]);
    git(["branch", "-M", "main"]);
    const wt = join(root, ".worktrees", "2-gone");
    git(["worktree", "add", "-q", "-b", "feature/2-gone", wt]);
    await writeDevConfig(
      devConfigPath(wt),
      buildDevConfig({ branch: "feature/2-gone", block: block(1), workers: [], previous: null }),
    );
    await unlink(join(wt, ".git"));
    git(["worktree", "prune"]);
    git(["branch", "-D", "feature/2-gone"]);
    return wt;
  }

  test("a block prune frees is never put back by the next config-less pithy dev", async () => {
    await tornDown();
    await writeFile(registryPath, JSON.stringify({ [root]: { main: block(0), "feature/2-gone": block(1) } }));

    await pruneFeatureBlocks({ cwd: root, registryPath, dryRun: false });
    const scratch = join(dir, "scratch-wt");
    git(["worktree", "add", "-q", "--detach", scratch]);
    await ensure(scratch);

    // A fixed point: whatever the reclaim registered, prune does not want to free.
    expect((await pruneFeatureBlocks({ cwd: root, registryPath, dryRun: true })).freedBlocks).toEqual([]);
  });

  test("a lost registry is rebuilt with every block prune would keep", async () => {
    await tornDown();
    // The registry is gone: a wiped config directory, a new machine. The directory still pins its block.
    const scratch = join(dir, "scratch-wt");
    git(["worktree", "add", "-q", "--detach", scratch]);

    const dev = await ensure(scratch);

    const registry = JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry;
    expect(registry[root]?.["feature/2-gone"]).toEqual(block(1));
    expect(dev.ports.index).not.toBe(1);
    expect((await pruneFeatureBlocks({ cwd: root, registryPath, dryRun: true })).freedBlocks).toEqual([]);
  });
});

/**
 * **The session's events, and the invariant that they are additive.**
 *
 * The footer (`dev/tui/`) is a second consumer of facts this supervisor already held and already said as
 * prose. The last test in this block is the one that matters most: a run with a sink installed must write
 * exactly the same lines as a run without one. If that ever fails, the feed has started replacing output
 * rather than accompanying it, and the plain path — which is what `--json`, a pipe and CI read — has
 * silently changed.
 */
describe("startDev — session events", () => {
  const collector = () => {
    const events: DevEvent[] = [];
    return { events, events_: (event: DevEvent) => events.push(event) };
  };
  const only = <K extends DevEvent["event"]>(events: readonly DevEvent[], kind: K) =>
    events.filter((e): e is Extract<DevEvent, { event: K }> => e.event === kind);

  test("every worker's spawn is raised with its kind and its pinned port", async () => {
    const h = harness();
    const c = collector();
    await startDev({ ...h.options, events: c.events_ });

    expect(only(c.events, "spawned").map((e) => [e.worker, e.kind, e.port])).toEqual([
      ["api", "app", 8787],
      ["web", "app", 8788],
    ]);
  });

  test("a capability host is raised as a host, because the roster distinguishes them", async () => {
    // `hosted()` is local to another block, so the one host this case needs is built here rather than
    // by widening that helper's scope for a single caller.
    const h = harness({
      loadDevConfig: async () => ({
        ...config,
        workers: { ...config.workers, email: { port: 8789, origin: "http://localhost:8789" } },
      }),
      discoverHostWorkers: async () => ({
        hosts: [
          {
            capability: "email",
            sourceDir: "/proj/apps/api",
            spec: { capability: "email", entry: "@pithy-sh/email/src/workflows/worker", package: "@pithy-sh/email" },
            worker: {
              name: "email",
              dir: "/proj/.wrangler/pithy/hosts/email",
              hasWrangler: true,
              dev: { readySignal: "Ready on https?://" },
            },
          } as never,
        ],
        notes: [],
      }),
    });
    const c = collector();
    await startDev({ ...h.options, apps: ["email"], events: c.events_ });

    expect(only(c.events, "spawned").map((e) => [e.worker, e.kind])).toEqual([["email", "host"]]);
  });

  test("a ready line raises ready for that worker and for no other", async () => {
    const h = harness();
    const c = collector();
    await startDev({ ...h.options, events: c.events_ });

    h.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    await flush();

    expect(only(c.events, "ready").map((e) => e.worker)).toEqual(["api"]);
  });

  test("a worker that becomes ready twice is raised once — the row is already settled", async () => {
    const h = harness();
    const c = collector();
    await startDev({ ...h.options, events: c.events_ });

    h.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    await flush();
    h.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    await flush();

    expect(only(c.events, "ready")).toHaveLength(1);
  });

  test("the ready deadline raises waiting with the same names it prints", async () => {
    const h = harness();
    const c = collector();
    await startDev({ ...h.options, events: c.events_ });

    h.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    await flush();
    h.advance(90_000);
    await flush();

    expect(only(c.events, "waiting").map((e) => [...e.workers])).toEqual([["web"]]);
    // The prose is still written. The event does not take its place (#670).
    expect(h.stdoutLines).toContain("Still waiting on: web.");
  });

  test("session-ready is raised once, when the last started worker arrives", async () => {
    const h = harness();
    const c = collector();
    await startDev({ ...h.options, events: c.events_ });

    h.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    await flush();
    expect(only(c.events, "session-ready")).toHaveLength(0);

    h.spawned[1]?.child.stdout.write("ready in 412\n");
    await flush();
    expect(only(c.events, "session-ready")).toHaveLength(1);
  });

  test("a child's exit is raised with its code, and so is the teardown it causes", async () => {
    const h = harness();
    const c = collector();
    await startDev({ ...h.options, events: c.events_ });

    h.spawned[0]?.child.emit("exit", 1);
    await flush();

    // One child exiting tears the whole session down, so its siblings exit too — and the roster is
    // entitled to show that. The worker that *caused* it is the first one raised, which is the fact a
    // reader needs; swallowing the cascade would leave every sibling rendered as healthy while the
    // session shuts down around them.
    const exits = only(c.events, "exited").map((e) => [e.worker, e.code]);
    expect(exits[0]).toEqual(["api", 1]);
    expect(exits).toContainEqual(["web", 0]);
  });

  test("installing a sink changes not one line of the session's output", async () => {
    // The invariant the whole design rests on: the footer adds a region, it never rewrites a line.
    const plain = harness();
    await startDev(plain.options);
    plain.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    plain.spawned[1]?.child.stdout.write("ready in 412\n");
    await flush();
    plain.advance(90_000);
    await flush();

    const observed = harness();
    const c = collector();
    await startDev({ ...observed.options, events: c.events_ });
    observed.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    observed.spawned[1]?.child.stdout.write("ready in 412\n");
    await flush();
    observed.advance(90_000);
    await flush();

    expect(observed.stdoutLines).toEqual(plain.stdoutLines);
    expect(observed.stderrLines).toEqual(plain.stderrLines);
    expect(observed.logLines).toEqual(plain.logLines);
    expect(c.events.length).toBeGreaterThan(0);
  });
});

/**
 * **`restart(worker)` — the one new thing this supervisor can do.**
 *
 * `docs/commands/dev.md` already names the failure whose only remedy is a restart: "a `wrangler dev`
 * whose *first* build fails never rebuilds — fixing the file and waiting is the one thing that cannot
 * work." Until now the only way to act on that was Ctrl-C and restart the estate.
 *
 * It lives on the handle rather than inside the renderer so it is testable with no terminal involved,
 * which is what these cases are.
 */
describe("startDev — restart", () => {
  test("respawns the named worker, in its own directory, on its own pinned port", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    expect(h.spawned).toHaveLength(2);

    await handle.restart("api");

    expect(h.spawned).toHaveLength(3);
    expect(h.spawned[2]?.opts.cwd).toBe("/proj/apps/api");
    // The same port it was pinned to: a worker that moved would break every sibling told its address.
    expect(h.spawned[2]?.args.join(" ")).toContain("8787");
  });

  test("signals the old child's whole process group, not just its pid", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    const oldPid = h.spawned[0]?.child.pid ?? 0;

    await handle.restart("api");

    // Negated, because `wrangler` spawns `workerd` beneath it and only the group reaches both.
    expect(h.killCalls).toContainEqual({ pid: -oldPid, signal: "SIGTERM" });
  });

  test("the session survives it — a restart is not a worker dying", async () => {
    const h = harness();
    const handle = await startDev(h.options);

    await handle.restart("api");

    // The exit handler tears the whole session down when a child goes. A restart must not read as one.
    expect(h.stdoutLines.some((l) => l.startsWith("Stopping"))).toBe(false);
    expect(h.removed).toEqual([]);
  });

  test("the replacement's output is heard, so it can become ready", async () => {
    const h = harness();
    const c = (() => {
      const events: DevEvent[] = [];
      return { events, sink: (e: DevEvent) => events.push(e) };
    })();
    const handle = await startDev({ ...h.options, events: c.sink });
    h.spawned[1]?.child.stdout.write("ready in 412\n");
    await flush();

    await handle.restart("api");
    h.spawned[2]?.child.stdout.write("Ready on http://localhost:8787\n");
    await flush();

    expect(h.stdoutLines.some((l) => l.includes("[api] Ready on"))).toBe(true);
    expect(c.events.filter((e) => e.event === "ready").map((e) => (e as { worker: string }).worker)).toContain("api");
  });

  test("it raises the exit and the new spawn, in that order", async () => {
    const h = harness();
    const events: DevEvent[] = [];
    const handle = await startDev({ ...h.options, events: (e) => events.push(e) });

    await handle.restart("api");

    const apiEvents = events.filter((e) => "worker" in e && e.worker === "api").map((e) => e.event);
    expect(apiEvents).toEqual(["spawned", "exited", "spawned"]);
  });

  test("the new child's pid replaces the old one in the session state", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    const oldPid = h.spawned[0]?.child.pid ?? 0;

    await handle.restart("api");

    const latest = h.written.at(-1);
    const newPid = h.spawned[2]?.child.pid ?? 0;
    expect(latest?.childPids).toContain(newPid);
    expect(latest?.childPids).not.toContain(oldPid);
    // A re-run reaps what the state file names. A stale pid is harmless; a missing one leaks a workerd.
    expect(latest?.workers.api?.pid).toBe(newPid);
  });

  test("shutdown reaches the replacement rather than the child it replaced", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    await handle.restart("api");
    const newPid = h.spawned[2]?.child.pid ?? 0;

    await handle.shutdown("interrupted");

    expect(h.killCalls).toContainEqual({ pid: -newPid, signal: "SIGTERM" });
  });

  test("a name this session did not start is refused, naming the ones it did", async () => {
    const h = harness();
    const handle = await startDev(h.options);

    await expect(handle.restart("nope")).rejects.toMatchObject({
      payload: { code: "validation/invalid_input" },
    });
    expect(h.spawned).toHaveLength(2);
  });

  test("a restart during shutdown does nothing", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    await handle.shutdown("interrupted");

    await handle.restart("api");

    // Two spawns, from startup. Respawning into a teardown would leave a child nothing is waiting on.
    expect(h.spawned).toHaveLength(2);
  });
});

/**
 * **The two key actions, reachable from the handle.**
 *
 * The live roster owns the keyboard while it renders (#670), so `l` and its digits cannot stay bound
 * only inside `terminal/keys.ts`. These are the same actions the keypress cases above drive through a
 * reader; what is asserted here is that the handle reaches them.
 */
describe("startDev — dev login from the handle", () => {
  test("devLogin opens the signed-in URL without a keypress", async () => {
    const opened: string[] = [];
    const h = harness({ readDevLogins: seededLogins(1), openUrl: async (url) => void opened.push(url) });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.devLogin();

    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("/__pithy/dev-login");
  });

  test("pickIdentity answers the list a digit was asked for", async () => {
    const opened: string[] = [];
    const h = harness({ readDevLogins: seededLogins(3), openUrl: async (url) => void opened.push(url) });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.devLogin();
    expect(h.stdoutLines).toContain("Which identity? Press 1–3.");
    await handle.pickIdentity("2");

    expect(opened).toEqual([`http://localhost:8787/__pithy/dev-login?t=${CLAIM}-2`]);
  });

  test("a digit with no list open opens nothing — so a renderer may forward every digit", async () => {
    const opened: string[] = [];
    const h = harness({ readDevLogins: seededLogins(3), openUrl: async (url) => void opened.push(url) });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.pickIdentity("2");

    expect(opened).toEqual([]);
  });
});

/**
 * **`l` reads the artifact when it is pressed, not when the session started.**
 *
 * The startup read is for the *banner* — "so the banner never waits on the disk once the workers are up"
 * — and that reasoning does not reach a keypress. While it did, `pithy seed` run against a session
 * already up could never be seen by it, and the refusal said `Run pithy seed, then press l again`: the
 * one remedy that could not work. Reported from a real dashboard session, where `l` was pressed twice.
 */
describe("startDev — l reads the seed as it is pressed", () => {
  test("a seed that lands after the session started is picked up by the next l", async () => {
    const opened: string[] = [];
    let seeded = false;
    const withOne = seededLogins(1);
    const h = harness({
      // Nothing seeded when the session starts; `pithy seed` runs in another terminal; then `l`.
      readDevLogins: async () => (seeded ? withOne() : undefined),
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.devLogin();
    expect(opened).toEqual([]);
    expect(h.stdoutLines.some((l) => l.includes("No dev login is seeded"))).toBe(true);

    seeded = true;
    await handle.devLogin();

    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("/__pithy/dev-login");
  });

  test("a seed that lands mid-session is offered as a list, not just as one identity", async () => {
    // The whole of #667 has to survive the re-read: three identities seeded after startup still get
    // numbered, and a digit still opens one.
    const opened: string[] = [];
    let seeded = false;
    const withThree = seededLogins(3);
    const h = harness({
      readDevLogins: async () => (seeded ? withThree() : undefined),
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    seeded = true;
    await handle.devLogin();
    expect(h.stdoutLines).toContain("Which identity? Press 1–3.");

    await handle.pickIdentity("2");
    expect(opened).toEqual([`http://localhost:8787/__pithy/dev-login?t=${CLAIM}-2`]);
  });

  test("an identity that expires during a long session stops being offered", async () => {
    // The mirror of the case above, and the reason re-reading is right rather than merely convenient:
    // the record on disk is the truth, and a session holding yesterday's copy is wrong in both
    // directions.
    const opened: string[] = [];
    const h = harness({
      readDevLogins: async () => ({
        "example-1": {
          email: "user1@example.com",
          userId: "example-1",
          claim: `${CLAIM}-1`,
          expiresAt: new Date("2026-07-26T00:00:00.000Z"),
        },
      }),
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.devLogin();

    expect(opened).toEqual([]);
    expect(h.stdoutLines.some((l) => l.includes("expired"))).toBe(true);
  });
});

/**
 * **Signing in on a named worker — because an app stack can carry more than one front end.**
 *
 * Without a name, `devLoginKeyAction` resolves which worker to open with a heuristic: the one carrying a
 * UI wins, and a tie prints the choices rather than guessing. That is the right answer for the plain
 * path, which has no selection to read. The live roster does, and a marker on a row is a better answer
 * than any heuristic — so the name takes precedence when one is given.
 */
describe("startDev — signing in on a named worker", () => {
  /** Both app workers compose auth, which is what a stack with two front ends looks like. */
  const twoTargets = () =>
    harness({
      readDevLogins: seededLogins(1),
      devLoginTargets: async (started) => started.map(({ name, origin }) => ({ name, origin })),
    });

  test("the named worker is the one opened, not the one a heuristic would pick", async () => {
    const opened: string[] = [];
    const h = twoTargets();
    const handle = await startDev({ ...h.options, openUrl: async (url) => void opened.push(url) });
    await signalReady(h);
    await handle.ready;

    await handle.devLogin("web");

    expect(opened).toEqual([`http://localhost:8788/__pithy/dev-login?t=${CLAIM}-1`]);
  });

  test("each front end can be signed into in turn", async () => {
    const opened: string[] = [];
    const h = twoTargets();
    const handle = await startDev({ ...h.options, openUrl: async (url) => void opened.push(url) });
    await signalReady(h);
    await handle.ready;

    await handle.devLogin("api");
    await handle.devLogin("web");

    expect(opened.map((url) => new URL(url).port)).toEqual(["8787", "8788"]);
  });

  test("a worker that carries no dev-login route is refused by name, and opens nothing", async () => {
    // A capability host has no auth routes. Falling back to whichever worker does would sign you into
    // something other than the row you were on, which is worse than a sentence.
    const opened: string[] = [];
    const h = twoTargets();
    const handle = await startDev({ ...h.options, openUrl: async (url) => void opened.push(url) });
    await signalReady(h);
    await handle.ready;

    await handle.devLogin("email");

    expect(opened).toEqual([]);
    expect(h.stdoutLines.some((l) => l.includes("email"))).toBe(true);
  });

  test("with no name the heuristic still decides, so the plain path is unchanged", async () => {
    // Two workers compose auth and neither carries a UI to break the tie, so `pithy dev` prints the
    // choices rather than guessing — exactly what it did before a name could be passed. This is the
    // case the roster improves on: with a marker there is nothing to guess.
    const opened: string[] = [];
    const h = twoTargets();
    const handle = await startDev({ ...h.options, openUrl: async (url) => void opened.push(url) });
    await signalReady(h);
    await handle.ready;

    await handle.devLogin();

    expect(opened).toEqual([]);
    expect(h.stdoutLines.some((l) => l.includes("api") && l.includes("web"))).toBe(true);
  });
});

/**
 * **The whole dev set reaches the roster, and `r` can start what this branch parked.**
 *
 * Reported from a real session: three capability hosts were parked in `dev-ports.json` and the footer had
 * no row for any of them, so there was nothing to press `r` on — while `pithy dev --list` had always
 * listed them. The set is the project; what started is a fact about this run.
 */
describe("startDev — the parked half of the dev set", () => {
  test("every member is raised before anything spawns, marked by whether it starts", async () => {
    const h = harness();
    const events: DevEvent[] = [];
    await startDev({ ...h.options, autostartOverrides: { web: false }, events: (e) => events.push(e) });

    const roster = events.find((e) => e.event === "roster");
    expect(roster).toMatchObject({
      members: [
        { worker: "api", kind: "app", port: 8787, starts: true },
        { worker: "web", kind: "app", port: 8788, starts: false },
      ],
    });
    // Before, so the roster never renders a set it is about to be told about twice.
    expect(events.indexOf(roster as DevEvent)).toBeLessThan(events.findIndex((e) => e.event === "spawned"));
  });

  test("a parked worker is not spawned, which is the whole point of parking it", async () => {
    const h = harness();
    await startDev({ ...h.options, autostartOverrides: { web: false } });
    expect(h.spawned.map((s) => s.opts.cwd)).toEqual(["/proj/apps/api"]);
  });

  test("restart starts a worker this branch parked", async () => {
    const h = harness();
    const handle = await startDev({ ...h.options, autostartOverrides: { web: false } });
    expect(h.spawned).toHaveLength(1);

    await handle.restart("web");

    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[1]?.opts.cwd).toBe("/proj/apps/web");
    // Its own pinned port, the one a full run would have given it. `web` is a `dev.command` worker whose
    // fixture argv carries no `{port}` token, so the address reaches it through the environment — which
    // is the other of the two carriers `startCommand` writes.
    expect(Object.values(h.spawned[1]?.opts.env ?? {}).join(" ")).toContain("8788");
  });

  test("starting a parked worker kills nothing, because nothing was running", async () => {
    const h = harness();
    const handle = await startDev({ ...h.options, autostartOverrides: { web: false } });

    await handle.restart("web");

    expect(h.killCalls).toEqual([]);
  });

  test("a started-from-parked worker is supervised like any other", async () => {
    const h = harness();
    const events: DevEvent[] = [];
    const handle = await startDev({
      ...h.options,
      autostartOverrides: { web: false },
      events: (e) => events.push(e),
    });
    await handle.restart("web");

    h.spawned[1]?.child.stdout.write("ready in 412\n");
    await flush();

    expect(events.filter((e) => e.event === "ready").map((e) => (e as { worker: string }).worker)).toContain("web");
    expect(h.stdoutLines.some((l) => l.includes("[web] ready in 412"))).toBe(true);
    // And its pid *and port* are recorded, so a re-run reaps it. The port is the assertion that was
    // missing: it was being written as 0, which the real writer refuses.
    expect(h.written.at(-1)?.workers.web).toEqual({ port: 8788, pid: h.spawned[1]?.child.pid });
  });

  test("a name in no part of the set is still refused", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    await expect(handle.restart("nope")).rejects.toMatchObject({ payload: { code: "validation/invalid_input" } });
  });
});

/**
 * **The one thing the roster is allowed to take out of the stream.**
 *
 * `docs/CLI.md` §3.7 claimed the footer "adds a region; it never rewrites a line", and that was true
 * until the roster started carrying every worker's port, state and a key to open it — at which point the
 * banner's `name: http://localhost:####` list was the same facts printed twice, directly above a table
 * that holds them. So the exception is narrow, declared, and keyed on `roster` rather than on the event
 * sink: a consumer that installs events without rendering a roster still gets every line.
 *
 * **`logs/dev.log` stays byte-identical in both.** That is the half worth protecting — it is the record
 * a session is read back from, and it already writes each address independently of the banner.
 */
describe("startDev — what a roster supersedes", () => {
  const ready = async (h: ReturnType<typeof harness>) => {
    h.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    h.spawned[1]?.child.stdout.write("ready in 412\n");
    await flush();
  };

  test("without a roster the banner names every worker's address, as it always did", async () => {
    const h = harness();
    await startDev(h.options);
    await ready(h);
    expect(h.stdoutLines).toContain("api: http://localhost:8787");
    expect(h.stdoutLines).toContain("web: http://localhost:8788");
  });

  test("with a roster those lines are left to the roster", async () => {
    const h = harness();
    await startDev({ ...h.options, roster: true });
    await ready(h);
    expect(h.stdoutLines.some((l) => l.startsWith("api: http://"))).toBe(false);
    expect(h.stdoutLines.some((l) => l.startsWith("web: http://"))).toBe(false);
  });

  test("`Ready.` is the roster's to say now, and it says it by every row reading ready", async () => {
    // It used to be kept here as the moment marker. With a table of five rows all saying `ready` and the
    // footer stopped ticking, the word was the same fact twice — which is what was reported.
    const h = harness();
    await startDev({ ...h.options, roster: true });
    await ready(h);
    expect(h.stdoutLines).not.toContain("Ready.");
  });

  test("logs/dev.log is byte-identical with the roster and without it", async () => {
    const plain = harness();
    await startDev(plain.options);
    await ready(plain);

    const rostered = harness();
    await startDev({ ...rostered.options, roster: true });
    await ready(rostered);

    expect(rostered.logLines).toEqual(plain.logLines);
    // Named explicitly: the record carries each address whether the banner printed it or not.
    expect(rostered.logLines).toContain("ready: api http://localhost:8787");
  });

  test("the superseded lines are the *only* difference the roster makes to the stream", async () => {
    // The whole exception, enumerated. Anything else a plain run writes, a roster run writes too, byte
    // for byte, in the same order — and `docs/CLI.md` §3.7 names this set rather than hand-waving at it.
    const plain = harness();
    await startDev(plain.options);
    await ready(plain);

    const rostered = harness();
    await startDev({ ...rostered.options, roster: true });
    await ready(rostered);

    const superseded = (line: string) =>
      /^(api|web): http:\/\//.test(line) ||
      line.startsWith("Starting ") ||
      line === "Ready." ||
      line.startsWith("Dev login:");
    expect(rostered.stdoutLines).toEqual(plain.stdoutLines.filter((line) => !superseded(line)));
  });
});

/**
 * **A worker that becomes ready *after* the banner is still a worker that became ready.**
 *
 * The ready detector opened with `if (bannerShown || readyState.get(name)) return;`. The first clause was
 * free before anything could restart: once every worker had arrived, no further ready signal mattered.
 * With `r` it is a bug — a restarted worker printed `Ready on http://localhost:8791`, the line was
 * dropped on the floor, and its row sat on `building` for the rest of the session. Reported from a real
 * session on a worker that had been started from a parked row and then restarted.
 *
 * The two concerns are now separate: **readiness is per worker and tracked always**, while **the banner
 * fires once** — which is what `bannerShown` was actually for.
 */
describe("startDev — readiness after the banner", () => {
  const allReady = async (h: ReturnType<typeof harness>) => {
    h.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    h.spawned[1]?.child.stdout.write("ready in 412\n");
    await flush();
  };

  test("a restarted worker's ready signal is heard and raised", async () => {
    const h = harness();
    const events: DevEvent[] = [];
    const handle = await startDev({ ...h.options, events: (e) => events.push(e) });
    await allReady(h);
    await handle.ready;

    await handle.restart("api");
    const before = events.filter((e) => e.event === "ready").length;
    h.spawned[2]?.child.stdout.write("Ready on http://localhost:8787\n");
    await flush();

    expect(events.filter((e) => e.event === "ready")).toHaveLength(before + 1);
    expect(events.filter((e) => e.event === "ready").at(-1)).toMatchObject({ worker: "api" });
  });

  test("the banner still fires exactly once", async () => {
    // What `bannerShown` was for. A second `Ready.` would say the session had restarted when one worker
    // had.
    const h = harness();
    const handle = await startDev(h.options);
    await allReady(h);
    await handle.ready;

    await handle.restart("api");
    h.spawned[2]?.child.stdout.write("Ready on http://localhost:8787\n");
    await flush();

    expect(h.stdoutLines.filter((line) => line === "Ready.")).toHaveLength(1);
  });

  test("session-ready is raised once, not again on a restart", async () => {
    const h = harness();
    const events: DevEvent[] = [];
    const handle = await startDev({ ...h.options, events: (e) => events.push(e) });
    await allReady(h);
    await handle.ready;

    await handle.restart("api");
    h.spawned[2]?.child.stdout.write("Ready on http://localhost:8787\n");
    await flush();

    expect(events.filter((e) => e.event === "session-ready")).toHaveLength(1);
  });

  test("a worker started from parked after the banner is heard too", async () => {
    // The reported case exactly: parked, started with `r`, then restarted.
    const h = harness();
    const events: DevEvent[] = [];
    const handle = await startDev({
      ...h.options,
      autostartOverrides: { web: false },
      events: (e) => events.push(e),
    });
    h.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    await flush();
    await handle.ready;

    await handle.restart("web");
    h.spawned[1]?.child.stdout.write("ready in 412\n");
    await flush();

    expect(events.filter((e) => e.event === "ready").map((e) => (e as { worker: string }).worker)).toContain("web");
  });
});

/**
 * **A teardown must end. A child that will not die must not take the supervisor with it.**
 *
 * `shutdown` awaited two things without a bound: every child's exit after SIGKILL, and every stream's
 * end. Either one hanging meant `resolveClosed()` never ran, so `handle.closed` never resolved, so
 * `commands/dev.ts` never reached `tui.stop()` or its `process.exit` — and with the live roster holding
 * raw mode and `exitOnCtrlC: false`, Ctrl-C went to a handler that returns early once shutdown has
 * begun. The session printed `Children still alive after grace window — sending SIGKILL.` and then could
 * not be stopped at all. Reported from a real session after pressing `q`.
 *
 * The plain path had an escape by accident: `keys.stop()` hands the terminal back and detaches the
 * reader, so a second Ctrl-C raises a real SIGINT and the default handler ends it. The roster removed
 * that, which is why the bound belongs here rather than only in the renderer.
 */
describe("startDev — a teardown that cannot hang", () => {
  /** A kill that signals nothing: the process-group equivalent of a child ignoring SIGKILL. */
  const immortal = () =>
    harness({
      kill: () => {},
    });

  test("shutdown resolves even when no child ever exits", async () => {
    const h = immortal();
    const handle = await startDev(h.options);

    await expect(handle.shutdown("stopped")).resolves.toBeUndefined();
  });

  test("and `closed` resolves, which is what the command waits on", async () => {
    const h = immortal();
    const handle = await startDev(h.options);

    await handle.shutdown("stopped");

    await expect(handle.closed).resolves.toBeUndefined();
  });

  test("it says what it gave up on, and names them", async () => {
    // An operator left with a stray `workerd` needs to know which one and that it is theirs to kill.
    const h = immortal();
    const handle = await startDev(h.options);

    await handle.shutdown("stopped");

    expect(h.stdoutLines).toContain("Children still alive after grace window — sending SIGKILL.");
    expect(h.stdoutLines.some((line) => line.includes("api") && line.includes("web"))).toBe(true);
  });

  test("the state file is still removed, so a re-run is not blocked by a session that would not stop", async () => {
    const h = immortal();
    const handle = await startDev(h.options);

    await handle.shutdown("stopped");

    expect(h.removed).toEqual([4242]);
  });

  test("a teardown that gave up still flushes the log", async () => {
    // The record is what the session is read back from, so the bound must not cost it.
    const h = immortal();
    const handle = await startDev(h.options);

    await handle.shutdown("stopped");

    expect(h.logLines).toContain("stopping — stopped");
  });

  // Deliberately not tested here: that a *clean* teardown awaits its children rather than racing past
  // them. The fixture's clock resolves instantly, so `Promise.race([allExited, sleep(n)])` has no
  // deterministic winner for any `n` — a test of it would assert whichever the microtask queue happened
  // to favor. The cases above pin the property that was actually broken.
});

/**
 * **`l` never opens a prompt while the roster is on screen.**
 *
 * Past nine identities there is no digit left to bind, so `l` falls back to a prompt — and a prompt reads
 * its own stdin, which is why that branch calls `keys.stop()` first and `startKeys()` after. Under the
 * live roster that handover cannot happen: Ink owns raw mode for the life of the session and the reader
 * it is handed is inert, so the prompt and the footer would both read the keyboard and neither would
 * work. A real project hit it immediately — a seed that mints 29 users is ordinary.
 *
 * So with a roster the choice stays on the keys: the first nine are offered, and the rest are reachable
 * by naming one in `dev.json` rather than through a prompt that cannot run.
 */
describe("startDev — many identities under a roster", () => {
  test("without a roster, past nine is a prompt — unchanged", async () => {
    const asked: unknown[] = [];
    const h = harness({
      readDevLogins: seededLogins(12),
      chooseDevLogin: async (logins) => {
        asked.push(logins);
        return undefined;
      },
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.devLogin();

    expect(asked).toHaveLength(1);
  });

  test("with a roster, it offers the first nine on the keys and never prompts", async () => {
    const asked: unknown[] = [];
    const h = harness({
      readDevLogins: seededLogins(12),
      chooseDevLogin: async (logins) => {
        asked.push(logins);
        return undefined;
      },
    });
    const handle = await startDev({ ...h.options, roster: true });
    await signalReady(h);
    await handle.ready;

    await handle.devLogin();

    expect(asked).toEqual([]);
    expect(h.stdoutLines.some((line) => line.startsWith("Which identity? Press 1–9."))).toBe(true);
  });

  test("and it says how to reach the ones it could not list", async () => {
    // Twelve seeded, nine offered. Silently dropping three would be the kind of omission somebody
    // debugs for an hour.
    const h = harness({ readDevLogins: seededLogins(12) });
    const handle = await startDev({ ...h.options, roster: true });
    await signalReady(h);
    await handle.ready;

    await handle.devLogin();

    expect(h.stdoutLines.some((line) => line.includes("12") && line.includes("dev.json"))).toBe(true);
  });

  test("a digit still opens one of the nine", async () => {
    const opened: string[] = [];
    const h = harness({ readDevLogins: seededLogins(12), openUrl: async (url) => void opened.push(url) });
    const handle = await startDev({ ...h.options, roster: true });
    await signalReady(h);
    await handle.ready;

    await handle.devLogin();
    await handle.pickIdentity("3");

    expect(opened).toEqual([`http://localhost:8787/__pithy/dev-login?t=${CLAIM}-3`]);
  });

  test("nine or fewer is unaffected by the roster", async () => {
    const h = harness({ readDevLogins: seededLogins(3) });
    const handle = await startDev({ ...h.options, roster: true });
    await signalReady(h);
    await handle.ready;

    await handle.devLogin();

    expect(h.stdoutLines).toContain("Which identity? Press 1–3.");
    expect(h.stdoutLines.some((line) => line.includes("dev.json"))).toBe(false);
  });
});

/**
 * **What the identity picker asks the supervisor for.**
 *
 * The roster renders the list and resolves the choice; the supervisor still owns *who is seeded* and
 * *what signing in means*. Two methods, both re-reading the record as they are called, for the reason
 * `l` does: the file on disk is the truth, and a session that cached it could not see a `pithy seed`.
 */
describe("startDev — listing and choosing an identity", () => {
  test("listIdentities reads the record as it is called", async () => {
    let seeded = false;
    const three = seededLogins(3);
    const h = harness({ readDevLogins: async () => (seeded ? three() : undefined) });
    const handle = await startDev(h.options);

    expect(await handle.listIdentities()).toEqual([]);
    seeded = true;
    expect((await handle.listIdentities()).map((i) => i.email)).toEqual([
      "user1@example.com",
      "user2@example.com",
      "user3@example.com",
    ]);
  });

  test("it names people and never a claim", async () => {
    // `#667`'s rule. The picker renders whatever this returns, so the omission has to be here.
    const h = harness({ readDevLogins: seededLogins(2) });
    const handle = await startDev(h.options);

    for (const identity of await handle.listIdentities()) {
      expect(JSON.stringify(identity)).not.toContain(CLAIM);
    }
  });

  test("an expired identity is not offered", async () => {
    const h = harness({
      readDevLogins: async () => ({
        "example-1": {
          email: "gone@example.com",
          userId: "example-1",
          claim: `${CLAIM}-1`,
          expiresAt: new Date("2026-07-26T00:00:00.000Z"),
        },
      }),
    });
    const handle = await startDev(h.options);

    expect(await handle.listIdentities()).toEqual([]);
  });

  test("signInAs opens the identity it was handed, by userId", async () => {
    const opened: string[] = [];
    const h = harness({ readDevLogins: seededLogins(3), openUrl: async (url) => void opened.push(url) });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.signInAs("example-2");

    expect(opened).toEqual([`http://localhost:8787/__pithy/dev-login?t=${CLAIM}-2`]);
  });

  test("and by email, because that is what a person knows", async () => {
    const opened: string[] = [];
    const h = harness({ readDevLogins: seededLogins(3), openUrl: async (url) => void opened.push(url) });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.signInAs("user3@example.com");

    expect(opened).toEqual([`http://localhost:8787/__pithy/dev-login?t=${CLAIM}-3`]);
  });

  test("it signs in on the worker it is given", async () => {
    const opened: string[] = [];
    const h = harness({
      readDevLogins: seededLogins(1),
      devLoginTargets: async (started) => started.map(({ name, origin }) => ({ name, origin })),
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.signInAs("example-1", "web");

    expect(opened).toEqual([`http://localhost:8788/__pithy/dev-login?t=${CLAIM}-1`]);
  });

  test("a value naming nobody is refused, and opens nothing", async () => {
    const opened: string[] = [];
    const h = harness({ readDevLogins: seededLogins(3), openUrl: async (url) => void opened.push(url) });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.signInAs("nobody@example.com");

    expect(opened).toEqual([]);
    expect(h.stdoutLines.some((line) => line.includes("nobody@example.com"))).toBe(true);
  });
});

/**
 * **What else the roster supersedes.** Reported from a real session: with a table of five workers, their
 * states and their ports pinned below, `Starting dash-board, email, …` and `Ready.` are the same facts a
 * second time. The delivery verdict and the log path are **not** — one is the difference between a magic
 * link arriving and a file on disk, and the other matters more now that worker output is hidden by
 * default.
 */
describe("startDev — the banner under a roster", () => {
  const ready = async (h: ReturnType<typeof harness>) => {
    h.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    h.spawned[1]?.child.stdout.write("ready in 412\n");
    await flush();
  };

  test("without a roster, both lines are said, as they always were", async () => {
    const h = harness();
    await startDev(h.options);
    await ready(h);
    expect(h.stdoutLines).toContain("Starting api, web.");
    expect(h.stdoutLines).toContain("Ready.");
  });

  test("with a roster, neither is", async () => {
    const h = harness();
    await startDev({ ...h.options, roster: true });
    await ready(h);
    expect(h.stdoutLines.some((l) => l.startsWith("Starting "))).toBe(false);
    expect(h.stdoutLines).not.toContain("Ready.");
  });

  test("the log path survives, because hidden output makes it matter more", async () => {
    const h = harness();
    await startDev({ ...h.options, roster: true });
    await ready(h);
    expect(h.stdoutLines.some((l) => l.includes("logs →"))).toBe(true);
  });

  test("and logs/dev.log still records the lot", async () => {
    const plain = harness();
    await startDev(plain.options);
    await ready(plain);

    const rostered = harness();
    await startDev({ ...rostered.options, roster: true });
    await ready(rostered);

    expect(rostered.logLines).toEqual(plain.logLines);
  });
});

/**
 * **Parking a worker from the roster.** `pithy dev --app <name> --disable-autostart` already writes this;
 * `p` on a row writes the same key in the same file, scoped by the same three things — this checkout,
 * this branch, this machine — and committed nowhere.
 */
describe("startDev — parking a worker", () => {
  const parked = (overrides: Partial<StartDevOptions> = {}) => {
    const written: { root: string; branch: string; workers: readonly string[]; enabled: boolean }[] = [];
    const h = harness({
      ensureDeps: {
        registryPathFor: async () => "/cfg/dev-ports.json",
        rootFor: async () => "/proj",
        branchFor: async () => "main",
      },
      writeAutostart: async (args) => {
        written.push({ root: args.root, branch: args.branch, workers: args.workers, enabled: args.enabled });
        return {};
      },
      ...overrides,
    });
    return { h, written };
  };

  test("it writes the one worker, keyed on this checkout and this branch", async () => {
    const { h, written } = parked();
    const handle = await startDev(h.options);

    await handle.setAutostart("web", false);

    expect(written).toEqual([{ root: "/proj", branch: "main", workers: ["web"], enabled: false }]);
  });

  test("it raises the new answer, so the roster can mark the row", async () => {
    const { h } = parked();
    const events: DevEvent[] = [];
    const handle = await startDev({ ...h.options, events: (e) => events.push(e) });

    await handle.setAutostart("web", false);

    expect(events.filter((e) => e.event === "autostart")).toEqual([
      { event: "autostart", worker: "web", autostart: false },
    ]);
  });

  test("unparking raises the opposite", async () => {
    const { h } = parked();
    const events: DevEvent[] = [];
    const handle = await startDev({ ...h.options, events: (e) => events.push(e) });

    await handle.setAutostart("web", true);

    expect(events.filter((e) => e.event === "autostart")).toEqual([
      { event: "autostart", worker: "web", autostart: true },
    ]);
  });

  test("it says so, and says the worker keeps running", async () => {
    // The change is to a file the developer cannot see, and it does not take effect until the next run.
    // Both halves have to be said or `p` looks like it did nothing.
    const { h } = parked();
    const handle = await startDev(h.options);

    await handle.setAutostart("web", false);

    expect(h.stdoutLines.some((l) => l.includes("web") && l.includes("keeps running"))).toBe(true);
  });

  test("it does not stop the worker — `p` is about the next run", async () => {
    const { h } = parked();
    const handle = await startDev(h.options);

    await handle.setAutostart("web", false);

    expect(h.killCalls).toEqual([]);
    expect(h.stdoutLines.some((l) => l.startsWith("Stopping"))).toBe(false);
  });

  test("a name this project does not have is refused", async () => {
    const { h } = parked();
    const handle = await startDev(h.options);

    await expect(handle.setAutostart("nope", false)).rejects.toMatchObject({
      payload: { code: "validation/invalid_input" },
    });
  });

  test("a parked worker is raised as parked in the roster, before anything spawns", async () => {
    const h = harness({ autostartOverrides: { web: false } });
    const events: DevEvent[] = [];
    await startDev({ ...h.options, events: (e) => events.push(e) });

    const roster = events.find((e) => e.event === "roster");
    expect(roster).toMatchObject({
      members: [
        { worker: "api", autostart: true },
        { worker: "web", autostart: false },
      ],
    });
  });
});

/**
 * **`restart` has to survive being called twice, and being called into a teardown.**
 *
 * Every one of these was found by review rather than by use, and each is the kind of defect that looks
 * like something else when it bites: a port already in use, a worker that will not stop, a session that
 * exits with children still running.
 */
describe("startDev — restart under pressure", () => {
  test("pressing r twice spawns one replacement, not two", async () => {
    // `onRestart` fires per keypress with no debounce, and a restart takes a grace window — so a second
    // press lands inside the first. Both calls found the same child, both awaited the same exit, and both
    // spawned: two `wrangler dev` on one pinned port, and the first replacement referenced by nothing,
    // so `shutdown` never signals it and `.dev-state.json` never names it.
    const h = harness();
    const handle = await startDev(h.options);

    await Promise.all([handle.restart("api"), handle.restart("api")]);

    expect(h.spawned.filter((s) => s.opts.cwd === "/proj/apps/api")).toHaveLength(2);
  });

  test("a second r while the first is still working is ignored, not queued", async () => {
    const h = harness();
    const handle = await startDev(h.options);

    const first = handle.restart("api");
    const second = handle.restart("api");
    await Promise.all([first, second]);

    // One startup spawn plus one replacement.
    expect(h.spawned).toHaveLength(3);
  });

  test("a child that survives SIGKILL does not hang the restart forever", async () => {
    // `shutdown`'s wait was bounded for exactly this reason; this one was not. A hung restart also keeps
    // the worker in `restarting`, which makes the exit handler swallow a later genuine crash.
    const h = harness({ kill: () => {} });
    const handle = await startDev(h.options);

    await expect(handle.restart("api")).resolves.toBeUndefined();
  });

  test("and the worker is no longer held as restarting afterwards, so a real crash still counts", async () => {
    const h = harness({ kill: () => {} });
    const events: DevEvent[] = [];
    const handle = await startDev({ ...h.options, events: (e) => events.push(e) });
    await handle.restart("api");

    // The replacement dies on its own. That is a crash, and it must tear the session down.
    h.spawned.at(-1)?.child.emit("exit", 1);
    await flush();

    expect(events.some((e) => e.event === "exited" && e.expected === false)).toBe(true);
    expect(h.stdoutLines.some((l) => l.startsWith("Stopping"))).toBe(true);
  });

  test("a shutdown that lands mid-restart wins: nothing is spawned after it", async () => {
    // `shuttingDown` was read once on entry and then awaited across a 5s window. A `q` in that window ran
    // the whole teardown, and the restart then spawned a child nothing was signaling and rewrote the
    // state file the teardown had just removed.
    const h = harness({ kill: () => {} });
    const handle = await startDev(h.options);
    const before = h.spawned.length;

    const restarting = handle.restart("api");
    await handle.shutdown("stopped");
    await restarting;

    expect(h.spawned).toHaveLength(before);
  });

  test("and the state file stays removed", async () => {
    const h = harness({ kill: () => {} });
    const handle = await startDev(h.options);

    const restarting = handle.restart("api");
    await handle.shutdown("stopped");
    await restarting;

    // `removeState` ran, and nothing wrote the file again behind it.
    expect(h.removed).toEqual([4242]);
    expect(h.written.length).toBeGreaterThan(0);
    expect(h.written.at(-1)?.workers.api).toBeDefined();
  });
});

/**
 * **Two facts the roster was reading from the wrong array.**
 *
 * `started` is spliced when a host's config will not resolve, and it is a startup snapshot that a worker
 * started later from a parked row never joins. Reading either from it gave the footer a row that could
 * not change and a key that silently did nothing.
 */
describe("startDev — the roster reads the live set", () => {
  const withHost = (overrides: Partial<StartDevOptions> = {}) =>
    harness({
      loadDevConfig: async () => ({
        ...config,
        workers: { ...config.workers, email: { port: 8789, origin: "http://localhost:8789" } },
      }),
      discoverHostWorkers: async () => ({
        hosts: [
          {
            capability: "email",
            sourceDir: "/proj/apps/api",
            spec: { capability: "email", entry: "@pithy-sh/email/src/workflows/worker", package: "@pithy-sh/email" },
            worker: {
              name: "email",
              dir: "/proj/.wrangler/pithy/hosts/email",
              hasWrangler: true,
              dev: { readySignal: "Ready on https?://" },
            },
          } as never,
        ],
        notes: [],
      }),
      ...overrides,
    });

  test("a host whose config will not resolve is not raised as starting", async () => {
    // It was: the drop splices `started`, the roster event was built from the unspliced array, and the
    // row sat on `building` forever — no spawn, no exit, and the ready deadline reads `started` too. A
    // saffron spinner under a `Ready.` banner, and the 80ms repaint never stopping.
    const h = withHost({ materializeHostConfigs: async () => ({ notes: [], failed: ["email"] }) });
    const events: DevEvent[] = [];
    await startDev({ ...h.options, events: (e) => events.push(e) });

    const roster = events.find((e) => e.event === "roster");
    expect(roster).toMatchObject({ members: [{ worker: "api" }, { worker: "web" }, { worker: "email" }] });
    const email = (roster as Extract<DevEvent, { event: "roster" }>).members.find((m) => m.worker === "email");
    expect(email?.starts).toBe(false);
  });

  test("a host that does resolve is raised as starting", async () => {
    const h = withHost();
    const events: DevEvent[] = [];
    await startDev({ ...h.options, events: (e) => events.push(e) });

    const roster = events.find((e) => e.event === "roster") as Extract<DevEvent, { event: "roster" }>;
    expect(roster.members.find((m) => m.worker === "email")?.starts).toBe(true);
  });

  test("originOf answers for a worker this run never started", async () => {
    // `o` resolved the origin from `handle.workers`, the startup snapshot — so on a worker started later
    // from a parked row the key lit up and then silently did nothing.
    const h = harness();
    const handle = await startDev({ ...h.options, autostartOverrides: { web: false } });

    expect(handle.workers.map((w) => w.name)).toEqual(["api"]);
    expect(handle.originOf("web")).toBe("http://localhost:8788");
  });

  test("and answers for one it did", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    expect(handle.originOf("api")).toBe("http://localhost:8787");
  });

  test("and not for a name the project does not have", async () => {
    const h = harness();
    const handle = await startDev(h.options);
    expect(handle.originOf("nope")).toBeUndefined();
  });
});

/**
 * **Three places that still read the startup subset, and one event that was never raised.**
 *
 * `started` is what this run spawned. `roster` is the project. Reading the first where the second was
 * meant gave a row that could not change, a config that was never written, and a key that refused a
 * worker that was plainly running — each of them silent.
 */
describe("startDev — a worker started from a parked row is a full member", () => {
  const parkedHost = (overrides: Partial<StartDevOptions> = {}) => {
    const materialized: string[][] = [];
    const h = harness({
      loadDevConfig: async () => ({
        ...config,
        workers: { ...config.workers, email: { port: 8789, origin: "http://localhost:8789" } },
      }),
      discoverHostWorkers: async () => ({
        hosts: [
          {
            capability: "email",
            sourceDir: "/proj/apps/api",
            spec: { capability: "email", entry: "@pithy-sh/email/src/workflows/worker", package: "@pithy-sh/email" },
            worker: {
              name: "email",
              dir: "/proj/.wrangler/pithy/hosts/email",
              hasWrangler: true,
              dev: { readySignal: "Ready on https?://" },
            },
          } as never,
        ],
        notes: [],
      }),
      materializeHostConfigs: async (o) => {
        materialized.push(o.hosts.map((host) => host.worker.name));
        return { notes: [], failed: [] };
      },
      autostartOverrides: { email: false },
      ...overrides,
    });
    return { h, materialized };
  };

  test("restarting a parked host writes its config first", async () => {
    // `allHosts` and the materializer were assigned only when the run *selected* a host, so a project
    // whose only host is parked left both unset — and `r` spawned `wrangler dev` in a directory that was
    // never created. Combined with the missing `exited` below, completely silent.
    const { h, materialized } = parkedHost();
    const handle = await startDev(h.options);
    expect(materialized.flat()).not.toContain("email");

    await handle.restart("email");

    expect(materialized.flat()).toContain("email");
  });

  test("a spawn failure raises exited, so the row cannot sit on building forever", async () => {
    // Node emits `error` and never `exit` for a failed spawn. The handler emitted a line and resolved,
    // but raised nothing — so the roster kept a saffron spinner and `ticking()` kept the footer
    // repainting at 80ms for a process that did not exist.
    const h = harness();
    const events: DevEvent[] = [];
    await startDev({ ...h.options, events: (e) => events.push(e) });

    h.spawned[0]?.child.emit("error", new Error("spawn vite ENOENT"));
    await flush();

    expect(events.filter((e) => e.event === "exited")).toContainEqual({
      event: "exited",
      worker: "api",
      code: null,
      expected: false,
    });
  });

  test("the dev-login targets include a worker started from a parked row", async () => {
    // The same class as `originOf`, missed: `resolveDevLoginTargets` was fed `started`, so `l` on a
    // worker that `r` had plainly just started refused it by name.
    const seen: string[][] = [];
    const h = harness({
      readDevLogins: seededLogins(1),
      devLoginTargets: async (started) => {
        seen.push(started.map((s) => s.name));
        return started.map(({ name, origin }) => ({ name, origin }));
      },
      autostartOverrides: { web: false },
    });
    const handle = await startDev(h.options);
    await handle.restart("web");
    await handle.devLogin("web");

    expect(seen.at(-1)).toContain("web");
  });

  test("a replacement that dies while the state file is written counts as a crash", async () => {
    // `restarting` was held across `await recordState()`, so a death in that window was raised as an
    // *expected* exit: the roster did not reveal the output explaining it, and the shutdown was
    // suppressed. The session carried on with a dead worker in it.
    const events: DevEvent[] = [];
    // Armed only for the restart. `writeState` also runs at startup, and firing there killed the
    // session before the restart under test ever happened.
    let killDuringWrite = false;
    let spawnedChildren: { child: { emit: (event: string, code: number) => void } }[] = [];
    const h = harness({
      writeState: async (_path, state) => {
        DevState.parse(state);
        if (!killDuringWrite) return;
        killDuringWrite = false;
        // The replacement dies mid-write: the port its predecessor still holds, most often.
        spawnedChildren.at(-1)?.child.emit("exit", 1);
        await flush();
      },
    });
    spawnedChildren = h.spawned;
    const handle = await startDev({ ...h.options, events: (e) => events.push(e) });

    killDuringWrite = true;
    await handle.restart("api");
    await flush();

    // Its own exit, not the last one in the stream: the crash tears the session down, so every sibling
    // exits after it and those are expected.
    const api = events.filter((e) => e.event === "exited" && e.worker === "api");
    expect(api.at(-1)).toMatchObject({ worker: "api", expected: false });
  });
});

describe("startDev — the dev-login banner under a roster", () => {
  const ready = async (h: ReturnType<typeof harness>) => {
    h.spawned[0]?.child.stdout.write("Ready on http://localhost:8787\n");
    h.spawned[1]?.child.stdout.write("ready in 412\n");
    await flush();
  };

  test("without a roster it is said, because nothing else would say it", async () => {
    const h = harness({ readDevLogins: seededLogins(1) });
    await startDev(h.options);
    await ready(h);
    expect(h.stdoutLines.some((l) => l.startsWith("Dev login:"))).toBe(true);
  });

  test("with a roster it is not: `l login` on the bar is the discovery", async () => {
    const h = harness({ readDevLogins: seededLogins(1) });
    await startDev({ ...h.options, roster: true });
    await ready(h);
    expect(h.stdoutLines.some((l) => l.startsWith("Dev login:"))).toBe(false);
  });

  test("and the delivery verdict still is, because no row carries it", async () => {
    const h = harness({ readDevLogins: seededLogins(1) });
    await startDev({ ...h.options, roster: true });
    await ready(h);
    expect(h.stdoutLines.some((l) => l.includes("logs →"))).toBe(true);
  });
});
