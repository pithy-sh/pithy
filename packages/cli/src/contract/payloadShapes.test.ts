// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { main } from "../main";
import {
  breakingChanges,
  PAYLOAD_SHAPES_PATH,
  type PayloadShapes,
  payloadShapesOf,
  renderPayloadShapes,
  shapeOf,
} from "./payloadShapes";

/**
 * **A payload loses or retypes a key only with a `schemaVersion` bump (#697).**
 *
 * `schemaVersion` is a promise to a parser: the same number, the same keys of the same types, give or take
 * keys that are new. The promise is only as good as whatever notices a break, so every command's payload is
 * flattened to its keys and their types and committed beside the version it was at
 * (`payloadShapes.generated.json`). Against that file, a key removed or retyped while the version stood still
 * fails here and names the command to bump. An added key fails only the freshness check, which the writer
 * answers — and the writer refuses to record a break the version did not own up to.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** One command's shapes, as the snapshot holds them, for the planted defects. */
function snapshot(schemaVersion: number, payload: z.ZodType): PayloadShapes {
  return { commands: { probe: { schemaVersion, payload: shapeOf(payload) } } };
}

const Before = z
  .object({
    command: z.literal("probe").describe("Probe."),
    count: z.number().int().describe("How many."),
    rows: z.array(z.object({ name: z.string().describe("Its name.") }).describe("A row.")).describe("Rows."),
    note: z.string().nullable().optional().describe("A note."),
  })
  .describe("A probe.");

describe("shapeOf", () => {
  test("flattens a payload to every key and its type, nested and optional ones marked", () => {
    expect(shapeOf(Before)).toEqual({
      $: "object",
      "$.command": '"probe"',
      "$.count": "integer",
      "$.rows": "array",
      "$.rows[]": "object",
      "$.rows[].name": "string",
      "$.note": "null | string?",
    });
  });

  /**
   * **Each member of a union is its own shape**, at the path the union sits at, named by the literals that tell
   * it apart from the others. Merged into one path, a key one member dropped would be hidden by a member that
   * kept it, and a key only some members carry would read as always there.
   */
  test("a union keeps every member's keys apart, named by what tells the member apart, and a record its values", () => {
    const shape = shapeOf(
      z
        .union([
          z.object({ kind: z.literal("a").describe("A."), a: z.string().describe("A.") }).describe("One."),
          z
            .object({
              kind: z.literal("b").describe("B."),
              byName: z.record(z.string().describe("A name."), z.boolean().describe("Set.")).describe("By name."),
            })
            .describe("Two."),
        ])
        .describe("Either."),
    );
    expect(shape).toEqual({
      $: "object",
      '$<kind="a">.kind': '"a"',
      '$<kind="a">.a': "string",
      '$<kind="b">.kind': '"b"',
      '$<kind="b">.byName': "object",
      '$<kind="b">.byName{}': "boolean",
    });
  });

  test("members nothing tells apart are named by their place, and a literal they all share names none", () => {
    const shape = shapeOf(
      z
        .union([
          z.object({ command: z.literal("p").describe("P."), a: z.string().describe("A.") }).describe("One."),
          z.object({ command: z.literal("p").describe("P."), b: z.number().describe("B.") }).describe("Two."),
        ])
        .describe("Either."),
    );
    expect(shape).toEqual({
      $: "object",
      "$<#0>.command": '"p"',
      "$<#0>.a": "string",
      "$<#1>.command": '"p"',
      "$<#1>.b": "number",
    });
  });

  test("a nullable object is one shape, not a union of two", () => {
    const shape = shapeOf(
      z
        .object({
          row: z
            .object({ a: z.string().describe("A.") })
            .nullable()
            .describe("Row."),
        })
        .describe("R."),
    );
    expect(shape["$.row.a"]).toBe("string");
  });

  test("a fixed set of values is part of the type", () => {
    const shape = shapeOf(z.object({ state: z.enum(["ok", "failed"]).describe("State.") }).describe("S."));
    expect(shape["$.state"]).toBe('"failed" | "ok"');
  });
});

describe("breakingChanges", () => {
  test("an added key breaks nothing", () => {
    const after = Before.extend({ extra: z.boolean().describe("New.") }).describe("A probe.");
    expect(breakingChanges(snapshot(1, Before), snapshot(1, after))).toEqual([]);
  });

  test("a removed key, at any depth, breaks the version it was promised under", () => {
    const after = Before.extend({
      rows: z.array(z.object({}).describe("A row.")).describe("Rows."),
    }).describe("A probe.");
    expect(breakingChanges(snapshot(1, Before), snapshot(1, after))).toEqual([
      "probe: $.rows[].name was string and is gone. Bump its schemaVersion.",
    ]);
  });

  test("a retyped key breaks it, and so does a key that stopped being certain", () => {
    const after = Before.extend({
      count: z.string().describe("How many."),
      command: z.literal("probe").optional().describe("Probe."),
    }).describe("A probe.");
    expect(breakingChanges(snapshot(1, Before), snapshot(1, after))).toEqual([
      'probe: $.command was "probe" and is now "probe"?. Bump its schemaVersion.',
      "probe: $.count was integer and is now string. Bump its schemaVersion.",
    ]);
  });

  /**
   * **The planted defect a merged union hid (#697 review).** `x` is dropped from one member while the other
   * keeps it; flattened into one path, the key still looked present and required.
   */
  test("a key one member of a union dropped breaks it, though another member kept it", () => {
    const member = (kind: string, withX: boolean) =>
      z
        .object({
          kind: z.literal(kind).describe("Kind."),
          ...(withX ? { x: z.string().describe("X.") } : {}),
        })
        .describe("A member.");
    const before = z.union([member("a", true), member("b", true)]).describe("Either.");
    const after = z.union([member("a", false), member("b", true)]).describe("Either.");
    expect(breakingChanges(snapshot(1, before), snapshot(1, after))).toEqual([
      'probe: $<kind="a">.x was string and is gone. Bump its schemaVersion.',
    ]);
  });

  test("a key moved from one member of a union to another breaks it", () => {
    const before = z
      .union([
        z.object({ kind: z.literal("a").describe("A."), x: z.string().describe("X.") }).describe("One."),
        z.object({ kind: z.literal("b").describe("B.") }).describe("Two."),
      ])
      .describe("Either.");
    const after = z
      .union([
        z.object({ kind: z.literal("a").describe("A.") }).describe("One."),
        z.object({ kind: z.literal("b").describe("B."), x: z.string().describe("X.") }).describe("Two."),
      ])
      .describe("Either.");
    expect(breakingChanges(snapshot(1, before), snapshot(1, after))).toEqual([
      'probe: $<kind="a">.x was string and is gone. Bump its schemaVersion.',
    ]);
  });

  test("the same break under a bumped version is the bump doing its job", () => {
    const after = z.object({ command: z.literal("probe").describe("Probe.") }).describe("A probe.");
    expect(breakingChanges(snapshot(1, Before), snapshot(2, after))).toEqual([]);
  });

  test("a version only goes up", () => {
    expect(breakingChanges(snapshot(2, Before), snapshot(1, Before))).toEqual([
      "probe: schemaVersion went from 2 to 1. It only goes up.",
    ]);
  });

  test("a progress record is held to the same promise as the payload", () => {
    const record = z.object({ event: z.string().describe("E."), what: z.string().describe("W.") }).describe("R.");
    const before: PayloadShapes = {
      commands: { probe: { schemaVersion: 1, payload: shapeOf(Before), events: shapeOf(record) } },
    };
    const after: PayloadShapes = {
      commands: {
        probe: { schemaVersion: 1, payload: shapeOf(Before), events: shapeOf(record.omit({ what: true })) },
      },
    };
    expect(breakingChanges(before, after)).toEqual([
      "probe --events: $.what was string and is gone. Bump its schemaVersion.",
    ]);
  });
});

describe("the committed shapes", () => {
  const current = payloadShapesOf(main);
  const committed = readFileSync(join(REPO_ROOT, PAYLOAD_SHAPES_PATH), "utf8");

  test("cover every command with a payload, so the check has something to hold", async () => {
    expect(Object.keys((await current).commands).length).toBeGreaterThan(70);
  });

  test("no payload lost or retyped a key without a schemaVersion bump", async () => {
    expect(breakingChanges(JSON.parse(committed) as PayloadShapes, await current)).toEqual([]);
  });

  test("are current — run `bun run payload-shapes` to record an added key or a bump", async () => {
    expect(committed).toBe(renderPayloadShapes(await current));
  });
});
