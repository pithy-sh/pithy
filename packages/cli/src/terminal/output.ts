// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ErrorPayload } from "@pithy-sh/core/src/error/payload";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { operatorError, renderTerminal } from "@pithy-sh/core/src/error/terminal";
import { red, saffron } from "./style";

/** Completion, brand voice: `Done.` with the saffron period (docs/CLI.md §3.2). */
export function formatDone(): string {
  return `Done${saffron(".")}`;
}

/** One machine-readable line — every command's `--json` output shape. */
export function formatJsonLine(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
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

/** Problem line (red), then action line (docs/CLI.md §3.3). */
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
  return JSON.stringify({ error: operatorError(payload) });
}

/**
 * Run a command body; on `PithyError`, report it to stderr and exit 1 — as the
 * `{ error: … }` JSON line when `json` is set, otherwise the problem/action
 * lines. Anything else is a CLI bug and keeps its stack trace.
 */
export async function withErrorReporting(json: boolean, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof PithyError)) throw error;
    process.stderr.write(`${json ? formatErrorJson(error.payload) : formatError(error.payload)}\n`);
    process.exit(1);
  }
}
