// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import { type DevConfig, devConfigPath, readDevConfig } from "../feature/devConfig";
import type { PortsRegistry } from "../feature/ports";
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

  const written: DevState[] = [];
  let stored: DevState | null = null;
  const removed: number[] = [];

  const options: StartDevOptions = {
    projectDir: "/proj",
    discoverWorkers: async () => workers,
    loadDevConfig: async () => config,
    tryBind: async () => true,
    sweep: async () => [],
    spawn,
    kill,
    isAlive: (pid) => livePids.has(pid),
    sleep: async () => {},
    launchWrangler: (args) => ({ command: "bun", args: ["x", "wrangler", ...args] }),
    hasSetsid: true,
    stdout: (t) => stdoutLines.push(t.replace(/\n$/, "")),
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
    logLines,
    written,
    removed,
    livePids,
    setStored: (s: DevState | null) => {
      stored = s;
    },
  };
}

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
  /** A temp project dir plus its own registry, so nothing touches the real repo. */
  async function project() {
    const dir = await mkdtemp(join(tmpdir(), "pithy-dev-bootstrap-"));
    const registryPath = join(dir, ".dev-ports.json");
    return {
      dir,
      registryPath,
      registry: async () => JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry,
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
        branchFor: async () => null,
      });

      expect(dev.workers.api).toEqual({ port: 8787, origin: "http://localhost:8787" });
      expect(dev.workers.web).toEqual({ port: 8788, origin: "http://localhost:8788" });
      expect(await readDevConfig(devConfigPath(p.dir))).toEqual(dev);
      // Off a branch the checkout path is the registry key — one block per checkout, still centrally locked.
      expect((await p.registry())[`local:${p.dir}`]).toEqual({ block: 0, base: 8787, size: 10 });
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
        branchFor: async () => "main",
      };
      const first = await ensureDevConfig({ ...deps, existing: null });
      const again = await ensureDevConfig({ ...deps, existing: await readDevConfig(devConfigPath(p.dir)) });

      expect(again).toEqual(first);
      expect(Object.keys(await p.registry())).toEqual(["main"]);
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
        // An existing config keeps its own block: the registry is never re-keyed under a live feature.
        registryPathFor: async () => {
          throw new Error("the registry must not be touched when a block is already pinned");
        },
        branchFor: async () => "some/other-branch",
      });

      expect(dev.branch).toBe("feature/73-cli-commands");
      expect(dev.workers.web?.port).toBe(8788);
      expect(dev.workers.api?.port).toBe(8787);
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
    const h = harness({
      readDevLogin: async () => ({
        email: "ada@example.com",
        userId: "example-ada",
        cookieName: "better-auth.session_token",
        cookieValue: "dev-session-example-ada-abcd.c2ln",
        expiresAt: new Date("2027-07-27T00:00:00.000Z"),
      }),
    });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    expect(h.stdoutLines).toContain("Dev login: ada@example.com. Paste into the browser console, then reload.");
    expect(h.stdoutLines.some((line) => line.includes("better-auth.session_token="))).toBe(true);
  });

  test("says nothing about signing in when no seed wrote a login", async () => {
    const h = harness({ readDevLogin: async () => undefined });
    const handle = await startDev(h.options);
    await signalReady(h);
    await handle.ready;

    expect(h.stdoutLines.some((line) => line.startsWith("Dev login:"))).toBe(false);
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
