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

/** The brand mark in terminal form. Truecolor → 256-color 178 → no color. */
export function saffron(text: string): string {
  if (process.env.NO_COLOR || !pc.isColorSupported) return text;
  return (supportsTruecolor() ? SAFFRON_TRUECOLOR : SAFFRON_256) + text + RESET;
}

// The terminal-themed tiers, re-exported so all color still imports from the
// one seam. This is the documented exception to the no-re-export rule; further
// tiers (dim, yellow) join as commands need them.
export const { red } = pc;
