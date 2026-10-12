// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { unifiedDiff } from "./lineDiff";

/**
 * **A plan's `diff` is the change a person reviews before it lands (#697).** It has to read like the diff
 * `git` would show after the write: the lines that change, three of context around them, and nothing else.
 */

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
const text = (rows: string[]) => `${rows.join("\n")}\n`;

describe("unifiedDiff", () => {
  test("identical text has no diff", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  test("one changed line, with three lines of context either side", () => {
    const before = lines(10);
    const after = [...before];
    after[4] = "changed";
    expect(unifiedDiff(text(before), text(after))).toBe(
      [
        "@@ -2,7 +2,7 @@",
        " line 2",
        " line 3",
        " line 4",
        "-line 5",
        "+changed",
        " line 6",
        " line 7",
        " line 8",
        "",
      ].join("\n"),
    );
  });

  test("a new file is every line added", () => {
    expect(unifiedDiff("", "a\nb\n")).toBe("@@ -0,0 +1,2 @@\n+a\n+b\n");
  });

  test("a file emptied is every line removed", () => {
    expect(unifiedDiff("a\nb\n", "")).toBe("@@ -1,2 +0,0 @@\n-a\n-b\n");
  });

  test("changes far apart are two hunks; close together, one", () => {
    const before = lines(30);
    const apart = [...before];
    apart[1] = "x";
    apart[25] = "y";
    expect(unifiedDiff(text(before), text(apart)).match(/^@@/gm)).toHaveLength(2);
    const close = [...before];
    close[1] = "x";
    close[6] = "y";
    expect(unifiedDiff(text(before), text(close)).match(/^@@/gm)).toHaveLength(1);
  });

  test("an insertion keeps the lines around it as context, not as a rewrite", () => {
    const diff = unifiedDiff("a\nb\nc\n", "a\nb\nnew\nc\n");
    expect(diff).toBe("@@ -1,3 +1,4 @@\n a\n b\n+new\n c\n");
  });

  test("a final line without a newline is said, so the diff is not a lie about it", () => {
    expect(unifiedDiff("a\n", "a")).toBe("@@ -1 +1 @@\n-a\n+a\n\\ No newline at end of file\n");
  });

  test("a long file with a small change stays a small diff", () => {
    const before = lines(5000);
    const after = [...before];
    after[2500] = "changed";
    const diff = unifiedDiff(text(before), text(after));
    expect(diff.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-"))).toEqual([
      "-line 2501",
      "+changed",
    ]);
  });

  /**
   * **A carriage return is content, as `git` reads it by default.** A line ends at `\n` and nothing else, so a
   * write that only swaps CRLF for LF changes every line it touches, and the diff says so — read as a line
   * ending, the same change was an empty diff on a file the run rewrote. Held to `git` below.
   */
  test("a carriage return is part of the line, so a Windows file diffs as git shows it", () => {
    expect(unifiedDiff("a\r\nb\r\n", "a\r\nc\r\n")).toBe("@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n");
    expect(unifiedDiff("a\r\nb\r\n", "a\nb\n")).not.toBe("");
  });
});

/**
 * **The last line's newline, held to `git` itself.** A patch is only a patch if `git apply` takes it, and the
 * `\\ No newline at end of file` marker is where hand-written diffs go wrong: it belongs after the side that lacks
 * the newline, so a last line whose newline-ness changes is a `-` and a `+`, never a shared context line. Every
 * combination of the two sides' final newline, crossed with what happens at the end of the file, is compared with
 * `git diff --no-index` byte for byte, and every patch produced is applied by `git apply` and must reproduce the
 * new text exactly.
 */
describe("unifiedDiff, against git", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pithy-linediff-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** No user or system git config: `diff.algorithm`, `diff.noprefix` and the like would change what git prints. */
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: scratch };

  /**
   * `git diff --no-index`, hunks only — the headers name temp files, and `unifiedDiff` prints hunks alone. Git's
   * function-context label after a hunk header is dropped too: it is a guess about the language, and a plan's diff
   * makes none.
   */
  function gitDiff(before: string, after: string): string {
    writeFileSync(join(scratch, "old"), before);
    writeFileSync(join(scratch, "new"), after);
    let printed = "";
    try {
      execFileSync("git", ["diff", "--no-index", "--no-color", "--diff-algorithm=myers", "-U3", "old", "new"], {
        cwd: scratch,
        env: gitEnv,
        encoding: "utf8",
      });
    } catch (error) {
      // Exit 1 is git saying the files differ, which is every case here.
      printed = (error as { stdout: string }).stdout;
    }
    const start = printed.indexOf("@@");
    return start === -1 ? "" : printed.slice(start).replace(/^(@@ [^@]+ @@).*$/gm, "$1");
  }

  /** Apply `diff` to `before` with `git apply`, and hand back the file it leaves. */
  function gitApply(before: string, diff: string): string {
    const target = join(scratch, "target");
    writeFileSync(target, before);
    writeFileSync(join(scratch, "patch"), `--- a/target\n+++ b/target\n${diff}`);
    execFileSync("git", ["apply", "--unidiff-zero", "patch"], { cwd: scratch, env: gitEnv });
    return readFileSync(target, "utf8");
  }

  const base = lines(8);
  const ends = { newline: "\n", "no newline": "" } as const;
  const changes = {
    "a line appended": (rows: string[]) => [...rows, "appended"],
    "the last line deleted": (rows: string[]) => rows.slice(0, -1),
    "the last line modified": (rows: string[]) => [...rows.slice(0, -1), "modified"],
    "a change near the end, the last line kept": (rows: string[]) => rows.map((row, i) => (i === 5 ? "near" : row)),
    "a change far from the end, the last line kept": (rows: string[]) => rows.map((row, i) => (i === 0 ? "far" : row)),
    "no change but the newline": (rows: string[]) => rows,
  };

  const cases = Object.entries(ends).flatMap(([oldEnd, oldTail]) =>
    Object.entries(ends).flatMap(([newEnd, newTail]) =>
      Object.entries(changes).map(([change, apply]) => ({
        name: `old ${oldEnd}, new ${newEnd}: ${change}`,
        before: `${base.join("\n")}${oldTail}`,
        after: `${apply(base).join("\n")}${newTail}`,
      })),
    ),
  );

  test.each([
    ...cases.filter((entry) => entry.before !== entry.after),
    { name: "the review's case: a line appended to a file with no newline", before: "a\nb", after: "a\nb\nc" },
    { name: "a newline added to a one-line file", before: "a", after: "a\n" },
    { name: "a one-line file emptied", before: "a", after: "" },
    { name: "a one-line file created", before: "", after: "a" },
    { name: "CRLF to LF, every line", before: "a\r\nb\r\nc\r\n", after: "a\nb\nc\n" },
    { name: "LF to CRLF, every line", before: "a\nb\nc\n", after: "a\r\nb\r\nc\r\n" },
    { name: "CRLF to LF, one line of a mixed file", before: "a\r\nb\nc\r\nd\n", after: "a\r\nb\nc\nd\n" },
    { name: "a mixed file, one line changed and its ending kept", before: "a\r\nb\nc\r\n", after: "a\r\nB\nc\r\n" },
    { name: "a lone carriage return mid-line", before: "a\rb\nc\n", after: "a\nb\nc\n" },
  ])("$name", ({ before, after }) => {
    const diff = unifiedDiff(before, after);
    expect(diff).toBe(gitDiff(before, after));
    expect(gitApply(before, diff)).toBe(after);
  });

  test("the table covers every pairing it names", () => {
    expect(cases).toHaveLength(2 * 2 * Object.keys(changes).length);
  });
});
