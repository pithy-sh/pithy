// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cyan, dim } from "./style";

/**
 * The `--json` encoder: one compact line, or two-space indented with restrained syntax color.
 *
 * **Restrained, and deliberately so.** Punctuation goes dim, keys and string values stay plain, and only
 * the literals — numbers, booleans, `null` — take a hue. Saffron is not spent here at all: `docs/BRAND.md`
 * §5 reserves it for meaning, and tinting every key on every line is exactly the overuse that section
 * warns against. Structure is what dim is for.
 *
 * **Held to `JSON.stringify`, not to a layout of its own.** The indented form is written character for
 * character as `JSON.stringify(value, null, 2)` writes it, and `jsonEncode.test.ts` asserts that against
 * the real function rather than against a transcript. The kit prints JSON — never JSONL, never NDJSON —
 * so indenting a document that was always one document cannot break a framing that does not exist, and
 * every e2e suite that parses `--json` stdout keeps parsing the same bytes.
 */

/** The two tiers this encoder paints with. Injectable so a test asserts placement without a terminal. */
export interface JsonPaint {
  /** Braces, brackets, commas and colons. */
  punctuation: (text: string) => string;
  /** Numbers, booleans and `null`. */
  literal: (text: string) => string;
}

/**
 * The real paint: the `style.ts` seam, so color is gated twice — pretty must be on **and** color must be
 * enabled. `NO_COLOR`, a pipe or a capture makes both tiers the identity, which leaves valid indented
 * JSON with no escape byte in it.
 */
export const stylePaint: JsonPaint = { punctuation: dim, literal: cyan };

/**
 * No paint at all — every tier the identity.
 *
 * Distinct from `stylePaint` happening to be the identity when the seam says no: this is the caller
 * stating that *this stream* takes no color, which is how a pretty document bound for a file stays
 * parseable while the terminal beside it is still painted.
 */
export const plainPaint: JsonPaint = { punctuation: (text) => text, literal: (text) => text };

/** What {@link encodeJson} needs. `paint` defaults to the `style.ts` seam. */
export interface EncodeJsonOptions {
  pretty: boolean;
  paint?: JsonPaint;
}

/** `JSON.stringify`'s own indent, as a string, so the two layouts cannot drift. */
const INDENT = "  ";

/**
 * Encode one JSON document for whoever is reading it.
 *
 * Compact is `JSON.stringify` and nothing else, because that is the contract `docs/CLI.md` states and
 * every call site already ships.
 */
export function encodeJson(value: unknown, { pretty, paint = stylePaint }: EncodeJsonOptions): string {
  const compact = JSON.stringify(value);
  // `undefined` for a value JSON has no spelling for. Compact already answers that the way every caller
  // has always seen, and there is nothing to indent.
  if (!pretty || compact === undefined) return compact;
  return write(JSON.parse(compact), "", paint);
}

/**
 * One value, indented under `indent`.
 *
 * Walked over the **parsed** compact form rather than the caller's object, so `toJSON`, dropped
 * `undefined` members, and non-finite numbers are already resolved the one way `JSON.stringify` resolves
 * them — a second set of rules here is how a highlighter comes to disagree with the parser.
 */
function write(value: unknown, indent: string, paint: JsonPaint): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return paint.literal(String(value));
  }
  // A string, key or value, is written by `JSON.stringify` so every escape is its escape, and left plain.
  if (typeof value !== "object") return JSON.stringify(value);

  const inner = indent + INDENT;
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  const members = Array.isArray(value)
    ? value.map((item) => inner + write(item, inner, paint))
    : Object.entries(value).map(
        ([key, item]) => `${inner}${JSON.stringify(key)}${paint.punctuation(":")} ${write(item, inner, paint)}`,
      );
  // `{}` and `[]` — `JSON.stringify` puts nothing between them, not even a newline.
  if (members.length === 0) return paint.punctuation(open + close);
  return [
    paint.punctuation(open),
    members.join(`${paint.punctuation(",")}\n`),
    `${indent}${paint.punctuation(close)}`,
  ].join("\n");
}
