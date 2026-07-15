import { createLogger, type Logger } from "./logger";
import type { LogLevel, LogRecord } from "./record";
import { serializeRecord } from "./record";

/**
 * Mode 1 — local diagnostics. One unified diagnostic layer for the `pithy` CLI process and a Worker
 * running under `pithy dev` / `wrangler dev`. Human-readable and (optionally) colorized for a person at
 * a terminal, or a `--json` structured line stream for agents and CI. This is *diagnostic logging only*
 * — interactive CLI UX (prompts, spinners, `PithyError` rendering) stays on the CLI's `style.ts`.
 */

/**
 * Level-keyed color functions the local adapter paints with. Injected, not hard-coded: core stays free
 * of ANSI, and the CLI passes its `style.ts` seam so all CLI color still flows through one place. Every
 * entry is optional; a missing one renders plain.
 */
export interface LocalPalette {
  debug?: (text: string) => string;
  info?: (text: string) => string;
  warn?: (text: string) => string;
  error?: (text: string) => string;
  /** Dimmed secondary text — the namespace, fields, and error detail. */
  dim?: (text: string) => string;
}

/** Options for {@link createLocalLogger}. */
export interface LocalLoggerOptions {
  /** The threshold. Defaults to `debug` — local diagnostics are verbose by default. */
  level?: LogLevel;
  /** Emit each record as a `JSON.stringify` line instead of the human format — the agent/CI stream. */
  json?: boolean;
  /** Where a formatted line goes. Defaults to `console.error` (stderr under Node), so diagnostics never pollute a command's stdout. */
  write?: (line: string) => void;
  /** Optional color functions (the CLI injects its `style.ts` seam). Omitted → plain text. */
  palette?: LocalPalette;
  /** The clock, injectable for tests. */
  now?: () => number;
}

/** Render one field value: strings verbatim, everything else as compact JSON — never throwing on a cycle/BigInt. */
function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** `key=value key=value` for the record's fields, in insertion order. */
function renderFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(" ");
}

/** Format one record for a terminal: `LEVEL (name) msg key=val … code detail`, colorized when a palette is set. */
function renderHuman(record: LogRecord, palette?: LocalPalette): string {
  const paint = palette?.[record.level] ?? ((text: string) => text);
  const dim = palette?.dim ?? ((text: string) => text);
  const parts = [paint(record.level.toUpperCase())];
  if (record.name) parts.push(dim(`(${record.name})`));
  parts.push(record.msg);
  if (record.fields) parts.push(dim(renderFields(record.fields)));
  if (record.error) {
    const detail = record.error.detail ? ` ${record.error.detail}` : "";
    parts.push(dim(`${record.error.code}${detail}`));
  }
  return parts.join(" ");
}

/**
 * Build a Mode 1 local logger. Same interface as every other Pithy logger; the sink either renders a
 * human line (default, colorized when a palette is injected) or a `--json` structured line. Writes to
 * `stderr` by default so a command's machine-readable stdout stays clean.
 */
export function createLocalLogger(options: LocalLoggerOptions = {}): Logger {
  // Default to console.error — stderr under Node (the CLI), the console elsewhere — so core stays free
  // of `process`. The CLI passes its own `write` when it wants raw `process.stderr`.
  const write = options.write ?? ((line: string) => console.error(line));
  return createLogger({
    level: options.level ?? "debug",
    now: options.now,
    sink: (record) => write(options.json ? serializeRecord(record) : renderHuman(record, options.palette)),
  });
}
