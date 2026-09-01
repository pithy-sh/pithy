// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { CapabilityDescriptor } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { IanaTimezone, JsonDate, SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { HttpError } from "@pithy-sh/core/src/error/http";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { isShippedSource, readSource, sourcePaths } from "./sourceFiles";

/**
 * **`safeParse` cannot throw. Only `parse` throws.**
 *
 * That is a contract about every codec in this kit, so it is stated about every codec in this kit —
 * not about the two that were caught. `JsonDate` and `SQLiteDate` raised a `PithyError` from inside
 * their decode transform, and Zod's `safeParse` catches a `ZodError` and nothing else: an exception
 * from a transform walks past it and out of the reader. Every boundary reader here and in the dashboard
 * is written `const parsed = X.safeParse(body); return parsed.success ? parsed.data : null;` and
 * documented *never throws*, so any reader over a shape containing a date was a 500 waiting for the
 * first malformed timestamp a caller sent — and the caller picks the timestamp (#358).
 *
 * Fixing two functions would leave the fifth codec somebody writes next month exactly as exposed. So:
 *
 * 1. **The population is discovered from the tree.** Every `z.codec(` under `packages/*​/src`, found by
 *    reading the source rather than by remembering. A codec added tomorrow is in the population
 *    tomorrow, with nobody to remind.
 * 2. **The expectation is a frozen literal.** {@link CODEC_SITES} is written down here, by hand, and
 *    {@link DRIVERS} is keyed to match it. Neither is read off the modules under test — deriving the
 *    permitted set from its own subject is shape 2 of this repository's eight-shape taxonomy of gates
 *    that cannot fail (#326, and `sweepPopulation.test.ts` holds the taxonomy).
 * 3. **Anti-vacuity is exact.** The walk must find {@link EXPECTED_SITES} codecs, and the drive must
 *    perform {@link EXPECTED_CHECKS} checks. Not `> 0`, which is the shape of a guard rather than one.
 * 4. **A codec the gate cannot drive fails.** It is not skipped and it is not excused: a driver missing,
 *    or a driver with no rejecting input in either direction, is a red build. "We could not think of a
 *    bad value for it" is how a codec stays untested while looking covered.
 *
 * And it states the contract rather than the instance. Not *"`JsonDate` does not throw"* but *no codec
 * in this kit escapes `safeParse` or `safeEncode`, for any input its transform rejects* — in both
 * directions, because a Zod 4 codec runs on the way out too and a throw from `encode` is the same
 * defect facing the other way.
 */

/** The repo's `packages/`, from this file — `packages/cli/src/ci` is four levels down. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..", "..", "packages");

/**
 * The needle — **a shape, not a spelling.**
 *
 * It was the literal `z.` + `codec(`, matched one line at a time, and that described a formatting
 * convention rather than the thing being gated. `adminRoute.ts` writes `export const CapabilityDescriptor
 * = z` and then `.codec(` on the next line — Biome's own wrapping, over a long generic — so the one
 * codec on the control-plane wire was invisible to a walk whose whole job is finding every codec. The
 * gate was green over a population it did not cover, which is the failure this file's own header
 * describes and then had.
 *
 * So the pattern spans whitespace, newline included, and the walk runs over the source rather than over
 * its lines. Note what the fix is *not*: enrolling that one file, or forbidding the line break. Either
 * would leave the next long codec declaration exactly as invisible — the reach of the gate has to match
 * the rule it states, which is *every codec*, however somebody's formatter breaks the line.
 *
 * **It still does not match itself.** The pattern needs `codec` immediately after the dot; every
 * occurrence in this file has a backslash or a brace between, so the scan reads no `z.codec(` here. That
 * is the same property the assembled literal had, kept for the same reason: deriving a gate's population
 * from its own subject is shape 2 of the taxonomy in `sweepPopulation.test.ts`.
 */
const CODEC = /\bz\s*\.\s*codec\s*\(/g;

/** `export const X =`, `export function X`, or either without the `export`. The nearest one above a site names it. */
const DECLARATION = /^\s*(?:export\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)/;

/** One `z.codec(` in the tree, as `<path under packages>#<the thing it is called>`. */
function siteName(lines: readonly string[], index: number): string {
  for (let above = index; above >= 0; above--) {
    const named = DECLARATION.exec(lines[above] ?? "");
    if (named?.[1]) return named[1];
  }
  return `<anonymous:${index + 1}>`;
}

/** Every codec under `packages/*​/src`, keyed the way {@link DRIVERS} is. */
function codecSites(): string[] {
  const found: string[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const path of sourcePaths(join(PACKAGES, pkg.name, "src"), { keep: isShippedSource })) {
      const source = readSource(path);
      if (source === null) continue;
      const lines = source.split("\n");
      const file = relative(PACKAGES, path).split("\\").join("/");
      // Over the source rather than over its lines, because the match may straddle a line break. The
      // line it *starts* on is what names it: `siteName` walks up from there to the declaration, and a
      // wrapped `= z\n.codec(` starts on the `z`, which is the line the declaration is on.
      CODEC.lastIndex = 0;
      for (let hit = CODEC.exec(source); hit !== null; hit = CODEC.exec(source)) {
        const line = source.slice(0, hit.index).split("\n").length - 1;
        found.push(`${file}#${siteName(lines, line)}`);
      }
    }
  }
  return found.sort();
}

/**
 * **The record.** Every codec this kit defines, written down by hand.
 *
 * A codec that lands here without a {@link DRIVERS} entry fails, and a driver for a codec that no longer
 * exists fails too. The point of the second direction is the rename: a codec that moved and quietly
 * stopped being driven would otherwise leave a green gate over nothing.
 */
const CODEC_SITES = [
  // **The one the walk could not see.** `adminRoute.ts` wraps its declaration, so `.codec(` sits on a
  // line of its own and a line-at-a-time scan for `z.codec(` missed it — the codec on the control-plane
  // wire, unenrolled, while this gate reported green over six of seven. See {@link CODEC}.
  "core/src/controlPlane/discovery/adminRoute.ts#CapabilityDescriptor",
  "core/src/data/codecs.ts#IanaTimezone",
  "core/src/data/codecs.ts#JsonDate",
  "core/src/data/codecs.ts#SQLiteBoolean",
  "core/src/data/codecs.ts#SQLiteDate",
  "core/src/data/codecs.ts#sqliteJson",
  "core/src/error/http.ts#HttpError",
];

/** Seven, as this is written. Frozen on purpose: a walk that returns two makes the partition trivial. */
const EXPECTED_SITES = 7;

/** How the gate drives one codec: the thing itself, and values it must refuse in each direction. */
interface Driver {
  /** The codec, or a representative instance of it where the export is a factory. */
  readonly codec: z.ZodType;
  /** Inputs `safeParse` must refuse. At least one, or this codec is not really under test. */
  readonly rejectsOnParse: readonly unknown[];
  /** Values `safeEncode` must refuse. At least one, for the same reason. */
  readonly rejectsOnEncode: readonly unknown[];
}

/**
 * A value a `Date` cannot hold. `8.64e15` is the largest instant one can represent, so one past it is
 * as unusable as `new Date("not-a-date")` — and it arrives through the *number* branch, which is the
 * branch a check written only about strings would miss.
 */
const BEYOND_DATE_RANGE = 8.64e15 + 1;

/**
 * The drivers, keyed to {@link CODEC_SITES}.
 *
 * Every input here must make the parse **fail** — not merely not-throw. A driver handed a value the
 * codec happily accepts is a check that passes over nothing, which is why the assertion below is
 * `success === false` and not just an absence of an exception. `IanaTimezone` is the one that makes
 * this concrete: it answers `"Not/AZone"` with `undefined` rather than a failure, by design, so a gate
 * written with garbage-that-looks-invalid would have driven it and proved nothing.
 */
const DRIVERS: Record<string, Driver> = {
  /*
    The control-plane manifest's own entry, and the one codec here whose sides are whole objects rather
    than scalars.

    **The encode side is the half worth having.** `CapabilityDescriptor` is what a Worker's seam answers
    with, so a throw out of `safeEncode` is a 500 on the discovery route every management client calls
    first — the same shape as the date defect this gate was built for, one layer up. The values below are
    refused on the way out for three different reasons: nothing at all, a health report whose `state` is
    not one of the four, and an entry whose `healthKeys` is not a list of keys.
  */
  "core/src/controlPlane/discovery/adminRoute.ts#CapabilityDescriptor": {
    codec: CapabilityDescriptor,
    rejectsOnParse: [null, 42, {}, { name: "secrets" }, { name: "secrets", version: "1.0.0", adminRoutes: 7 }],
    rejectsOnEncode: [
      null,
      {},
      { name: "secrets", version: "1.0.0", adminRoutes: [], health: { state: "exploded" } },
      { name: "secrets", version: "1.0.0", adminRoutes: [], healthKeys: [42], health: { state: "undeclared" } },
    ],
  },
  "core/src/data/codecs.ts#IanaTimezone": {
    codec: IanaTimezone,
    rejectsOnParse: [42, {}, []],
    rejectsOnEncode: [42, {}],
  },
  "core/src/data/codecs.ts#JsonDate": {
    codec: JsonDate,
    rejectsOnParse: ["not-a-date", Number.NaN, BEYOND_DATE_RANGE, {}],
    rejectsOnEncode: [new Date(Number.NaN), "2026-06-09T00:00:00.000Z", 0],
  },
  "core/src/data/codecs.ts#SQLiteBoolean": {
    codec: SQLiteBoolean,
    rejectsOnParse: [{}, [], null],
    rejectsOnEncode: ["true", 1, null],
  },
  "core/src/data/codecs.ts#SQLiteDate": {
    codec: SQLiteDate,
    rejectsOnParse: ["not-a-date", Number.NaN, BEYOND_DATE_RANGE, {}],
    rejectsOnEncode: [new Date(Number.NaN), 0, "2026-06-09T00:00:00.000Z"],
  },
  // A factory, so the gate supplies the schema. `bigint` is in it deliberately: it is a value the inner
  // schema admits and `JSON.stringify` refuses, which is the encode-side throw this codec had.
  "core/src/data/codecs.ts#sqliteJson": {
    codec: sqliteJson(z.object({ a: z.union([z.number(), z.bigint()]) })),
    rejectsOnParse: ["{not json", '{"a":"x"}', "", 42, null],
    rejectsOnEncode: [{ a: 1n }, 42, { a: "x" }],
  },
  "core/src/error/http.ts#HttpError": {
    codec: HttpError,
    rejectsOnParse: [{}, { code: "nope" }, null],
    rejectsOnEncode: [{}, { code: "core/internal" }, null],
  },
};

/** Every check the drive performs: twenty-seven inputs on the way in, twenty-one values on the way out. */
const EXPECTED_CHECKS = 48;

/** The `parse` half of that — the twenty-seven decode-side inputs, which must still throw. */
const EXPECTED_PARSE_CHECKS = 27;

describe("no codec in this kit throws out of safeParse", () => {
  test("the walk finds every codec, so this gate is not vacuous", () => {
    const sites = codecSites();
    // Exact, not a floor. `toBeGreaterThan(0)` over a mistyped path is what passing looks like.
    expect(sites.length).toBe(EXPECTED_SITES);
    expect(sites).toEqual([...CODEC_SITES].sort());
  });

  test("and every one of them has a driver — none is skipped for being awkward", () => {
    expect(
      Object.keys(DRIVERS).sort(),
      "A codec added to the kit is driven here, or this gate is green over a population it does not cover.",
    ).toEqual(codecSites());
    for (const [name, driver] of Object.entries(DRIVERS)) {
      expect(driver.rejectsOnParse.length, `${name} has no input safeParse must refuse.`).toBeGreaterThan(0);
      expect(driver.rejectsOnEncode.length, `${name} has no value safeEncode must refuse.`).toBeGreaterThan(0);
    }
  });

  test("each refuses its bad values by returning, in both directions", () => {
    let checks = 0;
    for (const [name, driver] of Object.entries(DRIVERS)) {
      for (const input of driver.rejectsOnParse) {
        // The contract, stated twice on purpose. Not throwing is half of it; a codec that swallowed the
        // value and answered `success` would satisfy the first half and be a worse bug than the throw.
        expect(() => driver.codec.safeParse(input), `${name}.safeParse threw instead of returning.`).not.toThrow();
        expect(driver.codec.safeParse(input).success, `${name}.safeParse accepted a value it must refuse.`).toBe(false);
        checks++;
      }
      for (const value of driver.rejectsOnEncode) {
        expect(() => driver.codec.safeEncode(value), `${name}.safeEncode threw instead of returning.`).not.toThrow();
        expect(driver.codec.safeEncode(value).success, `${name}.safeEncode accepted a value it must refuse.`).toBe(
          false,
        );
        checks++;
      }
    }
    expect(checks).toBe(EXPECTED_CHECKS);
  });

  test("and `parse` still throws, because that is what `parse` is for", () => {
    // The half of the contract a fix could break by making everything lenient. A codec that stopped
    // throwing from `parse` would pass every assertion above.
    let checks = 0;
    for (const [name, driver] of Object.entries(DRIVERS)) {
      for (const input of driver.rejectsOnParse) {
        expect(() => driver.codec.parse(input), `${name}.parse stopped throwing.`).toThrow(z.ZodError);
        checks++;
      }
    }
    expect(checks).toBe(EXPECTED_PARSE_CHECKS);
  });
});
