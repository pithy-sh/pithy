// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { blankComments } from "./comments";

describe("blankComments", () => {
  test("prose is blanked, and the line it stood on still counts", () => {
    // Both halves of what a caller depends on. A docblock explaining why a config must not read the
    // environment is prose every scan has to walk past — that is the false positive — and blanking it
    // has to leave the line count alone, or every failure names a line the reader cannot find.
    const source = ["/**", " * Never read process.env here.", " */", "const a = 1;", "process.env.X;"].join("\n");
    const lines = blankComments(source).split("\n");
    expect(lines.filter((line) => line.includes("process.env"))).toEqual(["process.env.X;"]);
    expect(lines.indexOf("process.env.X;") + 1).toBe(5);
  });

  test("a string is not a comment, which is how two reads went unreported", () => {
    // The two shapes #437 measured, both silent under a `replace` over a comment pattern and both
    // planted into real source to watch a gate go red — a `//` in a URL, and an unbalanced `/*` in a
    // glob. A read is only ever *added* by walking instead, so the assertion is that each line
    // survives to be reported.
    const inlineUrl = 'const base = "https://api.cloudflare.com"; const t = process.env.CLOUDFLARE_API_TOKEN ?? "";';
    expect(blankComments(inlineUrl)).toContain("process.env.CLOUDFLARE_API_TOKEN");

    const glob = [
      'include: ["**/*.workers.test.ts"],',
      'const t = process.env.CLOUDFLARE_API_TOKEN ?? "";',
      "/** Anything at all. */",
    ].join("\n");
    const globLines = blankComments(glob).split("\n");
    expect(globLines[1]).toContain("process.env.CLOUDFLARE_API_TOKEN");
  });

  test("and the reverse: a quote inside a comment or a regex opens no string", () => {
    // So the walk is not simply preserving everything. A runaway string state would blank a real read
    // on some later line, which is the same false negative wearing a hat.
    const quoted = ['// it\'s fine, "really"', "const pattern = /^[\"']+/;", "process.env.X;"].join("\n");
    const quotedLines = blankComments(quoted).split("\n");
    expect(quotedLines[0]?.trim()).toBe("");
    expect(quotedLines[2]).toBe("process.env.X;");

    // A block comment quoting an apostrophe is the same trap over more lines: the line after it must
    // still read as code rather than as the inside of a string.
    const block = ['/* it\'s a comment, "really" */', 'const kept = "value";', "process.env.Y;"].join("\n");
    const blockLines = blankComments(block).split("\n");
    expect(blockLines[0]?.trim()).toBe("");
    expect(blockLines[1]).toBe('const kept = "value";');
    expect(blockLines[2]).toBe("process.env.Y;");

    // And a `/` that divides is not a regex: a runaway literal would swallow the rest of the line.
    const divide = ["const ratio = total / count;", 'const url = "a//b";', "process.env.Z;"].join("\n");
    expect(blankComments(divide).split("\n")[2]).toBe("process.env.Z;");
  });

  test("every offset is where it was, so a caller may measure on one text and cut the other", () => {
    // `ui/react.test.ts` slices a screen between two markers it found in the raw file and reads the
    // blanked slice. That is only sound while blanking is character-for-character, so it is asserted
    // here rather than inferred from the implementation.
    const source = ['const from = "a"; /* note */ const to = "b";', "// trailing", "done();"].join("\n");
    const blanked = blankComments(source);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.indexOf("const to")).toBe(source.indexOf("const to"));
  });
});
