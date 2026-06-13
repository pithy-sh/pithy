import { HttpError } from "@pithy-sh/core/src/error/http";
import type { ErrorPayload } from "@pithy-sh/core/src/error/payload";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { renderTerminal } from "@pithy-sh/core/src/error/terminal";
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
 * The `--json` error line: `{ error: <public payload> }`, the same shape and
 * encoder the HTTP surface emits (`HttpError.encode`). The encode side strips
 * `detail`, so internal context never reaches a `--json` consumer either.
 */
export function formatErrorJson(payload: ErrorPayload): string {
  return JSON.stringify({ error: HttpError.encode(payload) });
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
