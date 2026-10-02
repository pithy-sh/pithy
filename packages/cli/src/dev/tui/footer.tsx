// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Box, Text } from "ink";
import { dim, red, saffron, workerColor, yellow } from "../../terminal/style";
import { type BarKey, keyBarSegments, rosterCells } from "./roster";
import type { SessionState } from "./session";

/**
 * The spinner's frames, and how fast it turns.
 *
 * Braille rather than ASCII because every terminal that can render this footer renders these, and they
 * animate in place without changing width — a frame that is two columns wide in one position and one in
 * another makes the whole row jitter.
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** One frame per 80ms — fast enough to read as motion, slow enough not to be the reason you look. */
export const SPINNER_INTERVAL_MS = 80;

/**
 * **A worker's status, on the tier §3.4 assigns it.** No new color vocabulary: `ready` is the terminal's
 * own foreground, because nothing earns emphasis for working; `waiting` is basic-16 yellow, the tier for
 * a warning; an exit is basic-16 red. Each of the three is the user's terminal deciding what that color
 * looks like, which is what makes the footer readable on a light theme.
 */
function paintStatus(status: string): string {
  if (status.startsWith("exited")) return red(status);
  if (status === "waiting") return yellow(status);
  return status;
}

/**
 * The live roster, pinned under an append-only stream.
 *
 * Pure in its props — including the spinner, whose frame is derived from `now` rather than from a
 * counter of its own, so a frame is reproducible in a test and the component has no clock to own.
 *
 * **Every line is `wrap="truncate"`, and truncation is the intent.** Ink's default wraps a `<Text>` wider
 * than its container onto a second line, which in a footer means the roster climbs a line mid-repaint and
 * the whole block jitters. A roster row that will not fit should be *cut*: `rosterCells` already sheds the
 * kind and the timing on a narrow terminal, so reaching the truncation at all means the names themselves
 * are wider than the window.
 *
 * The committed log stream above has the opposite requirement — byte-identical passthrough — and
 * `wrap` cannot deliver it in either direction: `truncate` keeps only the first terminal-width characters
 * of a 368-character line, and `wrap`/`hard` both split it. That is why the stream sizes a `<Box>` to each
 * line instead. Measured under a pty on #670.
 */
export function Footer(props: {
  state: SessionState;
  now: Date;
  columns: number;
  keys: readonly BarKey[];
  selected: number;
  /** The workers whose output is currently landing in the stream. */
  revealed?: readonly string[];
}): React.ReactElement | null {
  const { header, rows: cells } = rosterCells(props.state, { now: props.now, columns: props.columns });
  // An empty session is a session with nothing to say. A rule with no rows under it is furniture.
  if (cells.length === 0) return null;

  const rule = "─".repeat(Math.max(0, Math.min(props.columns, 72)));
  const frame = SPINNER_FRAMES[Math.floor(props.now.getTime() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length] ?? "";
  const segments = keyBarSegments(props.keys, props.columns);

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">{dim(rule)}</Text>
      {/* A header, because six columns of which two are numbers are not self-explaining — `8787` and
          `1.9s` read as the same kind of thing until something says which is which. Dim throughout:
          §3.4's tier for a section label, and it must never compete with the rows. */}
      {header === null ? null : (
        <Text wrap="truncate">
          {/* The same composition as a row, with the marker's two columns and the spinner's two spent
              as padding — so the header sits over the values it names rather than near them. */}
          {dim(
            `  ${header.name}${header.kind === "" ? "  " : `  ${header.kind}`}  ${header.port}   ` +
              `  ${header.status}${header.timing === "" ? "" : `  ${header.timing}`}` +
              `${header.autostart === "" ? "" : `  ${header.autostart}`}`,
          )}
        </Text>
      )}
      {cells.map((cell, index) => (
        <Text key={cell.name.trim()} wrap="truncate">
          {/* The marker is the selection, and it is two columns wide on every row so nothing shifts. */}
          {index === props.selected ? "▸ " : "  "}
          {/* **A revealed worker wears its own color, a hidden one is dim.** The same color
              `teeStream` paints its `[api]` prefix with, so the rows you can see the color of are
              exactly the rows whose output you can see — one fact, said once, costing no width. */}
          {(props.revealed ?? []).includes(cell.name.trim()) ? workerColor(index)(cell.name) : dim(cell.name)}
          {cell.kind === "" ? "  " : `  ${dim(cell.kind)}`}
          {`  ${dim(cell.port)}   `}
          {/* Saffron, and only here. §3.4 licenses the glyph; the two spaces keep the column aligned
              for every row that is not waiting on anything. */}
          {cell.spinner ? `${saffron(frame)} ` : "  "}
          {paintStatus(cell.status)}
          {cell.timing === "" ? "" : `  ${dim(cell.timing)}`}
          {/* Said on a running row too: `a` changes the *next* run, so `ready` and `off` are both true
              until this session ends, and the roster has no business hiding either. */}
          {cell.autostart === "" ? "" : `  ${dim(cell.autostart)}`}
        </Text>
      ))}
      <Text wrap="truncate">{dim(rule)}</Text>
      {/* **No dev-login line.** It said `Dev login: <email>`, then `Dev login: 29 identities`, and in
          both forms the only thing it added over the key bar was *something is seeded* — which the bar
          now says by `l login` being live rather than dim. A row of prose under a table that answers the
          question is a row of prose. The claim was never printed in any version of it (#667). */}
      {segments.length === 0 ? null : (
        <Text wrap="truncate">
          {`  ${segments.map((segment) => (segment.enabled ? segment.text : dim(segment.text))).join("   ")}`}
        </Text>
      )}
    </Box>
  );
}
