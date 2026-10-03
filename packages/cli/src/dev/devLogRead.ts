// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { devLogBranch, devLogFileName, parseDevLogFileName } from "./devLogPath";
import type { DevLogRecord } from "./devLogRecord";
import { parseDevLogRecord } from "./devLogRecord";

/**
 * **Reading a session back** — the half `logs/dev.log` never had (#671).
 *
 * The file was the only record of a session and nothing read it: a developer who wanted the email host's
 * last two hundred lines had them interleaved with four other workers in terminal scrollback, or in a
 * file they had to `grep` by hand against a prefix format nothing documented. An agent driving a session
 * had the same problem and no `--json` to reach for.
 *
 * Three decisions are in here rather than in the command, because each of them is a fact about the file
 * rather than about the flags:
 *
 * - **A trailing partial line is tolerated.** A live session is mid-append, so the last line of a file
 *   may be half-written. That is not corruption and is never reported as any.
 * - **A malformed line in the middle is skipped, and counted once.** Reported as a number rather than
 *   per line: a truncated disk or an interleaved write produces a run of them, and a line each would
 *   bury the session the reader came for.
 * - **Several workers merge by `ts`.** The timestamp is the only ordering two files share.
 */

/** One readable file, as the listing reports it. */
export interface DevLogListing {
  /** The branch segment from the filename — the slug, which is what `--branch` takes. */
  branch: string;
  /** The worker segment from the filename — what `--app` takes. */
  worker: string;
  /** How many records parsed out of it. */
  lines: number;
  /** The file's size on disk, in bytes. No cap and no rotation, so this is how growth stays visible. */
  bytes: number;
  /** When it was last written, ISO-8601 — the mtime, so an empty file still has one. */
  lastWrite: string;
}

/** One record, and which worker's file it came from. */
export interface DevLogEntry {
  worker: string;
  record: DevLogRecord;
}

/** What a read returned, and how much of the file it could not read. */
export interface DevLogRead {
  entries: DevLogEntry[];
  /** Malformed lines skipped, across every file read. A trailing partial line is not one of them. */
  skipped: number;
  /**
   * Where each file's complete records ran out, in bytes — the byte after the last newline this read
   * consumed. **This is what `--follow` picks the stream up from**, and it comes out of the same bytes
   * the backlog was rendered from rather than from a second look at the file. See {@link readDevLogs}.
   */
  offsets: { worker: string; offset: number }[];
}

/** Split a file's text into complete lines, reporting whether the last one was still being written. */
function completeLines(text: string): { lines: string[]; partial: boolean } {
  if (text === "") return { lines: [], partial: false };
  const parts = text.split("\n");
  // A file that ends in a newline splits to a trailing `""`, which is the terminator and not a line. One
  // that does not is a session still appending, and its last element is half a record.
  const tail = parts.pop() ?? "";
  return { lines: parts, partial: tail !== "" };
}

/** Every record in one file, with the malformed lines counted and the partial tail ignored. */
export function parseDevLogText(text: string): { records: DevLogRecord[]; skipped: number } {
  const { lines } = completeLines(text);
  const records: DevLogRecord[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const record = parseDevLogRecord(line);
    if (record === null) skipped += 1;
    else records.push(record);
  }
  return { records, skipped };
}

/** Every session log in the directory, across every branch, newest write first within a branch. */
export async function listDevLogs(dir: string): Promise<DevLogListing[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const found: DevLogListing[] = [];
  for (const name of names.sort()) {
    const parsed = parseDevLogFileName(name);
    if (parsed === null) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) continue;
    const { records } = parseDevLogText(await readFile(path, "utf8").catch(() => ""));
    found.push({
      branch: parsed.branch,
      worker: parsed.worker,
      lines: records.length,
      bytes: info.size,
      lastWrite: info.mtime.toISOString(),
    });
  }
  return found;
}

/**
 * The records of one branch's named workers, merged by `ts` and cut to the last `lines` of them.
 *
 * **Bounded after the merge, never before.** Taking each file's last 200 and then merging would give a
 * two-worker read 400 records, and a quiet worker's whole session would crowd out the busy one's recent
 * minutes. The flag names how many lines the reader wants to see, which is a property of the merge.
 *
 * A named worker with no file is a {@link NotFoundError} naming the worker *and* the branch: the branch
 * is the half a developer gets wrong, because `--branch` defaults to whatever is checked out and the
 * whole point of the directory is that it outlives the worktree.
 *
 * **It reports where it stopped, so `--follow` has nothing to re-measure.** A tail seeded from a later
 * `stat` is wrong twice over: everything the live session appends between the two calls is in neither
 * half of the stream, and `stat().size` counts the half-written last line this read correctly discarded,
 * so the tail joins that record in the middle and reports the remainder as malformed. One read, one
 * offset, taken from the bytes themselves — then no record can fall between the backlog and the tail.
 */
export async function readDevLogs(args: {
  dir: string;
  branch: string | null | undefined;
  workers: readonly string[];
  lines: number;
  since?: Date;
}): Promise<DevLogRead> {
  const branch = devLogBranch(args.branch);
  const merged: { entry: DevLogEntry; at: number; seq: number }[] = [];
  const offsets: { worker: string; offset: number }[] = [];
  let skipped = 0;
  let seq = 0;

  for (const worker of args.workers) {
    const path = join(args.dir, devLogFileName(args.branch, worker));
    // Read as bytes, because the offset a tail resumes from is a byte count and the records are UTF-8:
    // a character index into the decoded text would put a multi-byte line out by its own width.
    const bytes = await readFile(path).catch(() => null);
    if (bytes === null) throw missingLog({ dir: args.dir, branch, worker });
    // The byte after the last newline — exactly what was consumed. No newline at all is offset 0, which
    // is a file holding nothing but a line still being written.
    offsets.push({ worker, offset: bytes.lastIndexOf(0x0a) + 1 });
    const read = parseDevLogText(bytes.toString("utf8"));
    skipped += read.skipped;
    for (const record of read.records) {
      const at = Date.parse(record.ts);
      if (args.since !== undefined && !(at >= args.since.getTime())) continue;
      merged.push({ entry: { worker, record }, at: Number.isNaN(at) ? 0 : at, seq: seq++ });
    }
  }

  // Stable: equal timestamps keep the order they were read in, which for one file is the order it was
  // written in. A session writes several records inside one millisecond routinely.
  merged.sort((left, right) => left.at - right.at || left.seq - right.seq);
  const kept = args.lines >= 0 ? merged.slice(Math.max(0, merged.length - args.lines)) : merged;
  // The offsets cover the whole file, not the window `-n` or `--since` cut it down to: a record the flag
  // dropped was dropped on purpose, and re-emitting it on the first poll is not what either flag meant.
  return { entries: kept.map(({ entry }) => entry), skipped, offsets };
}

/** The refusal for a worker or branch with nothing to read — both named, with the listing as the remedy. */
export function missingLog(args: { dir: string; branch: string; worker: string }): NotFoundError {
  return new NotFoundError({
    message: `No session log for ${args.worker} on ${args.branch}.`,
    action: "Run pithy dev logs to see every branch and worker that has one.",
    detail: `Looked for ${join(args.dir, devLogFileName(args.branch, args.worker))}.`,
  });
}

/**
 * `--since` as an instant: a duration back from now (`30s`, `5m`, `2h`, `1d`) or an absolute one.
 *
 * The duration form is what a developer reaches for and the absolute form is what a script does, so both
 * are taken and neither is guessed at: anything that is neither is refused naming both shapes.
 */
export function parseSince(value: string, now: Date): Date {
  const duration = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2] as "s" | "m" | "h" | "d";
    const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    return new Date(now.getTime() - amount * ms);
  }
  const absolute = Date.parse(value.trim());
  if (!Number.isNaN(absolute)) return new Date(absolute);
  throw new ValidationError({
    message: `${value} is not a time --since takes.`,
    action: "Pass a duration — 30s, 5m, 2h, 1d — or an absolute instant such as 2026-07-27T09:00:00Z.",
    issues: [{ path: ["--since"], code: "invalid_value", message: "A duration or an ISO-8601 instant." }],
  });
}

/** One followed file's place in the stream: how far it has been read, and what of a line is in hand. */
interface TailState {
  worker: string;
  path: string;
  offset: number;
  buffer: string;
  decoder: StringDecoder;
}

/** What a tail does with what it finds. */
export interface DevLogTailSinks {
  record: (entry: DevLogEntry) => void;
  /** A malformed line, once per poll that found any. */
  skipped?: (count: number) => void;
  /** The file was truncated under the tail — a new `pithy dev` took it. */
  restarted?: (worker: string) => void;
}

/** A tail over one branch's files, advanced one poll at a time so a test drives it without a clock. */
export interface DevLogTail {
  /** Read whatever has been appended since the last poll. Safe to call when nothing has. */
  poll: () => Promise<void>;
}

/**
 * Follow one branch's named workers from a given offset each.
 *
 * **Truncation is handled, not prevented.** A session opens each file with `flags: "w"`, so the next
 * `pithy dev` empties the file this is tailing. Refusing to follow unless a session is live is not
 * available: `.dev-state.json` lives *inside* the checkout, so liveness is a question the reader can
 * only answer for the branch it was run from — and `--branch` reads a branch whose worktree may be gone,
 * which is the whole point of the directory. So the tail watches for the size going backwards and
 * reseeks to 0, exactly as `tail -F` does, and Ctrl-C is what ends it.
 *
 * **Nothing exits on `exited`.** A restart is written as `exited` then `spawned`, so an `exited` record
 * is not a session ending — a tail that stopped on one would die on every `r` keypress. There is no
 * session-end record, deliberately.
 *
 * **Poll order, not `ts` order.** A live tail emits each file's new records as it finds them, which is
 * what `tail -f` over several files does; the merge by `ts` is for a bounded read, where every record
 * already exists.
 */
export function followDevLogs(args: {
  dir: string;
  branch: string | null | undefined;
  workers: readonly { worker: string; offset: number }[];
  sinks: DevLogTailSinks;
}): DevLogTail {
  const states: TailState[] = args.workers.map(({ worker, offset }) => ({
    worker,
    path: join(args.dir, devLogFileName(args.branch, worker)),
    offset,
    buffer: "",
    decoder: new StringDecoder("utf8"),
  }));

  const pollOne = async (state: TailState): Promise<number> => {
    const info = await stat(state.path).catch(() => null);
    if (info === null) return 0;
    if (info.size < state.offset) {
      state.offset = 0;
      state.buffer = "";
      state.decoder = new StringDecoder("utf8");
      args.sinks.restarted?.(state.worker);
    }
    if (info.size === state.offset) return 0;
    const length = info.size - state.offset;
    const handle = await open(state.path, "r");
    let chunk: Buffer;
    let read = 0;
    try {
      chunk = Buffer.alloc(length);
      const result = await handle.read(chunk, 0, length, state.offset);
      read = result.bytesRead;
    } finally {
      await handle.close();
    }
    state.offset += read;
    // Decoded through a `StringDecoder` so a multi-byte character split across two polls is held rather
    // than turned into a replacement character — which would make a legal line unparseable.
    state.buffer += state.decoder.write(chunk.subarray(0, read));

    let skipped = 0;
    for (let nl = state.buffer.indexOf("\n"); nl !== -1; nl = state.buffer.indexOf("\n")) {
      const line = state.buffer.slice(0, nl);
      state.buffer = state.buffer.slice(nl + 1);
      if (line.trim() === "") continue;
      const record = parseDevLogRecord(line);
      if (record === null) skipped += 1;
      else args.sinks.record({ worker: state.worker, record });
    }
    return skipped;
  };

  return {
    poll: async () => {
      let skipped = 0;
      for (const state of states) skipped += await pollOne(state);
      if (skipped > 0) args.sinks.skipped?.(skipped);
    },
  };
}
