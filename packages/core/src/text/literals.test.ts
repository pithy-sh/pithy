// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { literalSpans, literalTexts } from "./literals";

describe("literalTexts", () => {
  test("reads each quoted string, quotes off and escapes resolved", () => {
    expect(literalTexts(`const a = "one \\"two\\""; const b = 'it\\'s';`)).toEqual(['one "two"', "it's"]);
  });

  test("blanks each interpolation, and reads an escaped backtick as one", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    expect(literalTexts("const a = `Run \\`${command}\\` now`;")).toEqual(["Run `<x>` now"]);
  });

  // The defect it replaced: a regular expression closed the outer template at the inner backtick.
  test("reads a template nested in an interpolation as a literal of its own, and the outer one whole", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    const source = 'const line = `${path} (run \\`${run}\\`)${detail ? ` — ${detail}` : ""}`;';
    expect(literalTexts(source)).toEqual(["<x> (run `<x>`)<x>", " — <x>", ""]);
  });

  test("keeps braces inside an interpolation from closing it", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    expect(literalTexts("const a = `x ${f({ a: 'b' })} y`;")).toEqual(["x <x> y", "b"]);
  });

  test("steps over a regex literal, so its quote opens no string", () => {
    expect(literalTexts(`const re = /^["']/; const s = "after";`)).toEqual(["after"]);
  });

  test("ends an unclosed single-line string at its newline", () => {
    expect(literalTexts(`const a = "open\nconst b = "closed";`)).toEqual(["open", "closed"]);
  });

  // A `.tsx` file says most of its words as JSX: text between tags, and attribute strings (#711).
  describe("in JSX", () => {
    const jsx = (source: string) => literalTexts(source, { jsx: true });

    test("reads an element's text, whitespace collapsed, and each attribute string", () => {
      const source = `const a = (\n  <Box label="Run pithy doctor">\n    Run   pithy\n    migrate --env staging\n  </Box>\n);`;
      expect(jsx(source)).toEqual(["Run pithy doctor", "Run pithy migrate --env staging"]);
    });

    test("blanks a child expression, and reads the literals inside it", () => {
      expect(jsx(`const a = <Text>Run pithy {path} {"now"}</Text>;`)).toEqual(["now", "Run pithy <x> <x>"]);
    });

    test("reads a nested element's text as its own, after return and in a fragment", () => {
      const source = `function f() { return <><Text>Run <Code>pithy doctor</Code> first.</Text></>; }`;
      expect(jsx(source)).toEqual(["Run", "pithy doctor", "first."]);
    });

    test("an apostrophe in text opens no string, and a closing tag opens no regex", () => {
      const source = `const a = <Text>Don't run it.</Text>; const b = "after";`;
      expect(jsx(source)).toEqual(["Don't run it.", "after"]);
    });

    test("a self-closing element, an expression attribute and a spread", () => {
      const source = `const a = <Input value={x ? "pithy add" : 'b'} {...rest} hint='pithy ui sync' />;`;
      expect(jsx(source)).toEqual(["pithy add", "b", "pithy ui sync"]);
    });

    test("a comparison and a generic are code, not elements", () => {
      expect(jsx(`const a = b < c; const d = new Map<string, number>(); const e = "x";`)).toEqual(["x"]);
      expect(jsx(`const id = <T,>(value: T): T => value; const s = "after";`)).toEqual(["after"]);
    });

    test("is off unless asked for: a .ts file has no JSX", () => {
      expect(literalTexts(`const a = b <c && d; const s = "after";`)).toEqual(["after"]);
    });
  });
});

describe("literalSpans", () => {
  // Where each literal sits, so a gate can read what is around it: a `+`, an array that is joined.
  test("gives each literal's text and the source range it spans, quotes included", () => {
    const source = `const a = "pithy" + b;`;
    const [one] = literalSpans(source);
    expect(one?.text).toBe("pithy");
    expect(source.slice(one?.start, one?.end)).toBe('"pithy"');
  });

  // An interpolation is code: a gate reading a literal's surroundings reads through it.
  test("a template's span names each interpolation, as the code inside it", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    const source = 'const c = `a ${["pithy", b].join(" ")} c`;';
    const [outer] = literalSpans(source);
    expect(outer?.holes?.map(([start, end]) => source.slice(start, end))).toEqual(['["pithy", b].join(" ")']);
    expect(literalSpans('const a = "x";')[0]?.holes).toBeUndefined();
  });

  test("a template's span is the whole template", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    const source = "f(`Run pithy ${path}`, 'x');";
    const spans = literalSpans(source);
    expect(spans.map((span) => span.text)).toEqual(["Run pithy <x>", "x"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    expect(source.slice(spans[0]?.start, spans[0]?.end)).toBe("`Run pithy ${path}`");
  });
});
