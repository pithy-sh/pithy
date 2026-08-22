// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GENERATED_MARKER, generateDevVars } from "../devSecrets/generate";
import { type DevConfig, devConfigPath, readDevConfig } from "../feature/devConfig";
import { BLOCK_SIZE, type PortsRegistry } from "../feature/ports";
import type { WorkerTarget } from "../project/workers";
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
import type { DevState } from "./state";

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
    dev: { autostart: true, readySignal: "Ready on https?://" },
  },
  {
    name: "web",
    dir: "/proj/apps/web",
    hasWrangler: false,
    dev: { autostart: true, readySignal: "ready in \\d+", command: ["vite", "--host"] },
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
    hasCloudflareLogin: async () => true,
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
      ],
    });
    expect(web).toMatchObject({ command: "vite", args: ["--host"] });
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

/** The one value that must never reach a line — asserted directly rather than left to review. */
const COOKIE_VALUE = "dev-session-example-ada-abcd.c2ln";

/** What `pithy seed` wrote, as `readDevLogin` hands it over. */
const seededLogin = async () => ({
  email: "ada@example.com",
  userId: "example-ada",
  cookieName: "better-auth.session_token",
  cookieValue: COOKIE_VALUE,
  expiresAt: new Date("2027-07-27T00:00:00.000Z"),
});

/** A key reader that hands its bindings back, so a test can press a key without a terminal. */
function pressable(): { readKeys: StartDevOptions["readKeys"]; press: (key: string) => Promise<void>; stops: number } {
  const state = { bindings: [] as { key: string; run: () => void | Promise<void> }[], stops: 0 };
  return {
    readKeys: (options) => {
      state.bindings = [...options.bindings];
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
  };
}

describe("startDev — the l keypress", () => {
  test("opens the worker that carries the route, and says what it opened", async () => {
    const keys = pressable();
    const opened: string[] = [];
    const h = harness({
      readDevLogin: seededLogin,
      readKeys: keys.readKeys,
      openUrl: async (url) => void opened.push(url),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await keys.press("l");

    expect(opened).toEqual(["http://localhost:8787/__pithy/dev-login"]);
    expect(h.stdoutLines).toContain("Opening http://localhost:8787/__pithy/dev-login as ada@example.com.");
  });

  test("names pithy seed rather than opening a URL that 404s", async () => {
    const keys = pressable();
    const opened: string[] = [];
    const h = harness({
      readDevLogin: async () => undefined,
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
      readDevLogin: seededLogin,
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
    const h = harness({ readDevLogin: seededLogin, readKeys: keys.readKeys });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    await handle.shutdown("interrupted");

    expect(keys.stops).toBe(1);
  });

  test("Ctrl-C still stops the session — raw mode is what takes that away", async () => {
    let interrupt: (() => void) | undefined;
    const h = harness({
      readDevLogin: seededLogin,
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
      readDevLogin: seededLogin,
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
      readDevLogin: seededLogin,
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
    const h = harness({ readDevLogin: seededLogin });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    // No terminal in this harness, so the URL is what the banner can honestly offer.
    expect(h.stdoutLines).toContain(
      "Dev login: ada@example.com — open http://localhost:8787/__pithy/dev-login to sign in.",
    );
  });

  test("the cookie reaches neither the terminal nor logs/dev.log", async () => {
    // The reason this feature exists. `pithy dev`'s output is read, piped, tee'd and screenshotted, so a
    // session token printed once is a session token at rest.
    const h = harness({ readDevLogin: seededLogin });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    for (const line of [...h.stdoutLines, ...h.logLines]) {
      expect(line).not.toContain(COOKIE_VALUE);
      expect(line).not.toContain("better-auth.session_token");
      expect(line).not.toContain("document.cookie");
    }
  });

  test("offers the keypress where there is a terminal to press it on", async () => {
    const h = harness({ readDevLogin: seededLogin, readKeys: () => ({ active: true, stop: () => {} }) });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    expect(h.stdoutLines).toContain("Dev login: ada@example.com — press l to open a signed-in browser.");
  });

  test("says so rather than offering a keypress when no running worker composes auth", async () => {
    const h = harness({
      readDevLogin: seededLogin,
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
    const h = harness({ readDevLogin: async () => undefined });
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
          { name: "api", dir: apiDir, hasWrangler: true, dev: { autostart: true, readySignal: "Ready on https?://" } },
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
    // The silent path this closes. Since #179 a `cf-secrets-store` secret is materialised only if the
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
      dev: { autostart: true, readySignal: "Ready on https?://" },
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
      hasCloudflareLogin: async () => false,
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
      hasCloudflareLogin: async () => false,
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
    // started set and `wrangler dev` was spawned in a directory materialisation never created. Node
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
