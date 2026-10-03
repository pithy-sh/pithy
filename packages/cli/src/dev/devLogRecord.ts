// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * **One line of a session log is one JSON object** (#671).
 *
 * The old file was `[name] text`, ANSI stripped, one file for every worker. Three things made it a poor
 * thing to read back and all three are answered by this shape: it had no timestamps, so `--since` had
 * nothing to bound against; it was one file, so filtering meant parsing a prefix; and the prefix was the
 * only record of which worker spoke.
 *
 * **`worker` is not a field. It is the filename.** `dev.<branch>.<worker>.jsonl` carries both, so a
 * reader that opened a file already knows, and a field would be the same fact on every line of it.
 *
 * **Two kinds of record and nothing else.** An *output* record is what a child said — `{ts, stream,
 * text}`, taken from the two `teeStream` call sites, which already differ only in which descriptor they
 * read. A *lifecycle* record is `{ts, event, …}` for that worker's own `spawned`, `ready` and `exited`.
 * The session-scoped events a dev session also raises — `roster`, `waiting`, `login`, `session-ready` —
 * are **never** written into a worker's file: none of them is about the worker whose file it is, and a
 * copy in each of five files is five copies of one fact.
 *
 * A restart is therefore readable in the file as `exited` followed by `spawned`.
 *
 * **An unknown *key* is tolerated and dropped, never refused.** A file written by a later `pithy` is read
 * by whatever is installed, and a reader that refused a key it had not heard of would report a healthy
 * session as corrupt. An unknown **`event`** is a different thing and is not tolerated: it fails the
 * union, so a later `pithy` that adds one lifecycle event has that line counted as malformed by this
 * reader. The tolerance is deliberately not stretched to cover it — a record whose kind this build has
 * never heard of has no shape to render and no column to put it in, and "1 malformed line skipped." is a
 * truer thing to say about it than silence.
 */

/** ISO-8601, which is what `now().toISOString()` writes and what `--since` compares against. */
const Timestamp = z.string().min(1).describe("ISO-8601 instant the record was written.");

/** A line one of the worker's streams produced, ANSI stripped, newline-normalized, one line per record. */
export const DevLogOutput = z.object({
  ts: Timestamp,
  stream: z.enum(["stdout", "stderr"]).describe("Which descriptor the child wrote it on."),
  text: z.string().describe("The line itself — ANSI stripped, with no `[name]` prefix: the file is the name."),
});
export type DevLogOutput = z.output<typeof DevLogOutput>;

/** That worker's child was spawned on its pinned port. A second one for the same file is a restart. */
export const DevLogSpawned = z.object({
  ts: Timestamp,
  event: z.literal("spawned"),
  port: z.number().int().describe("The port it was pinned to in `.dev.config.json`, verified free before it started."),
});

/** That worker matched its `dev.readySignal`. */
export const DevLogReady = z.object({ ts: Timestamp, event: z.literal("ready") });

/** That worker's child exited. `null` is the code a signaled child — and a failed spawn — reports. */
export const DevLogExited = z.object({
  ts: Timestamp,
  event: z.literal("exited"),
  code: z.number().int().nullable().describe("The exit status, or null for a signaled child or a spawn that failed."),
});

/** One record of one worker's session log. */
export const DevLogRecord = z.union([DevLogOutput, DevLogSpawned, DevLogReady, DevLogExited]);
export type DevLogRecord = z.output<typeof DevLogRecord>;

/** Whether this record is a line the child wrote, rather than one of its lifecycle events. */
export function isOutputRecord(record: DevLogRecord): record is DevLogOutput {
  return "stream" in record;
}

/** One record as the one line it is written as — compact, newline-terminated by the writer. */
export function formatDevLogRecord(record: DevLogRecord): string {
  return JSON.stringify(record);
}

/**
 * One line back into a record, or `null` when it is not one.
 *
 * `null` covers both the trailing partial line a live session is mid-way through appending and a line
 * that is genuinely malformed. The reader tells them apart by position, not by this: only the last line
 * of a file can be partial, and only a malformed line in the middle is worth counting.
 */
export function parseDevLogRecord(line: string): DevLogRecord | null {
  if (line.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = DevLogRecord.safeParse(value);
  return parsed.success ? parsed.data : null;
}
