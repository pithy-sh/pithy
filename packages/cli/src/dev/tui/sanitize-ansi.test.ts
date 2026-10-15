// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { sanitizeAnsi, visibleText } from "./sanitize-ansi";

/**
 * **The sanitizer the resize rebuild runs each restated line through.**
 *
 * The rebuild (`resize.ts`) restates committed lines straight to stdout, so a worker's line carries
 * its child's own bytes behind a prefix — everything `<Text>`'s sanitizer (`node_modules/ink`'s
 * `sanitize-ansi`, vendored here because ink exports neither it nor its tokenizer) would have
 * stripped on the normal path. The rules are ink 7.1.1's: keep SGR and OSC, strip the rest.
 */

describe("sanitizeAnsi — what a restated worker line may write", () => {
  test("a hostile worker line: colors and the OSC survive, the erases, cursor moves and reset do not", () => {
    const hostile = "\x1b[31mwrangler\x1b[0m exited\x1b[3J \x1b[2A\x1bc see \x1b]52;c;aGVsbG8=\x07you";
    const out = sanitizeAnsi(hostile);
    // SGR colors survive, byte for byte.
    expect(out).toContain("\x1b[31m");
    expect(out).toContain("\x1b[0m");
    // The OSC (clipboard/hyperlink family) survives with its payload.
    expect(out).toContain("\x1b]52;c;aGVsbG8=\x07");
    // Erase scrollback, cursor-up, and the full reset are stripped — they move or clear the screen.
    expect(out).not.toContain("\x1b[3J");
    expect(out).not.toContain("\x1b[2A");
    expect(out).not.toContain("\x1bc");
    // And the visible text is intact.
    expect(out).toContain("wrangler");
    expect(out).toContain("exited");
    expect(out).toContain("see");
    expect(out).toContain("you");
  });

  test("every family of screen-moving sequence is stripped", () => {
    expect(sanitizeAnsi("a\x1b[2Jb")).toBe("ab"); // clear screen
    expect(sanitizeAnsi("a\x1b[1Jb")).toBe("ab"); // clear above
    expect(sanitizeAnsi("a\x1b[Jb")).toBe("ab"); // clear below
    expect(sanitizeAnsi("a\x1b[2Kb")).toBe("ab"); // erase line
    expect(sanitizeAnsi("a\x1b[Hb")).toBe("ab"); // home
    expect(sanitizeAnsi("a\x1b[10;20Hb")).toBe("ab"); // position
    expect(sanitizeAnsi("a\x1b[?25lb")).toBe("ab"); // mode set (private '?')
    expect(sanitizeAnsi("a\x1bc")).toBe("a"); // full reset
    expect(sanitizeAnsi("a\x1bPq#0\x1b\\b")).toBe("ab"); // DCS (set color), ST-terminated
    expect(sanitizeAnsi("a\x1b(Bb")).toBe("ab"); // charset designation (ESC + intermediates)
    expect(sanitizeAnsi("a\u009B2Jb")).toBe("ab"); // CSI with the C1 introducer
    expect(sanitizeAnsi("a\u0090q#0\u009Cb")).toBe("ab"); // DCS via the C1 introducer, ST-terminated
    expect(sanitizeAnsi("a\u009D52;c;x\u009Cb")).toBe("a\u009D52;c;x\u009Cb"); // OSC via C1 is kept whole: introducer, payload, terminator
  });

  test("SGR shapes that are and are not color", () => {
    expect(sanitizeAnsi("a\x1b[1;32;40mb")).toBe("a\x1b[1;32;40mb"); // plain SGR kept
    expect(sanitizeAnsi("a\x1b[38:2:1:2:3mb")).toBe("a\x1b[38:2:1:2:3mb"); // colon form (ink's regex) kept
    expect(sanitizeAnsi("a\x1b[m")).toBe("a\x1b[m"); // empty parameters (reset) kept
    expect(sanitizeAnsi("a\x1b[1m\x1b[9mb")).toBe("a\x1b[1m\x1b[9mb"); // bright colors kept
    expect(sanitizeAnsi("a\x1b[1m;mb")).toBe("a\x1b[1m;mb"); // stray ';m' text is just text… ';m' has no ESC
  });

  test("plain text passes through untouched, and a malformed tail is dropped as one unit", () => {
    expect(sanitizeAnsi("no escapes here")).toBe("no escapes here");
    // An unterminated CSI at the end is malformed: ink drops the remainder, so a half-sequence
    // cannot leak a control byte into the restatement.
    expect(sanitizeAnsi("tail\x1b[3")).toBe("tail");
    expect(sanitizeAnsi("tail\x1b")).toBe("tail");
  });

  test("visibleText keeps only what occupies cells", () => {
    expect(visibleText("\x1b[31mred\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07")).toBe("red link");
    expect(visibleText("plain")).toBe("plain");
  });
});
