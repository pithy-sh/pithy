// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { devMemberLabel } from "../devSet";
import type { SessionState, WorkerRow } from "./session";

/**
 * One roster row's text, column-padded and ready to paint.
 *
 * Plain strings, deliberately: §3.4 assigns a color tier per element and `terminal/style.ts` is the only
 * place color is applied, so the component paints these and this module decides nothing about color.
 * `spinner` is the one exception in spirit — it asks for the saffron glyph rather than carrying it,
 * because the frame belongs to whatever is ticking.
 */
export interface RosterCell {
  name: string;
  /** Empty on a narrow terminal, where it is the first thing dropped. */
  kind: string;
  port: string;
  status: string;
  /** Empty on a narrow terminal, and on a worker that has exited. */
  timing: string;
  /** Whether this row is mid-wait and should carry the saffron spinner glyph (§3.4). */
  spinner: boolean;
  /**
   * `on` or `off`, or empty on a narrow terminal — whether the next run starts this worker.
   *
   * Said even on a row that is `ready`, because those two facts genuinely disagree until the session
   * restarts: you pressed `a` a moment ago and the worker is still running.
   *
   * Words rather than a check and a cross: those need color to read quickly, and §3.4 licenses no tier
   * for them. `on`/`off` is unambiguous in the dim tier every other column already uses.
   */
  autostart: string;
}

/** The header, with the same padding as the rows beneath it. */
export interface RosterHeader {
  name: string;
  kind: string;
  port: string;
  status: string;
  timing: string;
  autostart: string;
}

/** Below this many columns the roster carries only what you cannot act without. */
const NARROW_COLUMNS = 60;

/** The floor for a duration: a clock that went backwards reports no time, never a negative one. */
const FLOOR = "0.0s";

/**
 * A duration in the shape `Done. (3.2s)` established.
 *
 * One decimal under ten seconds, because that is the range where a tenth distinguishes two runs; whole
 * seconds above it, because at fourteen seconds the tenth is noise that changes ten times a second.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return FLOOR;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** What a row says it is. An exit carries its code, because `exited` alone sends you to the log to find out. */
function statusText(row: WorkerRow): string {
  if (row.status !== "exited") return row.status;
  // A signaled child reports `null`, which is a different fact from exit code 0 and renders as the word.
  return `exited (${row.exitCode === null || row.exitCode === undefined ? "signal" : row.exitCode})`;
}

/**
 * What a row says about time.
 *
 * A ready worker reports **how long it took**, permanently — the `Done. (3.2s)` fact. A worker still
 * coming up reports elapsed, which is the number that is actually changing. A worker that has exited
 * reports nothing: its elapsed stopped meaning anything the moment it died.
 */
function timingText(row: WorkerRow, now: Date): string {
  // Neither a dead worker nor a parked one has an elapsed worth reading: one stopped mattering, the
  // other never started.
  if (row.status === "exited" || row.status === "skipped") return "";
  // A row the dev set seeded but nothing has spawned yet has no elapsed to report.
  if (!row.spawnedAt) return row.status === "ready" ? formatElapsed(row.readyMs ?? 0) : "";
  if (row.status === "ready") return formatElapsed(row.readyMs ?? 0);
  return formatElapsed(now.getTime() - row.spawnedAt.getTime());
}

/**
 * The roster, padded to its own widest member.
 *
 * Padded here rather than by a flexbox column so the alignment is a property a test can assert: a column
 * that lines up in one terminal and not another is the sort of thing nobody notices until a screenshot.
 */
export function rosterCells(
  state: SessionState,
  options: { now: Date; columns: number },
): { header: RosterHeader | null; rows: RosterCell[] } {
  if (state.workers.length === 0) return { header: null, rows: [] };
  const narrow = options.columns < NARROW_COLUMNS;

  const names = state.workers.map((w) => w.name);
  const kinds = narrow ? [] : state.workers.map((w) => devMemberLabel(w.kind));
  const ports = state.workers.map((w) => String(w.port));
  // The header is a cell like any other, so its own label is part of each column's width — otherwise
  // `autostart` would overhang the `on`/`off` beneath it and nothing would line up.
  const nameWidth = Math.max(...names.map((n) => n.length), "worker".length);
  const kindWidth = kinds.length === 0 ? 0 : Math.max(...kinds.map((k) => k.length), "kind".length);
  const portWidth = Math.max(...ports.map((p) => p.length), "port".length);
  /**
   * **Every column is padded, including the two that vary most.**
   *
   * `state` runs from `ready` to `exited (1)` and `time` from empty to `2m14s`, so leaving either
   * unpadded puts everything to its right at a different offset on every row — which is exactly how
   * `autostart` ended up not lining up with its own heading.
   */
  const statuses = state.workers.map(statusText);
  const timings = narrow ? [] : state.workers.map((row) => timingText(row, options.now));
  const statusWidth = Math.max(...statuses.map((s) => s.length), "state".length);
  const timingWidth = timings.length === 0 ? 0 : Math.max(...timings.map((s) => s.length), "time".length);

  const header: RosterHeader = {
    name: "worker".padEnd(nameWidth),
    kind: narrow ? "" : "kind".padEnd(kindWidth),
    port: "port".padStart(portWidth),
    status: "state".padEnd(statusWidth),
    timing: narrow ? "" : "time".padEnd(timingWidth),
    autostart: narrow ? "" : "autostart",
  };

  const rows = state.workers.map((row) => ({
    name: row.name.padEnd(nameWidth),
    kind: narrow ? "" : devMemberLabel(row.kind).padEnd(kindWidth),
    port: String(row.port).padStart(portWidth),
    status: statusText(row).padEnd(statusWidth),
    // Dropped before the kind would be, on a narrow terminal: a ticking number is the least of the three
    // facts, and it is the one that costs the most columns.
    timing: narrow ? "" : timingText(row, options.now).padEnd(timingWidth),
    // Only a worker mid-wait. §3.4 licenses saffron for "loading spinner glyphs during long operations"
    // and `terminal/progress.ts` reserves them for "a single indivisible wait" — a first bundle is one.
    spinner: row.status === "building",
    // Dropped on a narrow terminal with the kind and the timing, so the header and the rows stay in step.
    autostart: narrow ? "" : row.autostart === false ? "off" : "on",
  }));

  return { header, rows };
}

/** The leading two columns every footer line is indented by, which the key bar has to fit inside. */
const INDENT = 2;

/** One entry of the key bar, and whether it does anything on the row currently selected. */
export interface KeySegment {
  text: string;
  enabled: boolean;
}

/** A key the bar can advertise, with whether it applies to the selected row. */
export interface BarKey {
  key: string;
  label: string;
  enabled: boolean;
}

/**
 * The key bar, as segments the footer paints individually.
 *
 * **Enabled reads in the terminal's own foreground; disabled is dim.** Both are §3.4 tiers already — dim
 * is its "secondary against any background" — so saying this costs no new color. The bar used to be
 * uniformly dim, which left nowhere to say that `o` and `l` do nothing on a capability host: four of the
 * five rows in a real project are hosts, and a key that silently does nothing is worse than one that
 * says so.
 *
 * **Dimmed rather than hidden**, deliberately. A bar whose contents change as the marker moves has to be
 * re-read on every keystroke, and it hides the keymap from somebody still learning it. The width stays
 * put and the meaning still lands.
 */
export function keyBarSegments(keys: readonly BarKey[], columns: number): KeySegment[] {
  if (keys.length === 0) return [];
  const verbs = keys.map((k) => ({ text: `${k.key} ${k.label}`, enabled: k.enabled }));
  // Moving the marker is never unavailable, whatever the row it lands on cannot do.
  const select: KeySegment = { text: "↑↓ select", enabled: true };

  /**
   * **It gives up the least useful hint before it gives up all of them.**
   *
   * A single all-or-nothing threshold meant one more key, or one longer label, silently replaced the
   * whole bar with `? keys` at 80 columns — §9's fallback width, and a common terminal. So: the full bar,
   * then the bar without `↑↓ select` (arrows beside a visible marker are the one hint that explains
   * itself), and only then the single key that lists the rest.
   */
  for (const candidate of [[select, ...verbs], verbs]) {
    if (barWidth(candidate) <= columns) return candidate;
  }
  return [{ text: "? keys", enabled: true }];
}

/** How wide a bar renders, including the indent every footer line carries. */
function barWidth(segments: readonly KeySegment[]): number {
  return INDENT + segments.map((s) => s.text).join("   ").length;
}
