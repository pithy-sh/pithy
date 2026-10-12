// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { main } from "../main";
import { NextKey } from "../terminal/nextSteps";
import { contractOf } from "./commandContract";
import { walkTree } from "./describe";

/**
 * **No payload can carry an empty `next`, and every command that can carry one is held to its condition (#697).**
 *
 * `next` is absent unless the run knows a follow-up is required, so an agent acts on every one it sees. The
 * half that can be checked across the whole tree is the published shape: every `next` any payload declares
 * is {@link NextKey}, which refuses `[]` — and every payload is parsed from a real run of its command
 * (`payloadCoverage.test.ts`), so a command writing `"next":[]` fails its own conformance test.
 *
 * **The emitters are named, so a new one cannot arrive without its condition.** Each one listed here has its
 * condition held both ways in `terminal/nextSteps.test.ts` and its line in its command's own test. A payload
 * that declares `next` and is not on this list fails below, which is the moment to write the other two.
 */
const EMITTERS = ["add", "deploy", "provision", "ui add", "upgrade"];

const nodes = await walkTree(main);

/** {@link NextKey} as a property of a payload's JSON Schema: the standalone document, less its `$schema`. */
const { $schema: _, ...NEXT_SHAPE } = z.toJSONSchema(NextKey, { io: "input" });

/** Every `next` property a JSON Schema declares, at the top or in any branch of a union. */
function nextProperties(schema: unknown): unknown[] {
  if (schema === null || typeof schema !== "object") return [];
  const node = schema as Record<string, unknown>;
  const found: unknown[] = [];
  const properties = node.properties as Record<string, unknown> | undefined;
  if (properties !== undefined && Object.hasOwn(properties, "next")) found.push(properties.next);
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[keyword];
    if (Array.isArray(branches)) for (const branch of branches) found.push(...nextProperties(branch));
  }
  return found;
}

/** Every command whose payload declares `next`, with each declaration. */
function declared(): Map<string, unknown[]> {
  const found = new Map<string, unknown[]>();
  for (const node of nodes) {
    const payload = contractOf(node.cmd)?.payload;
    if (payload === undefined) continue;
    const properties = nextProperties(z.toJSONSchema(payload, { io: "input" }));
    if (properties.length > 0) found.set(node.path.join(" "), properties);
  }
  return found;
}

describe("next, across every payload", () => {
  test("the commands that can carry next are the ones held to a condition, and no others", () => {
    expect([...declared().keys()].sort()).toEqual(EMITTERS);
  });

  test("every next any payload declares is the one shape, which refuses an empty list", () => {
    expect(NEXT_SHAPE).toMatchObject({ type: "array", minItems: 1 });
    for (const [path, properties] of declared()) {
      for (const property of properties) expect({ path, property }).toEqual({ path, property: NEXT_SHAPE });
    }
  });

  /** A planted defect: a payload whose `next` admits `[]` is not the shape, and the comparison above sees it. */
  test("a next that admits an empty list is told apart", () => {
    const lenient = z.object({ next: z.array(z.string().describe("A step.")).optional().describe("Steps.") });
    const [property] = nextProperties(z.toJSONSchema(lenient, { io: "input" }));
    expect(property).not.toEqual(NEXT_SHAPE);
  });
});
