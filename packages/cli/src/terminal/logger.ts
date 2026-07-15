import { createLocalLogger, type LocalPalette } from "@pithy-sh/core/src/logger/local";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { cyan, dim, red, yellow } from "./style";

/**
 * The CLI's Mode 1 diagnostic logger — the process-scoped side of the one unified local layer. It is
 * the runtime-agnostic core `createLocalLogger` configured for a terminal: the `style.ts` color seam,
 * output on `stderr` (a command's machine-readable stdout stays clean), and level gated by `--debug`.
 *
 * This is *diagnostic logging only*. Interactive CLI UX — @clack prompts and spinners, `Done.`,
 * `PithyError` `renderTerminal` — stays on `output.ts`/`style.ts` and never routes through here.
 */

/** The level-keyed palette, drawn from the one color seam so all CLI color still flows through `style.ts`. */
const palette: LocalPalette = { debug: dim, info: cyan, warn: yellow, error: red, dim };

/** Options for {@link createCliLogger}, wired from a command's `--debug` / `--json` args. */
export interface CliLoggerOptions {
  /** `--debug`: drop the threshold to `debug` (verbose diagnostics). Off → `warn`, so it stays quiet. */
  debug?: boolean;
  /** `--json`: emit a structured line stream (for agents/CI) instead of the colorized human format. */
  json?: boolean;
  /** Override the sink (tests capture it). Defaults to `stderr`. */
  write?: (line: string) => void;
}

/**
 * Build the CLI process logger. Quiet by default (`warn`), verbose under `--debug`. In `--json` mode it
 * emits the same structured records the Worker adapter does — one line each — so an agent driving the
 * CLI parses diagnostics the same way it parses a deployed Worker's logs.
 */
export function createCliLogger(options: CliLoggerOptions = {}): Logger {
  return createLocalLogger({
    level: options.debug ? "debug" : "warn",
    json: options.json,
    palette: options.json ? undefined : palette,
    write: options.write,
  });
}
