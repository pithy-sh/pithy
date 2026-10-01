// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ErrorPayload } from "@pithy-sh/core/src/error/payload";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { operatorError, renderTerminal } from "@pithy-sh/core/src/error/terminal";
import { encodeJson, plainPaint, stylePaint } from "./jsonEncode";
import type { JsonStream } from "./jsonMode";
import { commandProgress, narrate } from "./progress";
import { red, saffron } from "./style";

/** Completion, brand voice: `Done.` with the saffron period (docs/CLI.md §3.2). */
export function formatDone(): string {
  return `Done${saffron(".")}`;
}

/**
 * How each stream's `--json` output is written. Compact and unpainted until `bin.ts` says otherwise.
 *
 * **Latched, because the alternative is a parameter threaded through every call site.** `style.ts`
 * latches color at import for the same reason; this needs an explicit setter rather than an import-time
 * decision because the flags it reads are argv, and argv is not available when this module is evaluated.
 *
 * **Two of them, because there are two readers.** `pithy doctor --json > out.json` at a terminal writes
 * the parseable line to the file and the readable one to the screen, and neither reader has to give way.
 * The paint decision rides along per stream for a sharper reason than the shape does: an indent in a
 * captured document still parses, an escape sequence does not (`jsonMode.ts`).
 *
 * Unlatched is compact and unpainted both ways: a test importing this module, and anything that reaches
 * a formatter without going through the bin, gets exactly the bytes it always got.
 */
let streams: { stdout: JsonStream; stderr: JsonStream } = {
  stdout: { mode: "compact", color: false },
  stderr: { mode: "compact", color: false },
};

/** Latch the resolved per-stream format. `bin.ts` calls this once, before any command runs. */
export function latchJsonFormat(resolved: { stdout: JsonStream; stderr: JsonStream }): void {
  streams = resolved;
}

/** One stream's encoder options — the shape it was latched with, and the paint that goes with it. */
function encodingFor(stream: JsonStream): { pretty: boolean; paint: typeof stylePaint } {
  return { pretty: stream.mode === "pretty", paint: stream.color ? stylePaint : plainPaint };
}

/** One machine-readable line — every command's `--json` output shape, indented when a person reads it. */
export function formatJsonLine(payload: Record<string, unknown>): string {
  return encodeJson(payload, encodingFor(streams.stdout));
}

/**
 * One line of a **JSON stream** — compact, always, whatever this run was latched with.
 *
 * `pithy dev --json` is the kit's one streaming surface: `docs/commands/dev.md` §`--json` promises one
 * object per line for the life of a session, because a session never ends and a consumer can only read
 * it line by line. Indenting those objects hands that consumer `{` as its first line and breaks every
 * line after it — at a terminal, and under exactly the PTY-allocating agent harness `jsonMode.ts` exists
 * to accommodate.
 *
 * **So the framing wins over the reader, and the call site says which it is.** A document can be shaped
 * for whoever is reading it because nothing is parsing it incrementally; a stream cannot. Deciding by
 * command name in `bin.ts` would have put that fact somewhere no reader of `orchestrator.ts` would look.
 */
export function formatJsonStreamLine(payload: Record<string, unknown>): string {
  return encodeJson(payload, { pretty: false, paint: plainPaint });
}

/**
 * A two-column name/description list, whitespace-aligned — the multi-row output
 * shape from docs/CLI.md §3.5 (no borders; the whitespace is the layout). Names
 * pad to the longest, then two spaces, then the description. Empty in → empty out.
 */
export function formatList(rows: { name: string; description: string }[]): string {
  const width = Math.max(0, ...rows.map((row) => row.name.length));
  return rows.map((row) => `${row.name.padEnd(width)}  ${row.description}`).join("\n");
}

/**
 * Problem line (red), then the action line plain (docs/CLI.md §3.3).
 *
 * The split is on the first newline because `renderTerminal` adds exactly one, between the message and
 * the action — a `message` is a single line, kit-wide, for the reasons stated there. So this reds the
 * whole message and nothing else, which is what it has always done; the newline is a field separator
 * being read as one, not a heuristic about where a sentence ends.
 */
export function formatError(payload: ErrorPayload): string {
  const rendered = renderTerminal(payload);
  const newline = rendered.indexOf("\n");
  if (newline === -1) return red(rendered);
  return red(rendered.slice(0, newline)) + rendered.slice(newline);
}

/**
 * The `--json` error line: `{ error: <operator payload> }` — the public fields plus
 * the `action` line, which is what {@link formatError} prints two lines above.
 *
 * Not the HTTP encoder, and that is the point. Both surfaces drop `detail`, but they
 * drop it for different people: a browser is a caller, and whoever ran the command is
 * the operator the remedy was written for. Reusing `HttpError.encode` here would have
 * classified `action` by the encoder that happened to be shared rather than by who reads
 * the line — and taken the fix out of a scripted `pithy` run for no gain anywhere.
 */
export function formatErrorJson(payload: ErrorPayload): string {
  // `stderr`, not `stdout`: this line is written to stderr, so it is stderr's reader it answers to.
  return encodeJson({ error: operatorError(payload) }, encodingFor(streams.stderr));
}

/**
 * Run a command body; on `PithyError`, report it to stderr and exit 1 — as the
 * `{ error: … }` JSON line when `json` is set, otherwise the problem/action
 * lines. Anything else is a CLI bug and keeps its stack trace.
 *
 * **And it opens the run's narrated span (#578).** Every command body goes through here and every
 * command body already hands over the one thing the narration gate consults, so this is where a long
 * command inherits the ability to say where it got to — rather than deciding for itself, which is how
 * `pithy deploy` came to print nothing at all for minutes after `pithy provision` had solved this once
 * already. A producer raises a step; the span installed here decides who hears it, and `--json` installs
 * silence so a machine still reads exactly one line.
 */
export async function withErrorReporting(json: boolean, work: () => Promise<void>): Promise<void> {
  try {
    await narrate(commandProgress({ json }), work);
  } catch (error) {
    if (!(error instanceof PithyError)) throw error;
    process.stderr.write(`${json ? formatErrorJson(error.payload) : formatError(error.payload)}\n`);
    process.exit(1);
  }
}
