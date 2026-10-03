// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dim, workerColor } from "../terminal/style";
import type { DevLogEntry } from "./devLogRead";
import type { DevLogRecord } from "./devLogRecord";
import { isOutputRecord } from "./devLogRecord";

/**
 * **Rendering a session back the way it was read live** — `[name] text`, one color per worker (#671).
 *
 * The prefix and the color are the whole reason the old single file was readable at all, so the reader
 * reproduces both rather than inventing a second rendering of the same session. What it cannot reproduce
 * is `workerColor`'s *index*: the live session keys color on a worker's position in the started set,
 * which is not in the file. So it is recovered from the data instead — the order the workers were first
 * `spawned` in, across the files being read, which is the order `startWorker` is called in.
 *
 * **One stable color per worker, not "exactly the colors the session had".** A reader asked for a subset
 * sees that subset's own order, so `--app web` alone paints `web` with the first color rather than its
 * third. That is the honest promise: the color distinguishes the workers in front of you.
 */

/** The workers these records cover, in the order their colors are assigned. */
export function devLogWorkerOrder(entries: readonly DevLogEntry[], named: readonly string[]): string[] {
  const firstSpawn = new Map<string, number>();
  const seen: string[] = [];
  for (const { worker, record } of entries) {
    if (!seen.includes(worker)) seen.push(worker);
    if (isOutputRecord(record) || record.event !== "spawned") continue;
    const at = Date.parse(record.ts);
    if (Number.isNaN(at) || firstSpawn.has(worker)) continue;
    firstSpawn.set(worker, at);
  }
  // Named first so a worker whose file holds no `spawned` at all still has a place, then the spawn
  // order, which is what the live session's palette was keyed on.
  const order = [...new Set([...named, ...seen])];
  // **The tie-break reads a rank taken before the sort, not the array being sorted.** `sort` reorders in
  // place, so a comparator calling `order.indexOf` would be asking a half-sorted array where a worker
  // started — a stable named-order tie-break that is not actually stable.
  const namedRank = new Map(order.map((worker, index) => [worker, index]));
  const rank = (worker: string) => namedRank.get(worker) ?? 0;
  return [...order].sort((left, right) => {
    const a = firstSpawn.get(left);
    const b = firstSpawn.get(right);
    if (a !== undefined && b !== undefined) return a - b || rank(left) - rank(right);
    if (a !== undefined) return -1;
    if (b !== undefined) return 1;
    return rank(left) - rank(right);
  });
}

/** Each worker's paint function, keyed the way the live session's was. */
export function devLogPalette(order: readonly string[]): Map<string, (text: string) => string> {
  return new Map(order.map((worker, index) => [worker, workerColor(index)]));
}

/** A lifecycle record as the sentence a person reads. Output records are their own text. */
export function devLogText(record: DevLogRecord): string {
  if (isOutputRecord(record)) return record.text;
  if (record.event === "spawned") return `spawned on port ${record.port}.`;
  if (record.event === "ready") return "ready.";
  return record.code === null ? "exited (signaled)." : `exited (${record.code}).`;
}

/** One record as one rendered line: `[name] text`, colorized, optionally stamped with its instant. */
export function renderDevLogLine(args: {
  entry: DevLogEntry;
  paint: (text: string) => string;
  timestamps: boolean;
}): string {
  const { entry, paint, timestamps } = args;
  const stamp = timestamps ? `${dim(entry.record.ts)} ` : "";
  return `${stamp}${paint(`[${entry.worker}]`)} ${devLogText(entry.record)}`;
}

/** Every record as the lines they render to, in the order given. */
export function renderDevLog(args: {
  entries: readonly DevLogEntry[];
  named: readonly string[];
  timestamps: boolean;
}): string[] {
  const palette = devLogPalette(devLogWorkerOrder(args.entries, args.named));
  return args.entries.map((entry) =>
    renderDevLogLine({
      entry,
      paint: palette.get(entry.worker) ?? ((text) => text),
      timestamps: args.timestamps,
    }),
  );
}
