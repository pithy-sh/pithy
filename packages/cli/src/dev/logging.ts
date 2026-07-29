// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI ESC (\x1b) is required to strip color codes.
const ANSI_RX = /\x1b\[[0-9;]*m/g;

/** Strip ANSI color codes — the terminal keeps color, the `logs/dev.log` file stays plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RX, "");
}

/** Normalize CRLF and bare CR to LF — wrangler's progress spinner uses bare `\r`, one frame per line. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * A stateful splitter that buffers stream chunks and emits one complete line at a time (newlines
 * normalized first). `flush()` emits any trailing partial line when the stream ends. A stream yields
 * arbitrary chunk boundaries, so line assembly must span chunks — this is that assembler.
 */
export function createLineSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer = normalizeNewlines(buffer + chunk);
      for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
    flush() {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = "";
      }
    },
  };
}

/** What {@link teeStream} does with each assembled line. */
export interface TeeSinks {
  /** The prefixed, colorized line for the terminal (`[name] …`). */
  terminal: (line: string) => void;
  /** The prefixed, ANSI-stripped line for `logs/dev.log`. */
  log: (line: string) => void;
  /** The raw line, for ready-signal matching. */
  line: (line: string) => void;
}

/** A minimal readable stream — a real `child.stdout`, or a fake `EventEmitter`/`PassThrough` in tests. */
export interface DataStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
}

/**
 * Tee one child stream to three sinks: a colorized `[label] line` to the terminal, an ANSI-stripped
 * `[label] line` to the log file, and the raw line to ready-signal matching. CR-normalized and line-split
 * so wrangler's spinner and partial chunks each land as clean lines. Resolves when the stream ends.
 */
export function teeStream(args: {
  stream: DataStream;
  label: string;
  paint: (text: string) => string;
  sinks: TeeSinks;
}): Promise<void> {
  const { stream, label, paint, sinks } = args;
  const prefix = paint(`[${label}]`);
  const splitter = createLineSplitter((raw) => {
    sinks.terminal(`${prefix} ${raw}`);
    sinks.log(`[${label}] ${stripAnsi(raw)}`);
    sinks.line(raw);
  });
  return new Promise((resolve) => {
    stream.on("data", (chunk) => splitter.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    const done = () => {
      splitter.flush();
      resolve();
    };
    stream.on("end", done);
    stream.on("close", done);
  });
}
