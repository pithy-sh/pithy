// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { currentBranch, defaultGit } from "../feature/worktree";
import { loadProject, requireProjectName } from "../project/config";
import { formatJsonStreamLine, formatList, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";
import { devLogDir } from "./devLogPath";
import type { DevLogEntry, DevLogListing } from "./devLogRead";
import { followDevLogs, listDevLogs, parseSince, readDevLogs } from "./devLogRead";
import { devLogPalette, devLogWorkerOrder, renderDevLog, renderDevLogLine } from "./devLogRender";

/**
 * `pithy dev logs` — **read a dev session back, filtered** (#671).
 *
 * `pithy dev logs`, not `pithy logs`: `docs/CLI.md` §10 reserves that name for tailing *deployed* Workers
 * through the admin Worker, and that entry is untouched. Two sources with different shapes get two nouns;
 * a single command would carry flags that only mean something half the time.
 *
 * It reads `<config>/<project>/logs/dev.<branch>.<worker>.jsonl` and nothing else — no dev set is
 * resolved, no `apps/` directory is enumerated, no git worktree is consulted. That is deliberate: the
 * whole reason the file left the checkout is that `pithy feature destroy` used to take it, and a reader
 * that needed the worktree to resolve a name would have inherited the problem it exists to fix.
 */

/** How long between polls under `--follow`. Short enough to read as live, long enough to cost nothing. */
const FOLLOW_INTERVAL_MS = 250;

/** The default window: the last two hundred records, newest last. */
const DEFAULT_LINES = 200;

/** Everything the reader needs, every seam defaulted to its real implementation. */
export interface DevLogsOptions {
  projectDir: string;
  /** The workers to render. Empty means *list what is readable* and read no output out. */
  apps: readonly string[];
  lines: number;
  since?: Date;
  follow: boolean;
  timestamps: boolean;
  /** The branch to read, or `null` for whichever is checked out. */
  branch: string | null;
  json: boolean;
  /** Seam: the directory to read, resolved from the project name by default. */
  dir?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Seam: whether `--follow` keeps going. The command's latches on SIGINT; a test's counts down. */
  following?: () => boolean;
}

/** `-n` as the count it has to be: a non-negative integer, or a refusal naming the flag. */
export function parseLines(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LINES;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ValidationError({
      message: `${value} is not a line count.`,
      action: "Pass a whole number: pithy dev logs --app api -n 50.",
      issues: [{ path: ["--lines"], code: "invalid_value", message: "A non-negative whole number." }],
    });
  }
  return Number(trimmed);
}

/** One listing row as the two columns `formatList` lays out — worker, then the facts about its file. */
function listingRows(found: readonly DevLogListing[]): { name: string; description: string }[] {
  const branchWidth = Math.max(0, ...found.map((row) => row.branch.length));
  const lineWidth = Math.max(0, ...found.map((row) => String(row.lines).length));
  return found.map((row) => ({
    name: row.worker,
    description: dim(
      `${row.branch.padEnd(branchWidth)}  ${String(row.lines).padStart(lineWidth)} lines  ${formatBytes(row.bytes).padStart(8)}  ${row.lastWrite}`,
    ),
  }));
}

/** A file size a person reads. No rotation and no cap, so this column is how growth stays visible. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The reader, with the process left to the caller.
 *
 * **`--json` is one compact object per line, with or without `--follow`** — `pithy dev`'s standing
 * exception in `docs/CLI.md` §1.2, extended to its reader through the same `formatJsonStreamLine` the
 * session itself uses. A consumer's parse does not change with a flag it did not pass, which is the only
 * rule that holds for a surface that is a stream half the time.
 */
export async function runDevLogs(options: DevLogsOptions): Promise<void> {
  const stdout = options.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dir = options.dir ?? devLogDir(requireProjectName(await loadProject(options.projectDir)));
  const branch = options.branch ?? (await currentBranch(defaultGit, options.projectDir));

  // No `--app` is the question *what is readable*, and it is answered across every branch in the
  // directory — the listing is how a developer learns what else `--branch` would take. It opens no
  // worker's records: the counts come from a parse, and nothing is rendered.
  if (options.apps.length === 0) {
    const found = await listDevLogs(dir);
    if (options.json) {
      stdout(`${formatJsonStreamLine({ command: "dev", event: "logs", logs: found })}\n`);
      return;
    }
    if (found.length === 0) {
      stdout(`No session logs yet. Run pithy dev.\n${dim(`  ${dir}`)}\n`);
      return;
    }
    stdout(`${formatList(listingRows(found))}\n`);
    stdout(dim(`  ${dir}\n`));
    return;
  }

  const read = await readDevLogs({
    dir,
    branch,
    workers: options.apps,
    lines: options.lines,
    ...(options.since ? { since: options.since } : {}),
  });

  const emit = (entries: readonly DevLogEntry[]) => {
    if (options.json) {
      for (const entry of entries) stdout(`${formatJsonStreamLine(entry.record)}\n`);
      return;
    }
    for (const line of renderDevLog({ entries, named: options.apps, timestamps: options.timestamps })) {
      stdout(`${line}\n`);
    }
  };

  emit(read.entries);
  // **Once, as a count.** A truncated write or an interleaved one produces a run of malformed lines, and
  // a sentence each would bury the session the reader came for. Said to stderr, because it is about the
  // read rather than part of it.
  if (read.skipped > 0) {
    stderr(`${read.skipped} malformed line${read.skipped === 1 ? "" : "s"} skipped.\n`);
  }
  if (!options.follow) return;

  // The palette is fixed from the backlog, so a worker's color does not change as the tail goes on.
  const palette = devLogPalette(devLogWorkerOrder(read.entries, options.apps));
  // **The tail resumes from the backlog read's own bytes, never from a second `stat`.** Two measurements
  // leave a window between them, and everything a live session appends inside it is in neither half of
  // the stream — in the one mode whose whole purpose is to miss nothing. A `stat` would also count the
  // half-written last line the backlog correctly discarded, so the tail would join that record in the
  // middle and report the remainder as `1 malformed line skipped.` See {@link readDevLogs}.
  const tail = followDevLogs({
    dir,
    branch,
    workers: read.offsets,
    sinks: {
      record: (entry) => {
        if (options.json) {
          stdout(`${formatJsonStreamLine(entry.record)}\n`);
          return;
        }
        stdout(
          `${renderDevLogLine({ entry, paint: palette.get(entry.worker) ?? ((text) => text), timestamps: options.timestamps })}\n`,
        );
      },
      skipped: (count) => stderr(`${count} malformed line${count === 1 ? "" : "s"} skipped.\n`),
      // Named, because the records that follow belong to a different session: the next `pithy dev`
      // truncated the file this tail is on, and the reader would otherwise look like it had lost its place.
      restarted: (worker) => stderr(`${worker}: a new session took this log. Following it from the start.\n`),
    },
  });

  const following = options.following ?? followUntilInterrupted();
  while (following()) {
    await tail.poll();
    await sleep(FOLLOW_INTERVAL_MS);
  }
}

/**
 * Keep following until the operator stops it.
 *
 * Ctrl-C is what ends a tail, and there is nothing else it could be: there is no session-end record, and
 * `exited` is the first half of a restart rather than the end of anything.
 */
function followUntilInterrupted(): () => boolean {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => !stopped;
}

/**
 * Collect every `--app` from the raw argv, the way `pithy dev` does.
 *
 * citty keeps only the last occurrence of a repeated string flag, so a multi-worker read would otherwise
 * silently drop all but the last. Unlike `pithy dev`'s, a `--app` with no value here cannot spawn
 * anything — but it is still refused, because the permissive reading is *list everything*, which is not
 * what somebody who typed `--app` meant.
 */
export function collectLogAppFlags(rawArgs: readonly string[]): string[] {
  const found: string[] = [];
  let missingValue = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--app") {
      const value = rawArgs[i + 1];
      if (value === undefined || value.startsWith("-")) {
        missingValue = true;
        continue;
      }
      found.push(value);
      i++;
    } else if (arg?.startsWith("--app=")) {
      const value = arg.slice("--app=".length);
      if (value === "") missingValue = true;
      else found.push(value);
    }
  }
  if (missingValue) {
    throw new ValidationError({
      message: "--app needs a worker name.",
      action: "Run pithy dev logs to see every worker that has a log, then name one.",
    });
  }
  return found;
}

export default defineCommand({
  meta: { name: "logs", description: "Read a dev session back, by worker and by time" },
  args: {
    app: { type: "string", description: "Render this worker's session (repeatable). Omitted, lists what is readable" },
    lines: { type: "string", alias: "n", description: `How many records to render. Default ${DEFAULT_LINES}` },
    since: { type: "string", description: "Only records at or after this point — 30s, 5m, 2h, 1d, or an instant" },
    follow: { type: "boolean", default: false, description: "Keep reading as the session writes. Ctrl-C ends it" },
    timestamps: { type: "boolean", default: false, description: "Prefix each line with the record's instant" },
    branch: { type: "string", description: "Read another branch's logs. Default: the checked-out branch" },
    json: { type: "boolean", default: false, description: "Machine-readable output — one compact object per line" },
  },
  run: ({ args, rawArgs }) =>
    withErrorReporting(args.json, async () => {
      const now = new Date();
      await runDevLogs({
        projectDir: process.cwd(),
        apps: collectLogAppFlags(rawArgs),
        lines: parseLines(args.lines),
        ...(args.since ? { since: parseSince(args.since, now) } : {}),
        follow: args.follow,
        timestamps: args.timestamps,
        branch: args.branch ?? null,
        json: args.json,
      });
    }),
});
