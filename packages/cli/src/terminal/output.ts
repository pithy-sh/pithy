// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AsyncLocalStorage } from "node:async_hooks";
import type { ErrorPayload } from "@pithy-sh/core/src/error/payload";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { operatorError, renderTerminal } from "@pithy-sh/core/src/error/terminal";
import { EXIT_CLASSES, exitClassOf, exitCodeOf, fixOf } from "./exitClass";
import { encodeJson, plainPaint, stylePaint } from "./jsonEncode";
import type { JsonStream } from "./jsonMode";
import { commandProgress, narrate, type Progress, progressRecord } from "./progress";
import { stampSchemaVersion } from "./schemaVersion";
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

/**
 * Set inside a `--json --events` run (#697): its stdout is a stream, so the document that closes it is a
 * stream line too. Ambient, so the command's own `formatJsonLine({ … })` site — the one the docs gate reads —
 * stays exactly as it is in every other run.
 */
const STREAMING = new AsyncLocalStorage<true>();

/**
 * One machine-readable line — every command's `--json` output shape, indented when a person reads it.
 *
 * Stamped with the running command's `schemaVersion` here, so no call site writes it (`schemaVersion.ts`).
 * Inside an `--events` run it is the stream's last record, so it is framed as one: compact and unpainted.
 */
export function formatJsonLine(payload: Record<string, unknown>): string {
  if (STREAMING.getStore()) return formatJsonStreamLine(payload);
  return encodeJson(stampSchemaVersion(payload), encodingFor(streams.stdout));
}

/**
 * One line of a **JSON stream** — compact, always, whatever this run was latched with.
 *
 * `pithy dev --json` streams: `docs/commands/dev.md` §`--json` promises one object per line for the life
 * of a session, because a session never ends and a consumer can only read it line by line. So does
 * `--json --events` on `deploy` and `provision` (#697), for the length of the run. Indenting those objects hands that consumer `{` as its first line and breaks every
 * line after it — at a terminal, and under exactly the PTY-allocating agent harness `jsonMode.ts` exists
 * to accommodate.
 *
 * **So the framing wins over the reader, and the call site says which it is.** A document can be shaped
 * for whoever is reading it because nothing is parsing it incrementally; a stream cannot. Deciding by
 * command name in `bin.ts` would have put that fact somewhere no reader of `orchestrator.ts` would look.
 */
export function formatJsonStreamLine(payload: Record<string, unknown>): string {
  return encodeJson(stampSchemaVersion(payload), { pretty: false, paint: plainPaint });
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
 *
 * **And it says what to do next (#697).** `exit` is the code the process ends with, `retryable` is
 * whether the same call can succeed unchanged, and `fix` — present only when the throw site knew the
 * cause — is the `pithy` command that rights it. It is written as handed: `fixOf` in `exitClass.ts` is the one
 * place a person's step is kept from carrying one, and the funnel below hands only what it answers.
 */
export function formatErrorJson(payload: ErrorPayload, fix?: string): string {
  const { exit, retryable } = EXIT_CLASSES[exitClassOf(payload)];
  const remedy = fix !== undefined ? { fix } : {};
  // `stderr`, not `stdout`: this line is written to stderr, so it is stderr's reader it answers to.
  return encodeJson({ error: { ...operatorError(payload), exit, retryable, ...remedy } }, encodingFor(streams.stderr));
}

/**
 * **Where a `--json --events` run narrates itself (#697): one record per step, on stdout, framed as a stream.**
 * `command` names the run on every record, as the closing document does. The record is
 * `progress.ts`'s; the framing is this module's, which is why the sink is built here.
 */
export function eventsProgress(command: string): Progress {
  return (event) => {
    process.stdout.write(`${formatJsonStreamLine(progressRecord(command, event))}\n`);
  };
}

/**
 * Run a command body; on `PithyError`, report it to stderr and exit with its class's code
 * (`exitClass.ts`) — as the `{ error: … }` JSON line when `json` is set, otherwise the
 * problem/action lines. Anything else is a CLI bug and keeps its stack trace.
 *
 * **And it opens the run's narrated span (#578).** Every command body goes through here and every
 * command body already hands over the one thing the narration gate consults, so this is where a long
 * command inherits the ability to say where it got to — rather than deciding for itself, which is how
 * `pithy deploy` came to print nothing at all for minutes after `pithy provision` had solved this once
 * already. A producer raises a step; the span installed here decides who hears it, and `--json` installs
 * silence so a machine still reads exactly one line.
 *
 * **`events` is the exception (#697)**: `deploy` and `provision` pass their name under `--json --events`,
 * and each step becomes a record ({@link eventsProgress}), closed by the document the run would have written.
 */
export async function withErrorReporting(
  json: boolean,
  work: () => Promise<void>,
  options: { events?: string } = {},
): Promise<void> {
  try {
    if (options.events === undefined) await narrate(commandProgress({ json }), work);
    else await STREAMING.run(true, () => narrate(eventsProgress(options.events as string), work));
  } catch (error) {
    if (!(error instanceof PithyError)) throw error;
    process.stderr.write(`${json ? formatErrorJson(error.payload, fixOf(error)) : formatError(error.payload)}\n`);
    process.exit(exitCodeOf(error.payload));
  }
}
