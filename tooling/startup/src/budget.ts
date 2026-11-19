// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

// Fail when the reference Worker's startup CPU has grown too far over its base's.
//
//   bun tooling/startup/src/budget.ts                  # against origin/main as last fetched
//   bun tooling/startup/src/budget.ts --base <commit>  # against a named commit; CI passes the PR's base
//   bun tooling/startup/src/budget.ts --base ""        # no base: measure, report, gate nothing
//
// The reference Worker (`tooling/startup`) composes every kit capability. This tree must already be built
// (`bun run build`), and the script refuses one that is not. The base commit is exported into a temporary
// directory, this tree's reference Worker is copied over it, so both sides measure the same Worker against
// their own packages, and the base is installed and built there and removed however the run ends. Any
// failure on the base side fails the gate: a base that cannot be measured is never a reason to pass. A pull
// request with no base is refused, so the gate cannot be skipped by an empty variable.
//
// Cloudflare refuses a version whose startup exceeds its CPU limit (code 10021). `wrangler check startup`
// reports the measuring machine's CPU, and runners differ by more than any budget in milliseconds could
// absorb, so the gate measures the base and this tree on the same machine, interleaved, with the same
// wrangler, and holds the change between them. It holds no absolute target.

import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How far this tree's median active startup CPU may be over the base's, as a fraction. One sample swings by
 * up to about 15% from its median on one machine, which is why each side is a median of three; two medians,
 * each within a few percent, leave a delta whose noise is well under 10%.
 */
export const STARTUP_REGRESSION_THRESHOLD = 0.15;

/** The base when none is named: main, as this checkout last fetched it. */
const DEFAULT_BASE = "origin/main";

/** How many rounds run. One sample is noisy; the median of three is not. */
export const RUNS = 3;

/** The reference Worker, relative to a checkout's root. */
export const REFERENCE = join("tooling", "startup");

/**
 * The check that the reference Worker starts at all, run with Node in its directory. `wrangler check startup`
 * reports a Worker whose startup threw as a fast one, so each side is started once before it is measured.
 */
export const STARTS = join("src", "starts.ts");

/** Where each run's profile goes: inside wrangler's own ignored state, never beside the source. */
const PROFILE = join(".wrangler", "tmp", "worker-startup.cpuprofile");

/** A file only a built tree has: `createEntrypoint`, which the reference Worker imports through `dist`. */
const BUILT_MARKER = join("packages", "core", "dist", "createEntrypoint.js");

/** What the copy of the reference Worker leaves behind: installed packages and wrangler's state. */
const NOT_COPIED = new Set(["node_modules", ".wrangler", ".turbo"]);

/** The active startup figure `wrangler check startup` prints, in milliseconds. */
export function activeStartupMs(output: string): number {
  const figure = /Active: (\d+(?:\.\d+)?) ms/.exec(output)?.[1];
  if (figure === undefined) throw new Error("wrangler check startup printed no active startup figure.");
  return Number(figure);
}

/** The middle of the runs. */
export function median(runs: readonly number[]): number {
  if (runs.length === 0) throw new Error("A median of no runs is not a measurement.");
  const sorted = [...runs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * The commit to compare against, from the arguments. None named is `origin/main`; an empty name is no base at
 * all, which is what CI passes on a manual or scheduled run, where there is no pull request base.
 */
export function baseRef(args: readonly string[]): string | undefined {
  const at = args.findIndex((arg) => arg === "--base" || arg.startsWith("--base="));
  if (at === -1) return DEFAULT_BASE;
  const arg = args[at] ?? "";
  const named = arg === "--base" ? (args[at + 1] ?? "") : arg.slice("--base=".length);
  if (named.startsWith("-")) throw new Error(`--base ${named} is not a commit.`);
  return named === "" ? undefined : named;
}

/** Whether this tree's figure is within the threshold over its base's, and the sentence that says so. */
export function startupVerdict(
  headMs: number,
  baseMs: number | undefined,
  threshold: number,
): { ok: boolean; message: string } {
  const measured = `Startup CPU ${headMs.toFixed(1)} ms`;
  if (baseMs === undefined) {
    return { ok: true, message: `${measured}. No base to compare against, so it is reported and not gated.` };
  }
  // A fraction rather than `baseMs * (1 + threshold)`, which rounds 200 × 1.15 to just under 230 and would
  // fail a change of exactly the threshold.
  const change = (headMs - baseMs) / baseMs;
  const sign = change < 0 ? "-" : "+";
  const against = `${measured} against ${baseMs.toFixed(1)} ms on the base, ${sign}${Math.abs(change * 100).toFixed(1)}%`;
  const allowed = `${Math.round(threshold * 100)}% allowed (limit ${(baseMs * (1 + threshold)).toFixed(1)} ms)`;
  return change <= threshold
    ? { ok: true, message: `${against}, within the ${allowed}.` }
    : { ok: false, message: `${against}, over the ${allowed}. Load the startup profile to see where it went.` };
}

/** The status of a run stopped by Ctrl-C: the shell's for SIGINT. */
export const INTERRUPTED = 130;

/** What to do when the base side fails, which a pull request's own code rarely causes. */
const REMEDY =
  "The base did not export, install or build. Main builds on every run, so this is a flake or a toolchain change here: re-run the job, or merge main into the branch and push.";

/** A command that exited non-zero, carrying the status the script exits with. */
export class CommandFailed extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A finished child's status as a shell reports it: its own code, or 128 plus the signal that killed it. */
export function exitStatus({ status, signal }: { status: number | null; signal: NodeJS.Signals | null }): number {
  if (status !== null) return status;
  if (signal !== null) return 128 + constants.signals[signal];
  return 1;
}

/** Everything the gate does to the world, so a test can run it without a repository. */
export interface GateIo {
  /** Runs a command and resolves to its output; rejects with `CommandFailed` when it exits non-zero. */
  run(command: string, args: readonly string[], cwd: string): Promise<string>;
  exists(path: string): boolean;
  /** Copies a directory tree, leaving out installed packages and tool state. */
  copyTree(from: string, to: string): void;
  /** A new, empty directory for the base. */
  makeTempDir(): string;
  remove(path: string): void;
  write(text: string): void;
  /**
   * Calls `listener` when the process receives SIGINT, until the returned function releases it, in place of
   * the default termination. The gate stops with 130 at the next command boundary.
   */
  onInterrupt(listener: () => void): () => void;
}

/** Where the gate runs: the repository root, its arguments, and the GitHub event that started it. */
export interface GateOptions {
  root: string;
  args: readonly string[];
  event: string | undefined;
}

/** Runs the gate and resolves to the status to exit with. */
export async function runGate(io: GateIo, { root, args, event }: GateOptions): Promise<number> {
  const head = join(root, REFERENCE);
  const wrangler = join(head, "node_modules", ".bin", "wrangler");
  const list = (runs: readonly number[]) => runs.map((ms) => `${ms.toFixed(1)} ms`).join(", ");

  let ref: string | undefined;
  try {
    ref = baseRef(args);
  } catch (error) {
    io.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!io.exists(join(root, BUILT_MARKER))) {
    io.write("This tree is not built. Run `bun run build` first.\n");
    return 1;
  }
  if (ref === undefined && event === "pull_request") {
    io.write("A pull request is always held to its base, and none was given. Pass --base <commit>.\n");
    return 1;
  }

  let signaled = false;
  const interrupted = () => new CommandFailed(INTERRUPTED, "Interrupted.");
  const release = io.onInterrupt(() => {
    signaled = true;
  });
  const run = async (command: string, commandArgs: readonly string[], cwd: string): Promise<string> => {
    if (signaled) throw interrupted();
    const output = await io.run(command, commandArgs, cwd);
    if (signaled) throw interrupted();
    return output;
  };
  const starts = async (dir: string): Promise<void> => {
    io.write(await run("node", [STARTS], dir));
  };
  const measure = async (dir: string): Promise<number> => {
    const output = await run(wrangler, ["check", "startup", "--outfile", PROFILE], dir);
    io.write(output);
    return activeStartupMs(output);
  };
  /** Rethrows a failure on the base side with the remedy, leaving an interrupt as it is. */
  const onBase = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      if (!(error instanceof CommandFailed) || error.status === INTERRUPTED) throw error;
      throw new CommandFailed(error.status, `${error.message}\n${REMEDY}`);
    }
  };

  try {
    await starts(head);
    if (ref === undefined) {
      const verdict = startupVerdict(await measure(head), undefined, STARTUP_REGRESSION_THRESHOLD);
      io.write(`\n::notice title=Startup CPU::${verdict.message}\n`);
      io.remove(join(head, PROFILE));
      return 0;
    }
    const baseRefName = ref;

    const sha = await onBase(async () => {
      // CI's checkout is shallow, so the pull request's base is not there until it is fetched.
      try {
        await run("git", ["rev-parse", "--verify", "--quiet", `${baseRefName}^{commit}`], root);
      } catch (error) {
        if (!(error instanceof CommandFailed) || error.status === INTERRUPTED) throw error;
        await run("git", ["fetch", "--no-tags", "--depth=1", "origin", baseRefName], root);
      }
      return (await run("git", ["rev-parse", `${baseRefName}^{commit}`], root)).trim();
    });
    const base = io.makeTempDir();
    const baseReference = join(base, REFERENCE);
    io.write(`Building the base, ${ref} (${sha}), in ${base}.\n`);
    try {
      await onBase(async () => {
        // Exported rather than checked out, so the base is a plain directory with no registration to undo.
        const archive = join(base, `${basename(base)}.tar`);
        await run("git", ["archive", "--format=tar", `--output=${archive}`, sha], root);
        await run("tar", ["-xf", archive, "-C", base], root);
        io.remove(archive);
        // This tree's reference Worker over the base's, so both sides measure the same composition.
        io.remove(baseReference);
        io.copyTree(head, baseReference);
        // Not frozen: the copied Worker may be a workspace the base's lockfile has never seen. No scripts: the
        // repository's own lifecycle scripts read git, and an exported tree has none.
        await run("bun", ["install", "--ignore-scripts"], base);
        await run("bun", ["run", "build"], base);
      });
      await starts(baseReference);

      const headRuns: number[] = [];
      const baseRuns: number[] = [];
      // Interleaved, and the order alternates by round, so a machine warming up or slowing down over the step
      // lands on both sides rather than on whichever went second.
      for (let round = 0; round < RUNS; round += 1) {
        if (round % 2 === 0) {
          baseRuns.push(await measure(baseReference));
          headRuns.push(await measure(head));
        } else {
          headRuns.push(await measure(head));
          baseRuns.push(await measure(baseReference));
        }
      }
      const verdict = startupVerdict(median(headRuns), median(baseRuns), STARTUP_REGRESSION_THRESHOLD);
      io.write(`\nThis tree: ${list(headRuns)}.\nBase (${ref}): ${list(baseRuns)}.\n${verdict.message}\n`);
      if (verdict.ok) io.remove(join(head, PROFILE));
      if (signaled) throw interrupted();
      return verdict.ok ? 0 : 1;
    } finally {
      io.remove(base);
    }
  } catch (error) {
    io.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof CommandFailed ? error.status : 1;
  } finally {
    release();
  }
}

/** Whether this file is what was executed, rather than imported. */
function runAsCommand(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** The command running now, so a SIGINT sent to this script alone reaches it too. */
let current: ChildProcess | undefined;

/** The real world: commands as child processes, files on disk, output on stdout. */
const processIo: GateIo = {
  run(command, args, cwd) {
    // Spawned, never run synchronously, so the event loop stays free to deliver a SIGINT mid-command.
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env: process.env });
      current = child;
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      child.on("error", (error) => {
        current = undefined;
        reject(new CommandFailed(1, `${command} did not start: ${error.message}`));
      });
      child.on("close", (status, signal) => {
        current = undefined;
        const code = exitStatus({ status, signal });
        if (code === 0) resolve(output);
        else reject(new CommandFailed(code, `${output}\n${command} ${args.join(" ")} failed in ${cwd}.`));
      });
    });
  },
  exists: (path) => existsSync(path),
  copyTree: (from, to) => {
    cpSync(from, to, { recursive: true, filter: (source) => !NOT_COPIED.has(basename(source)) });
  },
  makeTempDir: () => mkdtempSync(join(tmpdir(), "startup-base-")),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  write: (text) => {
    process.stdout.write(text);
  },
  onInterrupt(listener) {
    const handler = () => {
      listener();
      current?.kill("SIGINT");
    };
    process.on("SIGINT", handler);
    return () => {
      process.off("SIGINT", handler);
    };
  },
};

if (runAsCommand()) {
  // GitHub Actions sets this on every run; it is undefined locally.
  const { GITHUB_EVENT_NAME: event } = process.env;
  process.exit(
    await runGate(processIo, { root: join(import.meta.dirname, "..", "..", ".."), args: process.argv.slice(2), event }),
  );
}
