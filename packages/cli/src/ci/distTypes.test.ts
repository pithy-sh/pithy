// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { afterAll, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  auditCensus,
  auditCoverage,
  CENSUS,
  compile,
  explainDiagnostics,
  fieldName,
  renderCanary,
  renderFixture,
  renderTable,
  type SchemaKey,
  type ShippedTable,
  SIDES,
  type Side,
  schemaKeys,
  UNASSERTED,
  unasserted,
  writeProgram,
} from "./distTypes";
import { readSource } from "./sourceFiles";

/**
 * **The gate's own blind spots, held open where a reader can see them.**
 *
 * `distTypes.ts` writes four assertions per side per table, and each one has an edge it cannot reach. A
 * field it can find no refused value for gets a shape and nothing else — its type could degrade to `any`
 * in a shipped `.d.ts` and the gate would stay green. That was true of **22 of 464 required fields**, and
 * the module said so only as a category, which is the part that mattered: "a field whose side admits
 * everything" does not let a reader check the field they came about, and the category turned out to be
 * *every boolean column in the kit* rather than the edge case it read as.
 *
 * Twenty-one of the twenty-two were one cause — `SQLiteBoolean` decodes from `0 | 1 | boolean | string`,
 * so a number, a string and a boolean are all fine by it — and `null` closes every one of them. The
 * twenty-second, `sqliteJson(z.unknown())`, is `unknown` on both sides and cannot be closed at all.
 *
 * So this suite asserts what the four assertions are made of: the value chosen per column shape **per
 * side**, because a codec refuses different values going in and coming back; the values a side must still
 * accept, which is what catches a narrowing rather than a widening; and that {@link UNASSERTED} is a list
 * of *fields* which the module's own docstring repeats verbatim. The populations themselves —
 * {@link auditCensus} and {@link auditCoverage} — are checked inside `bun run dist-types`, which runs
 * after `Build` because it reads the built tree; what is unit-testable here is what those checks are made
 * of.
 */

/** One key's facts on one side, from a one-column table. `schemaKeys` needs nothing else. */
function keyOf(column: z.ZodType, side: Side = "input"): SchemaKey {
  // The parameter type keeps call sites honest; the cast is the structural view distTypes.ts reads.
  const [key] = schemaKeys(z.object({ column }) as never, side);
  if (key === undefined) throw new Error("The one-column table produced no key at all.");
  return key;
}

/** The literal chosen for one field of a one-column table, on one side. */
function rejectionFor(column: z.ZodType, side: Side = "input"): string | null {
  return keyOf(column, side).rejected;
}

/** One key, minimal, for the assertions that are about the program rather than the schema. */
function key(overrides: Partial<SchemaKey> = {}): SchemaKey {
  return {
    field: "id",
    present: true,
    rejected: '"pithy"',
    because: "the id column does not take a string",
    admits: [],
    known: true,
    ...overrides,
  };
}

/** A shipped table, minimal, carrying the same one key on both sides. */
function table(overrides: Partial<ShippedTable> = {}): ShippedTable {
  return {
    package: "@pithy-sh/example",
    table: "pithyExampleThings",
    specifier: "@pithy-sh/example/src/data/thing",
    schema: "ExampleThing",
    keys: { input: [key()], output: [key()] },
    ...overrides,
  };
}

/** The same keys on both sides, for a table whose sides are not the point of the assertion. */
function bothSides(keys: readonly SchemaKey[]): ShippedTable["keys"] {
  return { input: keys, output: keys };
}

describe("the value a column refuses", () => {
  test("a string column refuses a number", () => {
    expect(rejectionFor(z.string())).toBe("42");
  });

  test("a number column refuses a string", () => {
    expect(rejectionFor(z.number())).toBe('"pithy"');
  });

  test("a date column refuses a boolean going in, because its row side takes both a number and a string", () => {
    // SQLiteDate decodes from `number | string | Date`, so the first two candidates are admitted.
    expect(rejectionFor(SQLiteDate, "input")).toBe("true");
  });

  test("the same date column refuses a number coming back — the two sides are different types", () => {
    // `z.output` is a `Date`. Reading one side told this gate nothing about the other, which is how a
    // degraded output stayed green: 42 is refused here and admitted by the row side above.
    expect(rejectionFor(SQLiteDate, "output")).toBe("42");
  });

  test("a boolean column refuses null going in — the twenty-one this closed", () => {
    // SQLiteBoolean decodes from `0 | 1 | boolean | string`: every scalar candidate is admitted, and
    // under strictNullChecks null is assignable to nothing but null, any and unknown.
    expect(rejectionFor(SQLiteBoolean, "input")).toBe("null");
  });

  test("the same boolean column refuses a number coming back", () => {
    expect(rejectionFor(SQLiteBoolean, "output")).toBe("42");
  });

  test("a column that admits every scalar and null refuses an object", () => {
    expect(rejectionFor(z.union([z.string(), z.number(), z.boolean(), z.null()]))).toBe("{}");
  });

  test("a column that admits an object too refuses an array", () => {
    const column = z.union([z.string(), z.number(), z.boolean(), z.null(), z.object({ at: z.string() })]);
    expect(rejectionFor(column)).toBe("[]");
  });

  test("a column whose sides are both unknown refuses nothing, on either side", () => {
    // The exemption is a fact about the schema, not an oversight in the walk: `unknown` accepts every
    // value there is, so `any` accepts strictly nothing more and the degradation has no witness.
    expect(rejectionFor(sqliteJson(z.unknown()), "input")).toBeNull();
    expect(rejectionFor(sqliteJson(z.unknown()), "output")).toBeNull();
  });

  test("the sentence is about a column going in and about a read coming back", () => {
    expect(schemaKeys(z.object({ archived: SQLiteBoolean }) as never, "input")[0]?.because).toBe(
      "the archived column does not take null",
    );
    expect(schemaKeys(z.object({ archived: SQLiteBoolean }) as never, "output")[0]?.because).toBe(
      "archived does not read back as a number",
    );
  });
});

describe("whether a side requires the key", () => {
  test("an optional key is walked, and marked absent from the shape", () => {
    // It is walked because its *type* still degrades — the failure the shape cannot see, since a minimal
    // shape omits the key by construction.
    const keys = schemaKeys(z.object({ id: z.string(), note: z.string().optional() }) as never, "input");
    expect(keys.map((one) => [one.field, one.present])).toEqual([
      ["id", true],
      ["note", false],
    ]);
    expect(keys[1]?.rejected).toBe("42");
  });

  test("a default is optional going in and required coming back", () => {
    // `optin` and `optout` are separate facts, and this is the field that proves the walk reads both.
    expect(keyOf(z.string().default("x"), "input").present).toBe(false);
    expect(keyOf(z.string().default("x"), "output").present).toBe(true);
  });

  test("a side whose kinds are unknown cannot assert an omission either", () => {
    // `unknown` accepts `undefined` as happily as anything else, so the directive would go unused.
    expect(keyOf(sqliteJson(z.unknown())).known).toBe(false);
    expect(keyOf(z.string()).known).toBe(true);
  });
});

describe("the values a side must still accept", () => {
  test("a nullable column must still take null", () => {
    expect(keyOf(z.string().nullable()).admits).toEqual(["null"]);
  });

  test("an enum must still take every arm", () => {
    expect(keyOf(z.enum(["marketing", "transactional"])).admits).toEqual(['"marketing"', '"transactional"']);
  });

  test("a plain string column has nothing it must still accept", () => {
    // Nothing narrows it, so there is nothing an acceptance line could say. The refusal lines cover it.
    expect(keyOf(z.string()).admits).toEqual([]);
  });

  test("a nullish codec carries null through the wrappers", () => {
    expect(keyOf(SQLiteDate.nullish()).admits).toEqual(["null"]);
  });

  test("a codec's arms are read from the side being walked", () => {
    const column = sqliteJson(z.enum(["a", "b"]));
    // Going in the column is `string | "a" | "b"`; coming back it is the enum alone. Both must keep both
    // arms, and a declaration that shipped one of them is a narrowing nothing else here would report.
    expect(keyOf(column, "input").admits).toEqual(['"a"', '"b"']);
    expect(keyOf(column, "output").admits).toEqual(['"a"', '"b"']);
  });

  test("a bigint arm is skipped, because `1n` is not what JSON.stringify writes", () => {
    expect(keyOf(z.literal(1n)).admits).toEqual([]);
  });
});

describe("the uncovered list", () => {
  test("names a field and a side, not a category", () => {
    const rows = [
      table({ keys: { input: [key({ field: "state", rejected: null })], output: [key({ field: "state" })] } }),
      table({ package: "@pithy-sh/other", table: "pithyOtherRows" }),
    ];
    expect(unasserted(rows)).toEqual(["@pithy-sh/example · pithyExampleThings.state (input)"]);
  });

  test("the side is part of it, because coverage is per side", () => {
    // A codec can be assertable going into SQLite and unassertable coming back. An entry naming only the
    // field would hide whichever half was still covered.
    const rows = [table({ keys: bothSides([key({ field: "state", rejected: null })]) })];
    expect(unasserted(rows)).toEqual([
      "@pithy-sh/example · pithyExampleThings.state (input)",
      "@pithy-sh/example · pithyExampleThings.state (output)",
    ]);
  });

  test("is sorted, so the comparison is against a set and not a walk order", () => {
    const rows = [
      table({ table: "zeta", keys: { input: [key({ field: "a", rejected: null })], output: [] } }),
      table({ table: "alpha", keys: { input: [key({ field: "a", rejected: null })], output: [] } }),
    ];
    expect(unasserted(rows)).toEqual(["@pithy-sh/example · alpha.a (input)", "@pithy-sh/example · zeta.a (input)"]);
  });

  test("every declared entry is spelled `<package> · <table>.<field> (<side>)`", () => {
    for (const entry of UNASSERTED)
      expect(entry).toMatch(/^@pithy-sh\/[a-z-]+ · [A-Za-z]+\.[A-Za-z]+ \((input|output)\)$/);
  });

  test("the report and the list are the same spelling, so a failure pastes straight in", () => {
    expect(fieldName({ package: "@pithy-sh/rating", table: "pithyRatingRatings" }, "state", "input")).toBe(
      UNASSERTED[0],
    );
  });

  test("every declared entry is named in the module's own docstring", () => {
    // The reviewer's finding was that the docstring read as though every required field were covered. A
    // reader checks the field they care about by searching this file for it, so each exemption has to be
    // written out where they will look — not summarized as a shape.
    const source = readSource(join(dirname(fileURLToPath(import.meta.url)), "distTypes.ts"));
    expect(source).not.toBeNull();
    for (const entry of UNASSERTED) expect(source).toContain(entry);
  });
});

describe("the population is held to that list exactly", () => {
  test("a field with no refused value that nobody named is a failure", () => {
    const rows = [table({ keys: { input: [key({ field: "blob", rejected: null })], output: [] } })];
    expect(() => auditCoverage(rows)).toThrow(/@pithy-sh\/example · pithyExampleThings\.blob \(input\)/);
    expect(() => auditCoverage(rows)).toThrow(/no refused value and no entry in UNASSERTED/);
  });

  test("the failure says what to do about it", () => {
    const rows = [table({ keys: { input: [key({ field: "blob", rejected: null })], output: [] } })];
    expect(() => auditCoverage(rows)).toThrow(/degrading to `any` would pass here|degrading to .any. would pass here/);
  });

  test("a named field that has since become assertable is also a failure", () => {
    // The other direction, so the list cannot decay into an allowlist nobody rereads.
    expect(() => auditCoverage([table()])).toThrow(/named in UNASSERTED now refuse a value/);
    expect(() => auditCoverage([table()])).toThrow(new RegExp(UNASSERTED[0]?.replaceAll(/[()]/g, "\\$&") ?? "", "u"));
  });

  test("a population that matches the list passes", () => {
    const rows = UNASSERTED.map((entry) => {
      const [name = "", rest = ""] = entry.split(" · ");
      const [tableName = "", tail = ""] = rest.split(".");
      const [field = "", side = ""] = tail.replace(")", "").split(" (");
      const only = key({ field, rejected: null });
      const empty: readonly SchemaKey[] = [];
      return table({
        package: name,
        table: tableName,
        keys: side === "input" ? { input: [only], output: empty } : { input: empty, output: [only] },
      });
    });
    expect(() => auditCoverage(rows)).not.toThrow();
  });
});

describe("the census is exact, in both directions", () => {
  /** A population of the declared size: one table per package until the packages run out. */
  function population(tables: number, packages: number): ShippedTable[] {
    return Array.from({ length: tables }, (_, index) =>
      table({ package: `@pithy-sh/p${Math.min(index, packages - 1)}`, table: `t${index}` }),
    );
  }

  test("the measured tree passes", () => {
    expect(() => auditCensus(population(CENSUS.tables, CENSUS.packages))).not.toThrow();
  });

  test("a table that went missing fails, which a 95% floor did not", () => {
    // Dropping `pithyLeaderboardEntries` from the shipped `leaderboardTables()` left 45 in 16, cleared a
    // floor of 43 in 15, and exited 0. A floor that survives losing a table is not doing the job.
    expect(() => auditCensus(population(CENSUS.tables - 1, CENSUS.packages))).toThrow(
      new RegExp(`found ${CENSUS.tables - 1} tables in ${CENSUS.packages} packages`),
    );
  });

  test("a table that arrived fails too, until somebody updates the number deliberately", () => {
    expect(() => auditCensus(population(CENSUS.tables + 1, CENSUS.packages))).toThrow(/update CENSUS/);
  });

  test("a package that went missing fails on its own count", () => {
    expect(() => auditCensus(population(CENSUS.tables, CENSUS.packages - 1))).toThrow(
      new RegExp(`in ${CENSUS.packages - 1} packages`),
    );
  });
});

describe("the generated program", () => {
  test("writes both sides, from each side's own keys", () => {
    const rendered = renderTable(
      table({
        keys: {
          input: [key({ field: "sendAt", rejected: "true", because: "the sendAt column does not take a boolean" })],
          output: [key({ field: "sendAt", rejected: "42", because: "sendAt does not read back as a number" })],
        },
      }),
    );
    expect(rendered).toContain("const shape_input_pithyExampleThings: z.input<typeof ExampleThing> = {");
    expect(rendered).toContain("const shape_output_pithyExampleThings: z.output<typeof ExampleThing> = {");
    expect(rendered).toContain(
      'const no_input_pithyExampleThings_sendAt: z.input<typeof ExampleThing>["sendAt"] = true;',
    );
    expect(rendered).toContain(
      'const no_output_pithyExampleThings_sendAt: z.output<typeof ExampleThing>["sendAt"] = 42;',
    );
  });

  test("SIDES is the order a block reads: write, then read", () => {
    expect(SIDES).toEqual(["input", "output"]);
    const lines = renderTable(table()).split("\n");
    expect(lines.findIndex((line) => line.includes("shape_input_"))).toBeLessThan(
      lines.findIndex((line) => line.includes("shape_output_")),
    );
  });

  test("writes one refusal per field that refuses something, and none for one that does not", () => {
    const rendered = renderTable(
      table({
        keys: {
          input: [key(), key({ field: "state", present: false, rejected: null, known: false })],
          output: [],
        },
      }),
    );
    expect(rendered).toContain('"id": cell(),');
    // The optional key is absent from the shape by construction — that is what makes the shape minimal.
    expect(rendered).not.toContain('"state": cell(),');
    expect(rendered).not.toContain("_state:");
  });

  test("an optional key still gets its own refusal line, which the shape cannot give it", () => {
    const rendered = renderTable(
      table({ keys: { input: [key({ field: "batchId", present: false, rejected: "42" })], output: [] } }),
    );
    expect(rendered).not.toContain('"batchId": cell(),');
    expect(rendered).toContain(
      'const no_input_pithyExampleThings_batchId: z.input<typeof ExampleThing>["batchId"] = 42;',
    );
  });

  test("a required key refuses undefined; an optional one is not asked to", () => {
    const required = renderTable(table({ keys: { input: [key()], output: [] } }));
    expect(required).toContain(
      'const gone_input_pithyExampleThings_id: z.input<typeof ExampleThing>["id"] = undefined;',
    );
    const optional = renderTable(table({ keys: { input: [key({ present: false })], output: [] } }));
    expect(optional).not.toContain("gone_input_");
  });

  test("a required key whose kinds are unknown is not asked to refuse undefined either", () => {
    const rendered = renderTable(table({ keys: { input: [key({ known: false, rejected: null })], output: [] } }));
    expect(rendered).not.toContain("gone_input_");
  });

  test("an acceptance line carries no directive, because it asserts an absence of error", () => {
    const rendered = renderTable(table({ keys: { input: [key({ admits: ["null", '"marketing"'] })], output: [] } }));
    const lines = rendered.split("\n");
    const first = lines.findIndex((line) => line.startsWith("const ok0_input_"));
    expect(lines[first]).toBe('const ok0_input_pithyExampleThings_id: z.input<typeof ExampleThing>["id"] = null;');
    expect(lines[first + 1]).toBe(
      'const ok1_input_pithyExampleThings_id: z.input<typeof ExampleThing>["id"] = "marketing";',
    );
    expect(lines[first - 1]?.startsWith("// @ts-expect-error")).toBe(false);
  });

  test("each directive and its assignment are one line, because a directive suppresses only the next", () => {
    const lines = renderTable(table()).split("\n");
    for (const [offset, line] of lines.entries()) {
      if (!line.startsWith("// @ts-expect-error")) continue;
      expect(lines[offset + 1]).toMatch(/^const (no|gone)_/);
      expect(lines[offset + 1]?.endsWith(";")).toBe(true);
    }
  });

  test("the canary refuses to be written for a table with no required key", () => {
    expect(() => renderCanary(table({ keys: { input: [key({ present: false })], output: [] } }))).toThrow(
      /no required key/,
    );
  });

  test("the canary refuses to be written for a table that refuses nothing", () => {
    // It proves TS2322 by assigning a value the declaration refuses, so it needs one.
    expect(() => renderCanary(table({ keys: { input: [key({ rejected: null })], output: [] } }))).toThrow(
      /refuses no value/,
    );
  });

  test("the canary is indexed too, so the run that proves the codes proves the mapping", () => {
    const canary = renderCanary(table());
    const lines = canary.source.split("\n");
    const shape = lines.findIndex((line) => line.startsWith("const shape:")) + 1;
    const directive = lines.findIndex((line) => line.startsWith("// @ts-expect-error")) + 1;
    const refused = lines.findIndex((line) => line.startsWith("const refused:")) + 1;
    expect(canary.origins.get(shape)?.table).toBe("pithyExampleThings");
    expect(canary.origins.get(directive)?.key?.field).toBe("id");
    expect(canary.origins.get(refused)?.assertion).toBe("acceptance");
  });
});

/**
 * **A failure that names a line in a temp file is a failure nobody can act on.**
 *
 * `tsc` reports `rows.ts(416,7)`, in a program under `$TMPDIR` that is gone by the time the CI log is
 * read, and names neither the package, the table, the side, nor the field. So the generator records what
 * each line asserts as it writes it, and the report resolves the line number back — the same defect class
 * this repository keeps closing, an action line that cannot be followed.
 *
 * All three failure shapes need it and they need different halves. A `TS2578` sits on a refusal line,
 * which knows its field, its literal and why that literal is refused. A `TS2741` sits on a shape's
 * declaration, which knows the table but not the key — only the compiler's message names that. A `TS2322`
 * sits on an acceptance line, which knows what the schema still admits.
 */
describe("the report names the field and the side", () => {
  test("a diagnostic on a refusal line resolves to that field; one on the shape line to the table", () => {
    const fixture = renderFixture([table()]);
    const lines = fixture.source.split("\n");
    const shape = lines.findIndex((line) => line.startsWith("const shape_input_pithyExampleThings")) + 1;
    const directive = lines.findIndex((line) => line.startsWith("// @ts-expect-error")) + 1;
    expect(fixture.origins.get(shape)).toEqual({
      package: "@pithy-sh/example",
      table: "pithyExampleThings",
      side: "input",
      assertion: "shape",
      key: null,
    });
    expect(fixture.origins.get(directive)?.key?.field).toBe("id");
  });

  test("every indexed line is the line it describes", () => {
    const fixture = renderFixture([table(), table({ package: "@pithy-sh/other", table: "pithyOtherRows" })]);
    const lines = fixture.source.split("\n");
    expect(fixture.origins.size).toBeGreaterThan(0);
    for (const [number, origin] of fixture.origins) {
      const text = lines[number - 1] ?? "";
      if (origin.key === null) expect(text).toMatch(/^const shape_|^};$/);
      else expect(text).toContain(origin.key.field);
    }
  });

  test("a missing key takes its field from the message, because the shape line cannot name it", () => {
    const fixture = renderFixture([table()]);
    const shape = fixture.source.split("\n").findIndex((line) => line.startsWith("const shape_input_")) + 1;
    const raw = `rows.ts(${shape},7): error TS2741: Property 'locale' is missing in type '{ id: any; }'.`;
    expect(explainDiagnostics(raw, fixture.origins)).toBe(
      [
        "@pithy-sh/example · pithyExampleThings.locale (input) — required by the shipped declaration's input side, optional in the schema beside it.",
        `  ${raw}`,
      ].join("\n"),
    );
  });

  test("an unused directive on a presence line reads differently from one on a refusal line", () => {
    const fixture = renderFixture([table()]);
    const lines = fixture.source.split("\n");
    const refusal = lines.findIndex((line) => line.startsWith("const no_input_")) + 1;
    const presence = lines.findIndex((line) => line.startsWith("const gone_input_")) + 1;
    const at = (line: number) => `rows.ts(${line},1): error TS2578: Unused '@ts-expect-error' directive.`;
    expect(explainDiagnostics(at(refusal - 1), fixture.origins)).toContain(
      'the shipped declaration\'s input side accepts "pithy", though the id column does not take a string.',
    );
    expect(explainDiagnostics(at(presence - 1), fixture.origins)).toContain(
      "the shipped declaration lets id be undefined on the input side, though the schema requires it.",
    );
  });

  test("a line it cannot place passes through untouched", () => {
    // A report that swallowed what it did not understand would be this same defect one layer up.
    const raw = "error TS5083: Cannot read file 'tsconfig.json'.";
    expect(explainDiagnostics(raw, new Map())).toBe(raw);
  });
});

/**
 * This package's own `node_modules`: the TypeScript the gate compiles with, and the zod it resolves.
 *
 * Not the repository root. Everything the compile below needs is inside `packages/cli`, and reaching it
 * from here is what keeps this suite package-scoped — a climb to the root would make it a cross-package
 * read, and `turboInputs.test.ts` holds this directory's register to which of its gates are which.
 */
const MODULES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules");

/** Everything one degraded-package run wrote, removed whether it passed or failed. */
const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/**
 * A package that is not this repository's, shipping one declaration degraded three ways at once.
 *
 * `id` is `z.ZodAny` — the #523 shape, a field whose type is gone — so both sides read it as `any` and it
 * stops refusing the value the refusal line hands it. `note` is required in the declaration and absent
 * from the walk's keys, which is what an optional field looks like once its type degrades. `tag` is a
 * plain `z.ZodString` where the walk found something nullable, which is a narrowing: it still refuses
 * everything it used to, so only an acceptance line reports it. One compile, all three diagnostics, from
 * the real compiler under the settings the gate uses — the line numbers the index is read against have to
 * come from `tsc` rather than from an assumption about `tsc`.
 */
function degradedPackage(): string {
  const base = mkdtempSync(join(tmpdir(), "pithy-dist-types-report-"));
  scratch.push(base);
  const modules = join(base, "node_modules");
  const distribution = join(modules, "@pithy-sh", "fake", "dist", "data");
  mkdirSync(distribution, { recursive: true });
  symlinkSync(join(MODULES, "zod"), join(modules, "zod"), "dir");
  writeFileSync(
    join(modules, "@pithy-sh", "fake", "package.json"),
    `${JSON.stringify(
      {
        name: "@pithy-sh/fake",
        type: "module",
        exports: { "./src/*": { types: "./dist/*.d.ts", default: "./dist/*.js" } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(distribution, "thing.d.ts"),
    [
      'import type { z } from "zod";',
      "export declare const FakeThing: z.ZodObject<{ id: z.ZodAny; note: z.ZodString; tag: z.ZodString }>;",
      "",
    ].join("\n"),
  );
  return base;
}

/** What the walk found beside that declaration, before it degraded. */
function fakeTable(): ShippedTable {
  return {
    package: "@pithy-sh/fake",
    table: "pithyFakeThings",
    specifier: "@pithy-sh/fake/src/data/thing",
    schema: "FakeThing",
    keys: bothSides([
      key({ field: "id", rejected: "42", because: "the id column does not take a number" }),
      key({ field: "tag", rejected: "42", because: "the tag column does not take a number", admits: ["null"] }),
    ]),
  };
}

describe("a degraded declaration, compiled", () => {
  test("the report names the package, the table, the side and the field for all three failure shapes", () => {
    const base = degradedPackage();
    const fixture = renderFixture([fakeTable()]);
    const program = join(base, "rows");
    writeProgram(program, "rows.ts", fixture.source);
    const compiled = compile(join(MODULES, ".bin", "tsc"), program);
    expect(compiled.clean).toBe(false);

    const report = explainDiagnostics(compiled.output, fixture.origins);
    expect(report).toContain(
      "@pithy-sh/fake · pithyFakeThings.note (input) — required by the shipped declaration's input side, optional in the schema beside it.",
    );
    expect(report).toContain(
      "@pithy-sh/fake · pithyFakeThings.id (input) — the shipped declaration's input side accepts 42, though the id column does not take a number.",
    );
    expect(report).toContain(
      "@pithy-sh/fake · pithyFakeThings.tag (input) — the shipped declaration's input side refuses a value tag still admits (null).",
    );
    // And the whole thing again for the read side, which is the half that was not being read at all.
    expect(report).toContain(
      "@pithy-sh/fake · pithyFakeThings.note (output) — required by the shipped declaration's output side, optional in the schema beside it.",
    );
  });

  test("the compiler's own words survive verbatim beside the explanation", () => {
    const base = degradedPackage();
    const fixture = renderFixture([fakeTable()]);
    const program = join(base, "rows");
    writeProgram(program, "rows.ts", fixture.source);
    const compiled = compile(join(MODULES, ".bin", "tsc"), program);
    const report = explainDiagnostics(compiled.output, fixture.origins);
    for (const line of compiled.output.split("\n")) expect(report).toContain(line);
    expect(report).toMatch(/error TS2741: Property 'note' is missing/);
    expect(report).toMatch(/error TS2578: Unused '@ts-expect-error' directive/);
    expect(report).toMatch(/error TS2322: Type 'null' is not assignable to type 'string'/);
  });
});
