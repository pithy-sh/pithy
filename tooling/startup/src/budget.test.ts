// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  activeStartupMs,
  baseRef,
  CommandFailed,
  exitStatus,
  type GateIo,
  median,
  runGate,
  STARTS,
  STARTUP_REGRESSION_THRESHOLD,
  startupVerdict,
} from "./budget";

/** What `wrangler check startup` prints, trimmed to the lines around the figure. */
const OUTPUT = `
│ Bundle: 12157.15 KiB / gzip: 2898.68 KiB
│
│ Local startup profile:
│   Profile window: 250.1 ms
│   Sampled time: 247.0 ms
│   Active: 137.4 ms (including 19.9 ms garbage collection)
│   Idle: 109.6 ms
`;

describe("activeStartupMs", () => {
  test("reads the active figure", () => {
    expect(activeStartupMs(OUTPUT)).toBe(137.4);
  });

  test("refuses output with no figure, rather than passing a check that measured nothing", () => {
    expect(() => activeStartupMs("✘ [ERROR] The `assets` property is missing")).toThrow(/no active startup figure/);
  });
});

describe("median", () => {
  test("is the middle run, so one noisy sample neither fails nor passes the gate", () => {
    expect(median([161.4, 132.7, 139.8])).toBe(139.8);
  });

  test("refuses no runs", () => {
    expect(() => median([])).toThrow(/no runs/);
  });
});

describe("baseRef", () => {
  test("is origin/main when none is named, so a local run compares against main", () => {
    expect(baseRef([])).toBe("origin/main");
  });

  test("is the commit named, which is how CI passes the pull request's base", () => {
    expect(baseRef(["--base", "ee8fc97"])).toBe("ee8fc97");
    expect(baseRef(["--base=ee8fc97"])).toBe("ee8fc97");
  });

  test("is none when the name is empty: a push to main has no pull request base", () => {
    expect(baseRef(["--base", ""])).toBeUndefined();
    expect(baseRef(["--base="])).toBeUndefined();
    expect(baseRef(["--base"])).toBeUndefined();
  });

  test("refuses a name that is an option, so a missing value cannot swallow the next flag", () => {
    expect(() => baseRef(["--base", "--help"])).toThrow(/not a commit/);
    expect(() => baseRef(["--base=-x"])).toThrow(/not a commit/);
  });
});

describe("startupVerdict", () => {
  test("passes at the threshold over the base", () => {
    expect(startupVerdict(230, 200, 0.15)).toEqual({
      ok: true,
      message: "Startup CPU 230.0 ms against 200.0 ms on the base, +15.0%, within the 15% allowed (limit 230.0 ms).",
    });
  });

  test("fails above it, naming both figures and the change", () => {
    expect(startupVerdict(231, 200, 0.15)).toEqual({
      ok: false,
      message:
        "Startup CPU 231.0 ms against 200.0 ms on the base, +15.5%, over the 15% allowed (limit 230.0 ms). Load the startup profile to see where it went.",
    });
  });

  test("passes a build that starts faster than its base", () => {
    expect(startupVerdict(137.4, 228.5, 0.15)).toEqual({
      ok: true,
      message: "Startup CPU 137.4 ms against 228.5 ms on the base, -39.9%, within the 15% allowed (limit 262.8 ms).",
    });
  });

  test("scales with the machine: the same change passes or fails on a runner twice as slow", () => {
    expect(startupVerdict(150 * 2, 137 * 2, STARTUP_REGRESSION_THRESHOLD).ok).toBe(true);
    expect(startupVerdict(170 * 2, 137 * 2, STARTUP_REGRESSION_THRESHOLD).ok).toBe(false);
  });

  test("with no base, passes and says nothing was compared, so a push to main never fails on noise", () => {
    expect(startupVerdict(273.6, undefined, STARTUP_REGRESSION_THRESHOLD)).toEqual({
      ok: true,
      message: "Startup CPU 273.6 ms. No base to compare against, so it is reported and not gated.",
    });
  });
});

describe("exitStatus", () => {
  test("is the child's own status when it exited", () => {
    expect(exitStatus({ status: 0, signal: null })).toBe(0);
    expect(exitStatus({ status: 2, signal: null })).toBe(2);
  });

  test("is 128 plus the signal's number when a signal killed it, as a shell reports it", () => {
    expect(exitStatus({ status: null, signal: "SIGINT" })).toBe(130);
    expect(exitStatus({ status: null, signal: "SIGKILL" })).toBe(137);
    expect(exitStatus({ status: null, signal: "SIGTERM" })).toBe(143);
  });

  test("is 1 when neither is known, never 0", () => {
    expect(exitStatus({ status: null, signal: null })).toBe(1);
  });
});

const ROOT = "/repo";
const HEAD = join(ROOT, "tooling", "startup");
const BASE = "/tmp/startup-base-test";
const BASE_REFERENCE = join(BASE, "tooling", "startup");
const WRANGLER = join(HEAD, "node_modules", ".bin", "wrangler");

interface Call {
  command: string;
  args: readonly string[];
  cwd: string;
}

/**
 * A gate's world with every command answered in memory. `fail` returns the status a call fails with (`true`
 * is 2), `interruptOn` sends SIGINT while a call runs, and `output` replaces wrangler's.
 */
function fakeIo(
  options: {
    fail?: (call: Call) => boolean | number;
    interruptOn?: (call: Call) => boolean;
    activeMs?: (cwd: string) => number;
    output?: (cwd: string) => string | undefined;
    built?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const removed: string[] = [];
  const copied: [string, string][] = [];
  const out: string[] = [];
  const listeners: (() => void)[] = [];
  const interrupts = { registered: 0, released: 0 };
  const io: GateIo = {
    async run(command, args, cwd) {
      const call: Call = { command, args, cwd };
      calls.push(call);
      if (options.interruptOn?.(call)) for (const listener of listeners) listener();
      const failed = options.fail?.(call);
      if (failed) throw new CommandFailed(failed === true ? 2 : failed, `${command} failed`);
      if (command === WRANGLER) {
        return options.output?.(cwd) ?? `│   Active: ${(options.activeMs ?? (() => 100))(cwd)} ms\n`;
      }
      if (command === "git" && args[0] === "rev-parse" && args[1] !== "--verify") return "abc123\n";
      return "";
    },
    exists: () => options.built ?? true,
    copyTree: (from, to) => {
      copied.push([from, to]);
    },
    makeTempDir: () => BASE,
    remove: (path) => {
      removed.push(path);
    },
    write: (text) => {
      out.push(text);
    },
    onInterrupt: (listener) => {
      interrupts.registered += 1;
      listeners.push(listener);
      return () => {
        interrupts.released += 1;
      };
    },
  };
  const measured = () => calls.filter((call) => call.command === WRANGLER).map((call) => call.cwd);
  const cleaned = () => removed.includes(BASE);
  return { io, calls, removed, copied, out: () => out.join(""), interrupts, measured, cleaned };
}

const PR = { root: ROOT, args: ["--base", "abc123"], event: "pull_request" };
const isBuild = (call: Call) => call.command === "bun" && call.args[1] === "build";
const isStart = (call: Call) => call.command === "node" && call.args[0] === STARTS;
const REMEDY = /re-run the job, or merge main into the branch and push/;

describe("runGate", () => {
  test("measures each side in its own directory, interleaved, and cleans up after", async () => {
    const world = fakeIo({ activeMs: (cwd) => (cwd === BASE_REFERENCE ? 200 : 150) });
    expect(await runGate(world.io, PR)).toBe(0);
    expect(world.measured()).toEqual([BASE_REFERENCE, HEAD, HEAD, BASE_REFERENCE, BASE_REFERENCE, HEAD]);
    expect(world.calls.find(isBuild)).toMatchObject({ cwd: BASE });
    expect(world.cleaned()).toBe(true);
    expect(world.interrupts).toEqual({ registered: 1, released: 1 });
  });

  test("exports the base rather than checking it out, and measures this tree's reference Worker over it", async () => {
    const world = fakeIo();
    expect(await runGate(world.io, PR)).toBe(0);
    expect(world.calls.some((call) => call.command === "git" && call.args[0] === "worktree")).toBe(false);
    expect(world.calls.find((call) => call.args[0] === "archive")?.args).toContain("abc123");
    expect(world.copied).toEqual([[HEAD, BASE_REFERENCE]]);
    // The copy lands after the export, so the base's own reference Worker, if it has one, is replaced.
    const exported = world.calls.findIndex((call) => call.command === "tar");
    const installed = world.calls.findIndex((call) => call.command === "bun" && call.args[0] === "install");
    expect(exported).toBeGreaterThan(-1);
    expect(installed).toBeGreaterThan(exported);
  });

  test("fails a regression over the base", async () => {
    const world = fakeIo({ activeMs: (cwd) => (cwd === BASE_REFERENCE ? 100 : 120) });
    expect(await runGate(world.io, PR)).toBe(1);
    expect(world.out()).toMatch(/over the 15% allowed/);
    expect(world.cleaned()).toBe(true);
  });

  test("cleans up the base when wrangler fails, and exits with wrangler's status", async () => {
    const world = fakeIo({ fail: (call) => call.command === WRANGLER && call.cwd === HEAD });
    expect(await runGate(world.io, PR)).toBe(2);
    expect(world.cleaned()).toBe(true);
    expect(world.interrupts.released).toBe(1);
  });

  test("fails closed when the base's wrangler output has no figure", async () => {
    const world = fakeIo({ output: (cwd) => (cwd === BASE_REFERENCE ? "✘ [ERROR] nothing measured" : undefined) });
    expect(await runGate(world.io, PR)).toBe(1);
    expect(world.out()).toMatch(/no active startup figure/);
    expect(world.cleaned()).toBe(true);
  });

  test("a base that does not build fails closed, naming the remedy, and measures nothing", async () => {
    const world = fakeIo({ fail: isBuild });
    expect(await runGate(world.io, PR)).toBe(2);
    expect(world.measured()).toEqual([]);
    expect(world.out()).toMatch(REMEDY);
    expect(world.cleaned()).toBe(true);
  });

  test("a base that does not install fails closed", async () => {
    const world = fakeIo({ fail: (call) => call.command === "bun" && call.args[0] === "install" });
    expect(await runGate(world.io, PR)).toBe(2);
    expect(world.out()).toMatch(REMEDY);
    expect(world.cleaned()).toBe(true);
  });

  test("a base that does not export fails closed", async () => {
    const world = fakeIo({ fail: (call) => call.args[0] === "archive" });
    expect(await runGate(world.io, PR)).toBe(2);
    expect(world.out()).toMatch(REMEDY);
    expect(world.measured()).toEqual([]);
    expect(world.cleaned()).toBe(true);
  });

  test("a base build killed by a signal fails closed with the signal's status", async () => {
    const world = fakeIo({ fail: (call) => (isBuild(call) ? 137 : false) });
    expect(await runGate(world.io, PR)).toBe(137);
    expect(world.measured()).toEqual([]);
    expect(world.cleaned()).toBe(true);
  });

  test("a base that cannot be fetched fails closed", async () => {
    const world = fakeIo({ fail: (call) => call.args[0] === "rev-parse" || call.args[0] === "fetch" });
    expect(await runGate(world.io, PR)).toBe(2);
    expect(world.out()).toMatch(REMEDY);
    expect(world.calls.some((call) => call.args[0] === "archive")).toBe(false);
  });

  test("a base build stopped by Ctrl-C exits 130 and measures nothing", async () => {
    const world = fakeIo({ fail: (call) => (isBuild(call) ? 130 : false) });
    expect(await runGate(world.io, PR)).toBe(130);
    expect(world.measured()).toEqual([]);
    expect(world.out()).not.toMatch(REMEDY);
    expect(world.cleaned()).toBe(true);
  });

  test("a SIGINT to the script alone, while a command still succeeds, stops the run at 130", async () => {
    const world = fakeIo({ interruptOn: (call) => call.command === WRANGLER && call.cwd === BASE_REFERENCE });
    expect(await runGate(world.io, PR)).toBe(130);
    expect(world.measured()).toEqual([BASE_REFERENCE]);
    expect(world.cleaned()).toBe(true);
  });

  test("Ctrl-C while fetching is an interrupt, not a missing commit", async () => {
    const world = fakeIo({ fail: (call) => (call.args[0] === "rev-parse" ? 130 : false) });
    expect(await runGate(world.io, PR)).toBe(130);
    expect(world.calls.some((call) => call.args[0] === "fetch")).toBe(false);
  });

  test("starts each side's Worker once before measuring either", async () => {
    const world = fakeIo();
    expect(await runGate(world.io, PR)).toBe(0);
    expect(world.calls.filter(isStart).map((call) => call.cwd)).toEqual([HEAD, BASE_REFERENCE]);
    const firstMeasure = world.calls.findIndex((call) => call.command === WRANGLER);
    const lastStart = world.calls.length - 1 - [...world.calls].reverse().findIndex(isStart);
    expect(lastStart).toBeLessThan(firstMeasure);
  });

  test("a Worker that throws while it starts fails the gate and is never measured, since wrangler would time it as fast", async () => {
    const world = fakeIo({ fail: (call) => isStart(call) && call.cwd === HEAD });
    expect(await runGate(world.io, PR)).toBe(2);
    expect(world.measured()).toEqual([]);
    expect(world.calls.some((call) => call.args[0] === "archive")).toBe(false);
  });

  test("a base whose Worker does not start fails closed and measures nothing", async () => {
    const world = fakeIo({ fail: (call) => isStart(call) && call.cwd === BASE_REFERENCE });
    expect(await runGate(world.io, PR)).toBe(2);
    expect(world.measured()).toEqual([]);
    expect(world.cleaned()).toBe(true);
  });

  test("a run with no base still refuses a Worker that does not start", async () => {
    const world = fakeIo({ fail: isStart });
    expect(await runGate(world.io, { root: ROOT, args: ["--base", ""], event: "workflow_dispatch" })).toBe(2);
    expect(world.measured()).toEqual([]);
  });

  test("refuses a pull request with no base rather than skip the gate", async () => {
    const world = fakeIo();
    expect(await runGate(world.io, { ...PR, args: ["--base", ""] })).toBe(1);
    expect(world.measured()).toEqual([]);
    expect(world.out()).toMatch(/pull request/);
  });

  test("a run with no base measures once, reports a notice and passes", async () => {
    const world = fakeIo();
    expect(await runGate(world.io, { root: ROOT, args: ["--base", ""], event: "workflow_dispatch" })).toBe(0);
    expect(world.measured()).toEqual([HEAD]);
    expect(world.out()).toContain("::notice title=Startup CPU::");
    expect(world.calls.some((call) => call.args[0] === "archive")).toBe(false);
  });

  test("refuses a tree that is not built, before building anything", async () => {
    const world = fakeIo({ built: false });
    expect(await runGate(world.io, PR)).toBe(1);
    expect(world.calls).toEqual([]);
    expect(world.out()).toMatch(/bun run build/);
  });

  test("refuses a base named like an option", async () => {
    const world = fakeIo();
    expect(await runGate(world.io, { ...PR, args: ["--base", "-x"] })).toBe(1);
    expect(world.calls).toEqual([]);
  });

  test("fetches a base the shallow checkout does not have", async () => {
    const world = fakeIo({ fail: (call) => call.args[0] === "rev-parse" && call.args[1] === "--verify" });
    expect(await runGate(world.io, PR)).toBe(0);
    expect(world.calls.some((call) => call.args[0] === "fetch" && call.args.includes("abc123"))).toBe(true);
  });
});
