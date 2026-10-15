// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useApp, useStdout } from "ink";
import { useEffect } from "react";
import { sanitizeAnsi, visibleText } from "./sanitize-ansi";
import type { DevStore } from "./store";

/** Ink's cursor intent for the live region: its first row, its first column. */
export const TOP_LEFT = { x: 0, y: 0 };

/** Erase from the cursor to the end of the screen. Never `\x1b[2J`, which reaches above it. */
const ERASE_BELOW = "\x1b[J";

/**
 * Erase from the start of the viewport through the cursor — the anchor. Scrollback is out of reach,
 * which is the point: what this erases is visible history, and the rebuild restates it.
 */
const ERASE_ABOVE = "\x1b[1J";

/** Carriage return, home. A rebuild's restatement starts at row 1. */
const HOME = "\x1b[H";

/**
 * A drag's trailing edge: the window manager sends a resize every few pixels — the ConPTY test drags at
 * 25 ms steps, a human's mouse at a slower cadence — and the burst is over when events stop arriving.
 * A repaint *inside* a burst draws at a geometry the terminal has already left behind, and the rows the
 * reflow pushes past the viewport bottom on its way to the next size land in scrollback for good: the
 * staircase measured one stale rule per drag step, each 4 columns narrower than the last. The repaint
 * answers the final size and only that one. Erasing is cheap and moves nothing, so the burst erases on
 * every event and repaints on none.
 */
const RESIZE_SETTLE_MS = 150;

/**
 * Whether a resize burst is open right now. `app.tsx`'s stdout proxy consults it inside every `resize`
 * listener registered through that proxy, which is how Ink is muted *before* the event reaches it.
 */
let burstOpen = false;
export function isResizeBurstOpen(): boolean {
  return burstOpen;
}

/**
 * The rows `text` occupies on a terminal `columns` wide: every line of it is at least one row, and
 * every terminal-width of visible text beyond that is one more — a 150-column `wrangler` line is
 * three rows at 60, and a blank committed line is the one row its restatement's newline writes.
 * Escape sequences occupy no columns: the whole alphabet of them (CSI of every family, OSC, ESC
 * sequences, C1 controls), not just color, because a recorded worker line carries the child's own
 * bytes — erases and cursor movement included — behind a prefix. This is the terminal's own
 * arithmetic: the soft wrap the committed stream does as it is written, and what a clipped frame's
 * long line will do at a narrower width.
 */
export function rowsAt(text: string, columns: number): number {
  const lines = visibleText(text).split("\n");
  // A trailing newline opens no line of its own — `split` counts one, and an *empty* line is still
  // a line: restating it writes its newline, one row.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line) / columns)), 0);
}

/**
 * The rows a *frame* occupies: one per line, whatever the width. The frame is written with autowrap
 * off (`app.tsx`'s guard), so a too-wide line is clipped at the margin and never wraps; counting
 * its lines is the honest arithmetic, and wrapping it again at the new width would overcount a
 * full-width rule as two rows at 60 columns.
 */
export function frameRows(text: string): number {
  // `frame.last` starts as the empty string — no frame written yet, no rows on screen.
  if (text === "") return 0;
  const lines = visibleText(text).split("\n");
  // A trailing newline opens no line of its own; `split` counts one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/**
 * The display columns `plain` (text with its escape sequences already removed) occupies. What is
 * supported, precisely: C0/C1 controls take no cell; a tab advances to the next 8-column stop (at
 * least one column); combining marks, variation selectors, and the zero-width joiners of emoji
 * sequences take no cell; East Asian Wide/Fullwidth characters — CJK, Hangul, fullwidth forms —
 * and the pictographic planes count 2; everything else counts 1. A regional-indicator pair
 * therefore reads as four columns against a terminal's two: an approximation that always over-
 * counts, which is the safe direction for a restatement budget.
 */
const C1_CONTROL = /[\x7f-\x9f]/;
// Combining marks, variation selectors, joiners, and zero-width format characters — the code points
// a terminal lays on top of the cell before them (or on no cell at all). Ranges, not one class:
// every entry is a zero-width code-point span.
const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd], // Hebrew points (all combining)
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f], // zero-width space, joiners, directional marks
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f], // variation selectors — emoji presentation rides one of these
  [0xfe20, 0xfe2f],
  [0xe0100, 0xe01ef],
];
const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f000}-\u{1fbff}\u{20000}-\u{3fffd}]/u;

export function displayWidth(plain: string): number {
  let columns = 0;
  for (const character of plain) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint === 0x09) {
      columns += 8 - (columns % 8);
      continue;
    }
    if (codePoint < 0x20 || C1_CONTROL.test(character)) continue;
    if (ZERO_WIDTH_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)) continue;
    if (WIDE.test(character)) {
      columns += 2;
      continue;
    }
    columns += 1;
  }
  return columns;
}

/**
 * The committed lines a rebuild restates, newest tail first: from the end of `texts` backward, as
 * far as `viewportRows` minus the frame's rows minus one spare row allows, measured with
 * {@link rowsAt} at the new width. A pty reports `0` columns and rows before it has been sized —
 * `??` does not catch a `0`, and arithmetic on it returns `NaN`, which budgets the *whole* store
 * onto the screen; the fallbacks are the same §9 pair the rest of the TUI uses.
 */
export function restatementTail(texts: string[], frameText: string, columns: number, viewportRows: number): string[] {
  const cols = columns > 0 ? columns : FALLBACK_COLUMNS;
  const rows = viewportRows > 0 ? viewportRows : FALLBACK_ROWS;
  const budget = Math.max(0, rows - frameRows(frameText) - 1);
  let start = texts.length;
  let used = 0;
  while (start > 0) {
    const prev = texts[start - 1] as string;
    const next = rowsAt(prev, cols);
    if (used + next > budget) break;
    used += next;
    start -= 1;
  }
  return texts.slice(start);
}

/**
 * **Keep the cursor on the live region's first cell, erase from there on every resize, and repaint once
 * when the drag settles (#736).**
 *
 * Ink repaints the footer by moving the cursor up the number of rows it drew last time and erasing them.
 * A terminal that rewraps on resize — ConPTY does, and so does any terminal that reflows — moves those
 * rows, so the count goes stale and the erase lands on the wrong ones. Three repairs on #741 tried to
 * make the count right. The terminal never says what it is.
 *
 * It does say one thing, without being asked: where the cursor is. A terminal that reflows carries the
 * cursor with the cell under it. So the cursor rests on the live region's first cell — Ink's own
 * `useCursor`, at `TOP_LEFT` — and the region's start is wherever the terminal put the cursor. Ink's erase
 * then starts from that cell, goes down the frame and back up to it, and cannot reach above it: the
 * committed stream is out of reach of any count, stale or not.
 *
 * What a stale count can still miss is below the anchor, so every resize erases that too, from the anchor
 * to the end of the screen, with no count at all — an erase writes no rows and scrolls nothing, so one
 * per event keeps the viewport clean all the way through the drag. The repaint waits for the burst to
 * settle, because a repaint is the only writer that moves the screen: Ink's resize handler erases by its
 * stale count and the redraw's trailing newline pushes a row the reflow had no room for, and a drag is
 * thirty of those in a second — measured, one stale rule in scrollback per 4 columns of shrink. One
 * erase per event, one repaint per burst, the repaint at the final geometry.
 *
 * **Inside a burst, Ink's resize repaint is muted; everything else keeps painting.** The 80 ms spinner
 * tick and any line committed mid-drag still render full frames — the pty suite measures about
 * seventeen inside one drag window — and those paints are harmless: each writes the frame at the
 * anchored cursor and the per-event erase-below clears it again, so nothing accumulates. The muted
 * path is the one paint that *moves* rows: Ink's resize handler erases by the count it recorded at
 * the old geometry, and the redraw's trailing newline pushes a row the reflow had no room for. The
 * real-WT drag trace in the #736/#760 thread is the witness: through a 79→58 shrink its 56 cursor
 * reports march the anchor down row by row, 21, 22, 23, …, 30, as the rewrap pushes rows in above the
 * live region, while Ink's resize repaints keep drawing as if the frame sat at row 22. Each of those
 * mid-burst paints writes the frame's rows at the *terminal's* cursor — once the anchor reaches the
 * viewport's last row, the paint's trailing newline scrolls, and every scroll pushes one row (a rule,
 * a header, a stream line) into scrollback for good. The settled screen is clean; the user drags,
 * scrolls up, and sees the staircase and the duplicated stream lines the scrolls pushed. The emulator
 * suite never saw it because it reads the viewport, and the pushes land above it.
 *
 * Muting has to happen **before the event arrives**: Node's `EventEmitter.emit` iterates a copy of the
 * listener array, so a handler cannot unhook a sibling from inside the same emit. The seam is
 * subscription-time — `app.tsx`'s stdout proxy wraps every `resize` listener registered through it
 * (Ink's included), and the wrapper skips the real handler while {@link isResizeBurstOpen} says a burst
 * is open. The erase handler is prepended, so it opens the burst first in every emit, and the settle
 * closes it.
 *
 * **A burst of more than one event gets the viewport rebuilt at the settle, and the suite says why.**
 * Removing the rebuild entirely was tried for #760: two identical runs of `devTui.windows.test.ts`, one
 * green at its full-buffer counts, one leaving a wrapped tail — a rule fragment — in the buffer. A
 * frame whose rows at the *new* width overflow the viewport's last row pushes its own tail past the
 * count Ink recorded, and the anchored sweep walks down only as far as the count sees. So at the settle
 * of a drag: erase from the viewport's first row down to the anchor (`ESC[1J` — it stops at the cursor,
 * and the scrollback above the viewport is load-bearing history; on-screen shell output *above* the
 * session's first line is erased with the visible stream, which is the cost this shape accepts and
 * `docs/ACCEPTED-LIMITS.md` records), home, and restate the visible tail of the committed stream from
 * the store — **measured in rows at the new width**, budgeted so the restatement plus the footer fit
 * the viewport with a row to spare: a repaint that overflows is how a restated copy gets scrolled into
 * scrollback, duplicating what the rebuild exists to keep single. The frame's rows are its **lines** —
 * the last frame's own string (`frame.last` — `app.tsx`'s proxy records it), counted through
 * {@link frameRows}, because the frame is written with autowrap off and one of its lines is one row at
 * any width; re-wrapping it with {@link rowsAt} overcounts a full-width rule after a narrowing drag
 * and shrinks the budget by the frame's own height, losing the oldest visible lines. The committed
 * lines keep the {@link rowsAt} arithmetic, and every restated line runs through the vendored ink
 * sanitizer (`sanitize-ansi.ts`) before it is written: the store keeps raw text, and the rebuild's
 * write is where `<Text>`'s normal-path filter has its equivalent. Nothing is read by casting into
 * Ink's internals: `render()` returns `{ rerender, unmount, ... }` and has no frame height on it.
 * Then the anchored erase, and one repaint.
 * A burst of one resize event needs no rebuild — a single size change strands nothing above the
 * anchor's sweep, and the human's slow drag is exactly that.
 *
 * A settle that fires while a previous suspension is still in flight is **queued, not run**: Ink's
 * `beginSuspend` throws on a nested suspension, and the erase this settle already wrote would leave the
 * roster blank with nothing left to redraw it (the spinner has stopped by then). The queue replays the
 * trailing repaint the moment the flight lands, at the newest geometry — the `repainting` guard of the
 * #744 code, in the shape a burst needs.
 *
 * The terminal is never handed away for the length of a drag: `suspendTerminal` pauses stdin, and a
 * stdin that stops consuming is a stdin that stops learning sizes — ConPTY coalesces the resize records
 * it queued in the meantime, and the app settles for a geometry it was never told about (measured: a
 * 50-column settle delivering the app 76 and 52 and nothing between).
 */
export function useEraseOnResize(reanchor: () => void, store: DevStore, frame: { last: string }): void {
  const { stdout } = useStdout();
  const { suspendTerminal } = useApp();
  useEffect(() => {
    // Ink subscribes to `resize` only on an interactive terminal, and so does this. Ink's test is its own
    // and not `choose.ts`'s: a TTY, outside what `is-in-ci` calls CI.
    if (!stdout?.isTTY || inkSeesCi()) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    // Events since the last settle: one is a size change, two are a drag, and only drags strand rows.
    let burst = 0;
    // The suspension the last settle started, if it has not landed yet, and the settle queued behind it.
    let inFlight: Promise<void> | undefined;
    let queued = false;
    // Set in cleanup: a settle queued behind an in-flight suspension lands through that promise's
    // `.finally`, which outlives the effect, so the queue and its timers must learn to stop on their own.
    let disposed = false;

    const settleNow = () => {
      settle = undefined;
      if (disposed) return;
      // A settle behind an open suspension would make `beginSuspend` throw *after* the burst's
      // erases have cleared the roster — swallowed, and the roster stays blank. Queue it instead.
      if (inFlight) {
        queued = true;
        return;
      }
      // The burst's one repaint, at the final geometry. Close the burst first: the erase below must
      // not be steered by the very flag this path owns, and a `resize` event arriving mid-paint
      // re-opens the burst through `erase` (prepended, so it always wins the race inside an emit).
      burstOpen = false;
      const rebuild = burst > 1;
      burst = 0;
      // `suspendTerminal` erases Ink's last frame, and that erase owns the return to the frame's
      // bottom: `beginSuspend`'s `log.clear()` starts with ink's own return-to-bottom prefix — the
      // cursor is shown at the frame's first cell, and the prefix steps down to its last row before
      // the `eraseLines` walks back up. No step-down is written here; adding one lands the walk on
      // the wrong rows — #736's staircase symptom, reproduced on the path that needs no rebuild.
      inFlight = suspendTerminal(() => {
        if (rebuild) {
          // Clear the viewport from its first row down to the anchor — the visible stream and
          // everything the drag stranded in it — and restate the visible tail, oldest first, in rows
          // measured at the new width. The budget leaves the footer a viewport that fits: a
          // restatement plus a frame that overflow the last row scroll, and every scroll pushes a
          // restated copy into scrollback.
          stdout.write(ERASE_ABOVE);
          stdout.write(HOME);
          const tail = restatementTail(
            store.state().lines.map((line) => line.text),
            frame.last,
            stdout.columns,
            stdout.rows,
          );
          // Every restated line goes through the sanitizer ink's `<Text>` runs on the normal path:
          // a worker's line carries the child process's own bytes behind its prefix, and the store
          // keeps them raw for the logs. Sanitizing happens at this write, nowhere upstream.
          for (const text of tail) stdout.write(`${sanitizeAnsi(text)}\n`);
        }
        stdout.write(ERASE_BELOW);
        reanchor();
      })
        .catch(() => {
          // The screen is mid-erase; the queue below repaints, and a permanently unwritable stdout
          // surfaces through Ink's own exit path, not through a resize timer.
        })
        .finally(() => {
          inFlight = undefined;
          if (queued) {
            queued = false;
            schedule();
          }
        });
    };

    const schedule = () => {
      if (disposed) return;
      if (settle) clearTimeout(settle);
      settle = setTimeout(settleNow, RESIZE_SETTLE_MS);
    };

    const erase = () => {
      // First in every emit (prepended), so the flag is open before any wrapped listener runs.
      burst += 1;
      burstOpen = true;
      // Direct, and on every event: an erase writes no rows and scrolls nothing, the viewport stays
      // clean through the burst, and the terminal stays in Ink's hands so the resize records keep
      // flowing. Ink's resize paint is skipped by the subscription-time wrapper (see the docstring) —
      // a paint is the only thing that scrolls, and the burst's paint at the settle is the one above.
      stdout.write(ERASE_BELOW);
      schedule();
    };

    stdout.prependListener("resize", erase);
    return () => {
      disposed = true;
      stdout.off("resize", erase);
      if (settle) clearTimeout(settle);
      burstOpen = false;
    };
  }, [stdout, suspendTerminal, reanchor, store, frame]);
}

/** §9's fallbacks, for a stream that will not say its size. */
const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;

/**
 * Whether Ink believes it is running in CI, by the rule Ink uses (`is-in-ci`): `CI` or
 * `CONTINUOUS_INTEGRATION` present and neither `0` nor `false`. Ink then renders non-interactively —
 * no live frame, no `resize` listener — even on a TTY.
 */
function inkSeesCi(): boolean {
  return ["CI", "CONTINUOUS_INTEGRATION"].some(
    (key) => key in process.env && process.env[key] !== "0" && process.env[key] !== "false",
  );
}
