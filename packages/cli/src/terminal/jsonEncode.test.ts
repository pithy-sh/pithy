// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import { encodeJson, type JsonPaint } from "./jsonEncode";

/** Markers rather than ANSI, so a test asserts *placement* — the same trick `notify.ts` uses for saffron. */
const marked: JsonPaint = {
  punctuation: (text) => `<p>${text}</p>`,
  literal: (text) => `<l>${text}</l>`,
};

/** What the seam is when color is off: every tier is the identity, so the bytes are plain JSON. */
const plain: JsonPaint = { punctuation: (text) => text, literal: (text) => text };

/** Every ANSI sequence, so an assertion can say "and it parses" about the colored form. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point.
const ANSI = /\u001b\[[0-9;]*m/g;

const ESC = "\u001b";

describe("encodeJson — compact", () => {
  test("is JSON.stringify, byte for byte — the contract every script already parses", () => {
    const payload = { command: "doctor", checks: [{ name: "node", ok: true }], count: 2 };
    expect(encodeJson(payload, { pretty: false, paint: marked })).toBe(JSON.stringify(payload));
  });

  test("paint never reaches a compact line, whatever the terminal says", () => {
    expect(encodeJson({ a: 1 }, { pretty: false, paint: marked })).toBe('{"a":1}');
  });
});

describe("encodeJson — pretty", () => {
  test("two-space indent, exactly what JSON.stringify's own indent produces", () => {
    const payload = { command: "doctor", checks: [{ name: "node", ok: true }] };
    expect(encodeJson(payload, { pretty: true, paint: plain })).toBe(JSON.stringify(payload, null, 2));
  });

  test("an empty object and an empty array stay on their line", () => {
    expect(encodeJson({ a: {}, b: [] }, { pretty: true, paint: plain })).toBe('{\n  "a": {},\n  "b": []\n}');
  });

  /**
   * The invariant the whole feature rests on. An encoder that wrote its own JSON would be a second
   * implementation of a format the kit's own e2e suites parse, so it is held to `JSON.stringify`'s
   * output rather than to a transcript somebody typed — across shapes chosen to break a naive one.
   */
  test("stripped of color, it is JSON.stringify(value, null, 2) for every shape", () => {
    const shapes: unknown[] = [
      {},
      { a: 1 },
      { nested: { deep: { deeper: [1, [2, [3]]] } } },
      { empty: {}, emptyList: [], nullish: null },
      { types: [0, -1, 1.5, true, false, null, ""] },
      // Braces, quotes, colons and newlines *inside* strings — where a regex highlighter goes wrong.
      { tricky: '{"a": 1}\n:,[]' },
      { unicode: "café — ünïcødé", escaped: 'quote " backslash \\ tab \t' },
      { list: [{ a: 1 }, { b: [2, 3] }] },
      [1, 2, 3],
      { command: "doctor", ok: false, findings: [{ code: "node/old", message: "Node 18 is past its floor." }] },
    ];
    for (const shape of shapes) {
      const colored = encodeJson(shape, { pretty: true, paint: marked });
      const stripped = colored.replaceAll(/<\/?[pl]>/g, "");
      expect(stripped).toBe(JSON.stringify(shape, null, 2));
      expect(JSON.parse(stripped)).toEqual(shape);
    }
  });

  test("braces, brackets, commas and colons are punctuation; nothing else is", () => {
    expect(encodeJson({ a: [1] }, { pretty: true, paint: marked })).toBe(
      ["<p>{</p>", '  "a"<p>:</p> <p>[</p>', "    <l>1</l>", "  <p>]</p>", "<p>}</p>"].join("\n"),
    );
  });

  test("a key and a string value are plain — saffron is not spent on structure, and nor is cyan", () => {
    expect(encodeJson({ name: "auth" }, { pretty: true, paint: marked })).toBe(
      ["<p>{</p>", '  "name"<p>:</p> "auth"', "<p>}</p>"].join("\n"),
    );
  });

  test("numbers, booleans and null are the literals that carry color", () => {
    expect(encodeJson({ n: 42, t: true, f: false, z: null }, { pretty: true, paint: marked })).toBe(
      [
        "<p>{</p>",
        '  "n"<p>:</p> <l>42</l><p>,</p>',
        '  "t"<p>:</p> <l>true</l><p>,</p>',
        '  "f"<p>:</p> <l>false</l><p>,</p>',
        '  "z"<p>:</p> <l>null</l>',
        "<p>}</p>",
      ].join("\n"),
    );
  });
});

/**
 * The seam, asserted rather than assumed. `style.ts` latches color at import, so this re-imports it the
 * way `style.test.ts` does — which is the only way to see both sides of a latched decision in one suite.
 */
describe("the default paint is the style seam", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function reload(env: Record<string, string | undefined>): Promise<typeof import("./jsonEncode")> {
    vi.resetModules();
    for (const key of ["NO_COLOR", "FORCE_COLOR", "COLORTERM"]) vi.stubEnv(key, env[key]);
    return await import("./jsonEncode");
  }

  test("with color on, pretty output carries ANSI and still parses once stripped", async () => {
    const { encodeJson: encode } = await reload({ FORCE_COLOR: "1" });
    const rendered = encode({ n: 1, s: "x" }, { pretty: true });
    expect(rendered).toContain(ESC);
    expect(JSON.parse(rendered.replaceAll(ANSI, ""))).toEqual({ n: 1, s: "x" });
  });

  test("NO_COLOR leaves indented JSON with zero ANSI bytes", async () => {
    const { encodeJson: encode } = await reload({ NO_COLOR: "1", FORCE_COLOR: "1" });
    const rendered = encode({ n: 1, s: "x" }, { pretty: true });
    expect(rendered).not.toContain(ESC);
    expect(rendered).toBe(JSON.stringify({ n: 1, s: "x" }, null, 2));
  });

  test("color on does not colorize a compact line — pretty is the gate color sits behind", async () => {
    const { encodeJson: encode } = await reload({ FORCE_COLOR: "1" });
    expect(encode({ n: 1 }, { pretty: false })).toBe('{"n":1}');
  });
});
