// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { type JsonMode, jsonStreams, resolveJsonMode } from "./jsonMode";

/**
 * The resolver is asked here and nowhere else, across the whole env × flag × isTTY matrix, because it is
 * the one thing in this feature that can be asked without a terminal. `process` never appears: every
 * input is a parameter, the way `notify.ts`'s `shouldNotify` takes `isTTY` rather than reading it.
 */
describe("resolveJsonMode", () => {
  describe("the ambient default — isTTY, when nothing overrides it", () => {
    test("a terminal reads it, so it is indented", () => {
      expect(resolveJsonMode({ isTTY: true })).toBe("pretty");
    });

    test("a pipe, a file or a capture reads it, so it is one line", () => {
      expect(resolveJsonMode({ isTTY: false })).toBe("compact");
    });

    test("an absent isTTY is not a terminal", () => {
      expect(resolveJsonMode({})).toBe("compact");
    });
  });

  describe("the flag — beats isTTY", () => {
    test("--pretty indents into a pipe", () => {
      expect(resolveJsonMode({ pretty: true, isTTY: false })).toBe("pretty");
    });

    test("--no-pretty keeps one line at a terminal", () => {
      expect(resolveJsonMode({ pretty: false, isTTY: true })).toBe("compact");
    });
  });

  describe("PITHY_JSON — beats both", () => {
    test("compact wins over --pretty at a terminal", () => {
      expect(resolveJsonMode({ env: "compact", pretty: true, isTTY: true })).toBe("compact");
    });

    test("pretty wins over --no-pretty in a pipe", () => {
      expect(resolveJsonMode({ env: "pretty", pretty: false, isTTY: false })).toBe("pretty");
    });

    /**
     * The case the variable exists for. A TTY is not a reliable "a person is reading this" signal — agent
     * harnesses, tmux-backed runners and some CI images allocate a PTY — and one variable fixes the whole
     * session rather than every invocation in it.
     */
    test("compact silences a PTY-allocating harness without touching its arguments", () => {
      expect(resolveJsonMode({ env: "compact", isTTY: true })).toBe("compact");
    });

    test("an unset variable defers to the flag and to isTTY", () => {
      expect(resolveJsonMode({ env: undefined, isTTY: true })).toBe("pretty");
    });

    /** `PITHY_JSON=` is how a shell spells "unset" by accident. It is not a value, so it is not refused. */
    test("an empty variable is unset, not a typo", () => {
      expect(resolveJsonMode({ env: "", isTTY: true })).toBe("pretty");
    });
  });

  /**
   * A typo'd `PITHY_JSON=prety` reverting to the ambient default is the same silent surprise this feature
   * exists to close, so it is refused instead — and refused as a `PithyError`, which is what makes it one
   * `{ "error": … }` line under `--json` rather than a thrown string.
   */
  describe("an unrecognized PITHY_JSON", () => {
    test("is refused, naming both accepted values and what it was given", () => {
      let thrown: unknown;
      try {
        resolveJsonMode({ env: "prety", isTTY: true });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PithyError);
      const { payload } = thrown as PithyError;
      expect(payload.code).toBe("validation/invalid_input");
      expect(payload.message).toContain("PITHY_JSON");
      expect(payload.message).toContain("prety");
      expect(payload.action).toContain("compact");
      expect(payload.action).toContain("pretty");
    });

    test("is refused whatever the flag and the terminal say", () => {
      expect(() => resolveJsonMode({ env: "PRETTY", pretty: false, isTTY: false })).toThrow(PithyError);
      expect(() => resolveJsonMode({ env: "1", pretty: true, isTTY: true })).toThrow(PithyError);
    });
  });

  /** The full matrix, stated as a table so a later edit has to move a row rather than reword a sentence. */
  test("the whole env × flag × isTTY matrix, first match wins", () => {
    const rows: [string | undefined, boolean | undefined, boolean, JsonMode][] = [
      [undefined, undefined, false, "compact"],
      [undefined, undefined, true, "pretty"],
      [undefined, false, false, "compact"],
      [undefined, false, true, "compact"],
      [undefined, true, false, "pretty"],
      [undefined, true, true, "pretty"],
      ["compact", undefined, false, "compact"],
      ["compact", undefined, true, "compact"],
      ["compact", false, false, "compact"],
      ["compact", false, true, "compact"],
      ["compact", true, false, "compact"],
      ["compact", true, true, "compact"],
      ["pretty", undefined, false, "pretty"],
      ["pretty", undefined, true, "pretty"],
      ["pretty", false, false, "pretty"],
      ["pretty", false, true, "pretty"],
      ["pretty", true, false, "pretty"],
      ["pretty", true, true, "pretty"],
    ];
    for (const [env, pretty, isTTY, expected] of rows) {
      expect({ env, pretty, isTTY, mode: resolveJsonMode({ env, pretty, isTTY }) }).toEqual({
        env,
        pretty,
        isTTY,
        mode: expected,
      });
    }
  });
});

/**
 * Two streams, two readers, one resolution rule — and a paint decision per stream beside it.
 *
 * `pithy doctor --json > out.json` at a terminal is the case that forced the mode split: the file wants
 * the parseable line and the screen wants the readable one. The **color** split is the mirror of it,
 * and it is the one that corrupts rather than merely annoys: an indent in a captured document still
 * parses, an escape sequence does not.
 */
describe("jsonStreams", () => {
  const lit = { color: true, forced: false };

  test("each stream answers for its own reader", () => {
    expect(jsonStreams({ stdout: false, stderr: true, ...lit }).stdout.mode).toBe("compact");
    expect(jsonStreams({ stdout: false, stderr: true, ...lit }).stderr.mode).toBe("pretty");
  });

  test("the flag and the variable apply to both", () => {
    const flagged = jsonStreams({ pretty: true, stdout: false, stderr: false, ...lit });
    expect([flagged.stdout.mode, flagged.stderr.mode]).toEqual(["pretty", "pretty"]);
    const forcedCompact = jsonStreams({ env: "compact", stdout: true, stderr: true, ...lit });
    expect([forcedCompact.stdout.mode, forcedCompact.stderr.mode]).toEqual(["compact", "compact"]);
  });

  test("both piped is the shape every script and every e2e test sees", () => {
    const piped = jsonStreams({ stdout: false, stderr: false, ...lit });
    expect(piped).toEqual({
      stdout: { mode: "compact", color: false },
      stderr: { mode: "compact", color: false },
    });
  });

  test("an unrecognized variable is refused once, not per stream", () => {
    expect(() => jsonStreams({ env: "prety", stdout: false, stderr: false, ...lit })).toThrow(PithyError);
  });

  /**
   * **A stream that is not a terminal is never painted, however the mode was decided.** The mode answers
   * "is a person reading this"; color additionally asks "are these bytes going to a screen". They come
   * apart exactly once — `pithy … --json --pretty 2> err.txt` at a terminal — and the seam alone says
   * yes there, because it latches on stdout. That wrote ANSI into a file something was about to parse.
   */
  describe("color, per stream", () => {
    test("a redirected stderr is never painted, even with --pretty at a terminal", () => {
      const split = jsonStreams({ pretty: true, stdout: true, stderr: false, color: true, forced: false });
      expect(split.stderr).toEqual({ mode: "pretty", color: false });
      expect(split.stdout).toEqual({ mode: "pretty", color: true });
    });

    test("a redirected stdout is never painted either", () => {
      const split = jsonStreams({ pretty: true, stdout: false, stderr: true, color: true, forced: false });
      expect(split.stdout.color).toBe(false);
      expect(split.stderr.color).toBe(true);
    });

    test("the seam saying no is the end of it — NO_COLOR paints nothing", () => {
      const off = jsonStreams({ pretty: true, stdout: true, stderr: true, color: false, forced: false });
      expect([off.stdout.color, off.stderr.color]).toEqual([false, false]);
    });

    /** `FORCE_COLOR` is the operator saying "I am capturing this and I want color anyway". */
    test("FORCE_COLOR paints a piped stream, which is what forcing means", () => {
      const forced = jsonStreams({ pretty: true, stdout: false, stderr: false, color: true, forced: true });
      expect([forced.stdout.color, forced.stderr.color]).toEqual([true, true]);
    });

    test("a compact stream carries the paint decision too, and the encoder ignores it", () => {
      expect(jsonStreams({ stdout: true, stderr: true, env: "compact", ...lit }).stdout).toEqual({
        mode: "compact",
        color: true,
      });
    });
  });
});
