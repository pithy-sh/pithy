// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { localeDeclared, valueSpans } from "./localeMarker";

/**
 * The marker, assembled rather than typed out.
 *
 * A literal marker line in this file's own head would declare *this* file a translated catalog, and the
 * census sweep that holds every declaring file to the published spelling would then read a fixture as a
 * catalog that had drifted. `packages/cli/src/ci/americanEnglish.test.ts` builds it the same way, for the
 * same reason — a file that reads the marker is the one file that must not carry it.
 */
const marker = (tag: string) => `// LOCALE ${tag} — an unreviewed first pass. Not American English by design.`;

/** The quoted runs `valueSpans` found, as text, so a case reads as what it exempts rather than as arithmetic. */
const valued = (line: string, everyQuoted = false): string[] =>
  valueSpans(line, everyQuoted).map(([open, close]) => line.slice(open, close));

describe("the locale a file declares in its head", () => {
  test("a marker in the head declares its tag", () => {
    expect(localeDeclared(`${marker("es")}\nexport const esErrors = {};\n`)).toBe("es");
  });

  test("it need not be the first line — a license header comes before it", () => {
    const head = "// SPDX-FileCopyrightText: 2026 Pithy\n// SPDX-License-Identifier: MIT\n";
    expect(localeDeclared(`${head}\n${marker("es")}\n`)).toBe("es");
  });

  test("the twenty-fifth line is still the head", () => {
    // The published window, pinned from both sides. `docs/I18N.md` publishes it, so the boundary is a
    // documented number rather than a tuning knob, and a reader that moved it by one would leave every
    // catalog written to the document either unread or exempt. That the document states the same count is
    // `packages/cli/src/ci/americanEnglish.test.ts`'s pin; that the reader stops there is this one's.
    const padding = Array.from({ length: 24 }, () => "//").join("\n");
    expect(localeDeclared(`${padding}\n${marker("es")}\n`)).toBe("es");
  });

  test("past the head it is prose about a marker, not a marker", () => {
    // Which is what lets a file discuss the convention — this one does — without adopting it.
    const padding = Array.from({ length: 25 }, () => "//").join("\n");
    expect(localeDeclared(`${padding}\n${marker("es")}\n`)).toBeNull();
  });

  test("English is a declaration, never an exemption — the tag comes back like any other", () => {
    // The half a porter gets backwards. `localeDeclared` reports what the file says it is; deciding that
    // an English file's values stay under the census is the caller's, and it is the whole point of
    // capturing the tag rather than answering a yes or a no.
    expect(localeDeclared(marker("en"))).toBe("en");
    expect(localeDeclared(marker("en-GB"))).toBe("en-GB");
  });

  test("a regional tag keeps its subtags", () => {
    expect(localeDeclared(marker("es-AR"))).toBe("es-AR");
    expect(localeDeclared(marker("pt-BR"))).toBe("pt-BR");
    expect(localeDeclared(marker("zh-Hant-TW"))).toBe("zh-Hant-TW");
  });

  test("no marker, no declaration", () => {
    expect(localeDeclared("export const enErrors = {};\n")).toBeNull();
    expect(localeDeclared("")).toBeNull();
  });

  test("half a marker declares nothing — both facts or neither", () => {
    // The locale and the unreviewed state are one sentence because a file claiming to be finished when it
    // is not costs more than a file that says so. Either half alone is a line somebody was writing.
    expect(localeDeclared("// LOCALE es\n")).toBeNull();
    expect(localeDeclared("// an unreviewed first pass.\n")).toBeNull();
  });

  test("the published spelling is the spelling — a near miss declares nothing", () => {
    for (const near of [
      "// LOCALE es - an unreviewed first pass.",
      "// LOCALE es — an unreviewed first draft.",
      "// LOCALE es — a reviewed first pass.",
      "// locale es — an unreviewed first pass.",
      "// LOCALE — an unreviewed first pass.",
      "// LOCALE es — an unreviewed first pass",
    ]) {
      expect(localeDeclared(near), near).toBeNull();
    }
  });
});

describe("the quoted values on one line", () => {
  test("a span runs from the first inner character to the closing quote", () => {
    // Pinned as offsets once, because a caller does arithmetic with them: a match at or after `open` and
    // ending at or before `close` sits inside a value. Every other case below reads the text instead.
    expect(valueSpans(`x = "ab"`)).toEqual([[5, 7]]);
  });

  test("all three quote characters open a value", () => {
    expect(valued(`const state = "queued";`)).toEqual(["queued"]);
    expect(valued(`const state = 'queued';`)).toEqual(["queued"]);
    expect(valued("const state = `queued`;")).toEqual(["queued"]);
  });

  test("every value on the line, left to right", () => {
    expect(valued(`const jobs = { "queued": "sending" };`)).toEqual(["queued", "sending"]);
  });

  test("a quoted sentence is prose, not a value", () => {
    // The rule that keeps this from exempting everything anybody puts in quotes. Whitespace inside the
    // run is the signal: a token is data, a sentence is something we wrote.
    expect(valued(`const help = "Run pithy doctor.";`)).toEqual([]);
  });

  test("a token inside a quoted sentence is still a value", () => {
    // How a `.describe()` names a wire value. The outer run holds whitespace and is passed over rather
    // than skipped, so the scan keeps reading and finds the backticked token inside it.
    expect(valued('const help = "Set it to `queued` first.";')).toEqual(["queued"]);
  });

  test("everyQuoted widens the sentences back in", () => {
    // For one case and one only: a file that has declared itself written in another language, where the
    // quoted sentences are the translation and everything around them is still our English.
    expect(valued(`const es = { "a/b": "Se requiere una cuenta." };`, true)).toEqual([
      "a/b",
      "Se requiere una cuenta.",
    ]);
  });

  test("an empty pair holds nothing to exempt", () => {
    expect(valued(`const blank = "";`)).toEqual([]);
    expect(valued(`const blank = "";`, true)).toEqual([]);
  });

  test("a quote that never closes on its line opens no value", () => {
    // Which is why the inner lines of a multi-line template literal are read as prose: the scan is one
    // line's worth, and a run with no closing quote on that line is not a run.
    expect(valued("const opening = `Se requiere una cuenta")).toEqual([]);
    expect(valued("const opening = `Se requiere una cuenta", true)).toEqual([]);
  });

  test("a line with no quotes has no values", () => {
    expect(valued("export const total = 1 + 2;")).toEqual([]);
  });
});
