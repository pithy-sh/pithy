// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";

const run = promisify(execFile);

/**
 * Try to bind `port` on `host`, resolving `true` when it is free and `false` when it is taken.
 * The dual-stack primitive: a port is only usable if this succeeds on **both** `127.0.0.1` and `::1`
 * (Vite binds IPv6-only, wrangler binds both families), so a loopback check on one family is not enough.
 */
export function tryBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** The bind seam — real {@link tryBind} in production, a stub in tests. */
export type TryBind = (port: number, host: string) => Promise<boolean>;

/**
 * Assert a worker's **pinned** port is free — the deliberate divergence from CMS `pickPort`.
 *
 * The port is authoritative: it comes from the feature's `.dev.config.json`, assigned once at feature
 * creation and held for the feature's life. So this only verifies; it never scans forward to another
 * port. A worker that silently drifts off its pinned port breaks every sibling that was told its address
 * ahead of time, so a conflict is reported, not worked around. The port must be free on **both** loopback
 * families; a failure on either aborts the whole `pithy dev` session with one actionable error.
 */
export async function verifyPinnedPort(name: string, port: number, bind: TryBind = tryBind): Promise<void> {
  const freeV4 = await bind(port, "127.0.0.1");
  const freeV6 = await bind(port, "::1");
  if (freeV4 && freeV6) return;
  throw new ConflictError({
    message: `Port ${port} for worker "${name}" is already in use.`,
    action: "Stop whatever is holding it, then run pithy dev again.",
    detail: `free on 127.0.0.1=${freeV4}, ::1=${freeV6}`,
  });
}

/** Whether `pid` is a live process — `process.kill(pid, 0)` probes without signaling. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sleep seam — real `setTimeout` in production, controllable in tests. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `pid` is dead or `timeoutMs` elapses; resolves `true` if it exited, `false` on timeout. */
export async function waitForExit(
  pid: number,
  timeoutMs: number,
  deps: { isAlive?: (pid: number) => boolean; sleep?: Sleep } = {},
): Promise<boolean> {
  const alive = deps.isAlive ?? isAlive;
  const sleep = deps.sleep ?? realSleep;
  const start = Date.now();
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(100);
  }
}

/** Look up the pids listening on a TCP `port` — the real one shells out to `lsof`. */
export type LsofPort = (port: number) => Promise<number[]>;

/** `lsof -ti tcp:<port>` → the pids holding it, or `[]` when lsof is missing or errors. */
export const lsofPort: LsofPort = async (port) => {
  try {
    const { stdout } = await run("lsof", ["-ti", `tcp:${port}`]);
    return stdout
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
};

/** Look up a pid's full command line — the sweep's scope filter. */
export type ProcessCommand = (pid: number) => Promise<string | null>;

/** `ps -o args= -p <pid>` → the pid's command line, or `null` when it is gone or `ps` is unavailable. */
export const psCommand: ProcessCommand = async (pid) => {
  try {
    const { stdout } = await run("ps", ["-o", "args=", "-p", String(pid)]);
    const line = stdout.trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
};

/** Look up a pid's parent — walked upward so the sweep never signals its own ancestry. */
export type ParentPid = (pid: number) => Promise<number | null>;

/** `ps -o ppid= -p <pid>` → the parent pid, or `null` when it is gone or `ps` is unavailable. */
export const psParent: ParentPid = async (pid) => {
  try {
    const { stdout } = await run("ps", ["-o", "ppid=", "-p", String(pid)]);
    const ppid = Number(stdout.trim());
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
};

/** The binaries the sweep owns: the Workers runtime and its supervisor. */
const WORKER_BINARY = /^(workerd|wrangler)(\.[cm]?js)?$/;
/** Launchers that run a script — the script name, not the launcher, says what the process is. */
const SCRIPT_RUNNER = /^(node|bun|deno|npx|bunx)$/;

/** The last path segment of `token`, stripped of a Windows `.exe` suffix. */
function commandBase(token: string): string {
  return (token.split("/").pop() ?? "").replace(/\.exe$/, "");
}

/**
 * Whether a command line is one of ours to reap — `workerd` itself, or a `wrangler` launched directly or
 * through a script runner (`node …/.bin/wrangler dev`, `bun x wrangler dev`).
 *
 * The sweep exists to clear a crashed session's orphans, not to clear the port. Anything else holding a
 * pinned port is a genuine external conflict and must reach `verifyPinnedPort`, which reports it.
 */
export function isReapableDevCommand(command: string | null): boolean {
  if (!command) return false;
  const tokens = command.trim().split(/\s+/);
  const exe = commandBase(tokens[0] ?? "");
  if (WORKER_BINARY.test(exe)) return true;
  if (!SCRIPT_RUNNER.test(exe)) return false;
  return tokens.slice(1).some((token) => WORKER_BINARY.test(commandBase(token)));
}

/** This process and every ancestor of it — never signalled, whatever is holding a port. */
async function ancestorPids(selfPid: number, parentOf: ParentPid): Promise<Set<number>> {
  const chain = new Set<number>([selfPid]);
  let pid = selfPid;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = await parentOf(pid);
    if (parent === null || parent <= 1 || chain.has(parent)) break;
    chain.add(parent);
    pid = parent;
  }
  return chain;
}

/** Seams for {@link sweepStaleDevPorts}, so it can be driven without real `lsof`/`ps`/`kill`. */
export interface SweepDeps {
  lsof?: LsofPort;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  log?: (message: string) => void;
  /** Command-line lookup, the scope filter (default: {@link psCommand}). */
  commandOf?: ProcessCommand;
  /** Parent lookup, for the ancestry guard (default: {@link psParent}). */
  parentOf?: ParentPid;
  /** Pids the previous session recorded in `.dev-state.json` — ours by construction, reaped whatever they run. */
  knownPids?: readonly number[];
  /** This process's pid (default: `process.pid`). */
  selfPid?: number;
}

/**
 * Reap orphaned `workerd`/`wrangler` processes still holding the pinned dev ports — a crashed previous
 * session must not block startup. Mirrors the CMS zombie-workerd sweep, with the scope its name promises:
 * a pid is reaped only when it is one of ours — a `workerd`/`wrangler`-shaped command, or a pid the
 * previous session recorded — and never when it is this process or one of its ancestors. Anything else
 * is left alone and falls through to {@link verifyPinnedPort}, which reports an actionable conflict
 * instead of silently SIGKILLing an unrelated dev server, database, or editor.
 *
 * Returns the pids reaped, so a re-run can report what it cleaned up.
 */
export async function sweepStaleDevPorts(ports: number[], deps: SweepDeps = {}): Promise<number[]> {
  const lsof = deps.lsof ?? lsofPort;
  const alive = deps.isAlive ?? isAlive;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const commandOf = deps.commandOf ?? psCommand;
  const parentOf = deps.parentOf ?? psParent;
  const selfPid = deps.selfPid ?? process.pid;
  const known = new Set(deps.knownPids ?? []);
  const reaped: number[] = [];
  // Resolved once, and only when something is actually about to be signalled.
  let protectedPids: Set<number> | null = null;

  for (const port of ports) {
    for (const pid of await lsof(port)) {
      if (pid === selfPid || !alive(pid)) continue;
      const ours = known.has(pid);
      if (!ours && !isReapableDevCommand(await commandOf(pid))) {
        deps.log?.(`port ${port} is held by pid ${pid}, which is not a stale worker — leaving it`);
        continue;
      }
      protectedPids ??= await ancestorPids(selfPid, parentOf);
      if (protectedPids.has(pid)) continue;
      deps.log?.(`reaping stale process on port ${port} (pid ${pid})`);
      try {
        kill(pid, "SIGKILL");
        reaped.push(pid);
      } catch {
        // Already gone between the lsof and the kill — nothing to reap.
      }
    }
  }
  return reaped;
}
