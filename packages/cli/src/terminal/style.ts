import pc from "picocolors";

/**
 * The color seam. Every colored character the CLI prints flows through here —
 * no raw ANSI anywhere else (docs/CLI.md §3.4). `picocolors` carries the
 * terminal-themed tiers (dim, basic-16); `saffron` is the one truecolor brand
 * accent, constant everywhere it renders.
 */

const SAFFRON_TRUECOLOR = "\x1b[38;2;212;160;23m"; // #D4A017
const SAFFRON_256 = "\x1b[38;5;178m";
const RESET = "\x1b[0m";

function supportsTruecolor(): boolean {
  const colorterm = process.env.COLORTERM;
  return colorterm === "truecolor" || colorterm === "24bit";
}

/**
 * Color is on only for an interactive terminal — never when the output is piped,
 * redirected, or captured. `NO_COLOR` forces it off, `FORCE_COLOR` forces it on
 * (the standard env overrides). We decide here rather than trusting
 * `pc.isColorSupported`: picocolors treats any `CI` env as color-capable, which
 * would bleed ANSI into our `--json` and `Done.` output the moment a CI runner
 * (or a piped consumer) reads it. Our output is parsed; a TTY is the real signal.
 */
function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

// Decided once at import, the way picocolors itself latches its detection.
const enabled = colorEnabled();

/** The brand mark in terminal form. Truecolor → 256-color 178 → no color. */
export function saffron(text: string): string {
  if (!enabled) return text;
  return (supportsTruecolor() ? SAFFRON_TRUECOLOR : SAFFRON_256) + text + RESET;
}

// The terminal-themed tiers, re-exported so all color still imports from the one
// seam. Built from our own `enabled` flag (not picocolors' detection) so they
// honor the same TTY-gated rule as `saffron`. This is the documented exception
// to the no-re-export rule; further tiers join as commands need them.
export const { red, yellow, cyan, dim } = pc.createColors(enabled);

// A stable, TTY-gated palette for per-worker labels in `pithy dev`. Built from the one seam so no
// raw ANSI leaks. Cyan/red/yellow/dim are reserved for meaning elsewhere, so the palette leans on the
// remaining hues and their bright variants; it cycles when a project has more workers than colors.
const palette = pc.createColors(enabled);
const WORKER_PALETTE: readonly ((text: string) => string)[] = [
  palette.green,
  palette.magenta,
  palette.blue,
  palette.cyan,
  palette.greenBright,
  palette.magentaBright,
  palette.blueBright,
  palette.cyanBright,
];

/**
 * A stable color for one worker's log label, chosen by its discovery index and cycling the palette.
 * `pithy dev` colorizes each worker's `[name]` prefix so interleaved output stays readable.
 */
export function workerColor(index: number): (text: string) => string {
  return WORKER_PALETTE[((index % WORKER_PALETTE.length) + WORKER_PALETTE.length) % WORKER_PALETTE.length] as (
    text: string,
  ) => string;
}

/**
 * Wrap `text` in an OSC-8 terminal hyperlink pointing at `url` — the id-as-link
 * rendering `pithy env` uses so a resource id opens its Cloudflare dashboard page.
 * Gated on the same latched `enabled` flag as every other symbol here: off when the
 * output is piped/redirected or `NO_COLOR` is set (where escape sequences would be
 * noise), so the caller falls back to printing the plain URL. `FORCE_COLOR` forces
 * it on. When off, the plain `text` is returned unchanged.
 */
export function link(url: string, text: string): string {
  if (!enabled) return safe(text);
  return `\x1b]8;;${safe(url)}\x1b\\${safe(text)}\x1b]8;;\x1b\\`;
}

/**
 * Strip C0/C1 control characters. Both halves of a hyperlink are values read out of a project's
 * `wrangler.jsonc` — a resource id and a URL built from it — so an embedded `ESC` could close this
 * sequence early and open its own, making the rendered link point somewhere other than what it displays.
 * Stripping them also stops a malformed id from corrupting the surrounding output.
 */
function safe(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/**
 * Whether OSC-8 hyperlinks render — the same TTY-gated `enabled` flag `link` uses.
 * Callers branch on it to choose the clickable id or the plain-URL fallback.
 */
export function supportsHyperlinks(): boolean {
  return enabled;
}
