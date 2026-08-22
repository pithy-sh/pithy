// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { TEMPLATE_DIR } from "./templates";

/**
 * **The humanity check is never given a column it cannot render in, and always asked to fill the one
 * it gets.**
 *
 * Turnstile draws itself in a cross-origin iframe with an intrinsic size, so the widget's width is
 * settled in two places at once and either one alone leaves the ragged edge beside a full-width input:
 * the widget has to be asked for its `flexible` size, *and* the column it lands in has to stay above
 * the 300px that size stops shrinking at. The first adopter got this wrong twice — once by styling the
 * host and never touching the render call, once by asking for `flexible` inside a track free to
 * collapse under 300px — before getting it right.
 *
 * So the invariant is stated as a derivation rather than as a set of numbers to keep in step. One
 * constant carries the widget's floor; the measure is checked against it, the grid track is checked to
 * be built *from* the measure, and the gutter is checked to be built from the floor. Raising the floor
 * then moves everything that depends on it, and no value can be edited into disagreement with another.
 *
 * Both halves are load-bearing, and a violation of either has been planted against this file.
 */

/** CSS's own `rem`, at the initial root font size. Nothing in these templates changes it. */
const PX_PER_REM = 16;

/** Where Turnstile's `flexible` size stops shrinking. Cloudflare documents it; the stylesheet names it. */
const TURNSTILE_FLEXIBLE_FLOOR_PX = 300;

let css = "";
let turnstile = "";

beforeAll(async () => {
  css = await readFile(join(TEMPLATE_DIR, "src", "pithy-screens.css"), "utf8");
  turnstile = await readFile(join(TEMPLATE_DIR, "src", "turnstile.tsx"), "utf8");
});

/**
 * The declarations of the first rule whose prelude is exactly `selector`, comments stripped.
 *
 * **CSS, so the strip stays local (#439).** The shared walk in `@pithy-sh/core/src/text/comments` exists
 * because a TypeScript comment can be forged inside a string — a `//` in a URL, a `/*` in a glob. A
 * stylesheet has no line comments and no such string, so `/* … *\/` is the whole grammar and a pattern
 * over it is exact rather than approximate. {@link custom} strips the same way for the same reason.
 */
function rule(selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const pattern = new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`, "m");
  const found = withoutComments.match(pattern);
  expect(found, `no rule for ${selector}`).not.toBeNull();
  return found?.[1] ?? "";
}

/** A custom property's declared value, wherever in the sheet it is declared. */
function custom(name: string): string {
  const found = css.replace(/\/\*[\s\S]*?\*\//g, " ").match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  expect(found, `${name} is not declared`).not.toBeNull();
  return (found?.[1] ?? "").trim();
}

/** A CSS length in px. Only the two units these templates use, so a third unit fails loudly. */
function px(value: string): number {
  const found = value.trim().match(/^([\d.]+)(px|rem)$/);
  expect(found, `${value} is not a plain px or rem length`).not.toBeNull();
  return Number(found?.[1]) * (found?.[2] === "rem" ? PX_PER_REM : 1);
}

test("the stylesheet names the widget's own floor, so every rule below can be derived from it", () => {
  expect(px(custom("--pithy-check-min"))).toBe(TURNSTILE_FLEXIBLE_FLOOR_PX);
});

test("the form's measure is at least the width the widget can render at", () => {
  expect(px(custom("--pithy-auth-measure"))).toBeGreaterThanOrEqual(px(custom("--pithy-check-min")));
});

test("the credentials track's floor is built from the measure, never written out beside it", () => {
  const track = rule(".auth").match(/grid-template-columns\s*:\s*([^;]+);/)?.[1] ?? "";
  expect(track, "the two-column split does not reserve a floor for the credentials column").toContain("minmax(");
  expect(track).toContain("var(--pithy-auth-measure)");
});

test("the gutter is built from the floor, so padding can never eat into the widget's width", () => {
  expect(rule(".auth__credentials")).toContain("var(--pithy-check-min)");
});

test("the host gives the widget the whole column", () => {
  expect(rule(".auth__check")).toMatch(/width\s*:\s*100%/);
});

test("and the widget is asked to take it — `flexible`, not the fixed 300px box", () => {
  expect(turnstile).toMatch(/size\s*:\s*"flexible"/);
});
