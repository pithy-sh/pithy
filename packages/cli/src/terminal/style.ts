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
