// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { main } from "../main";
import { OffersKey } from "../terminal/nextSteps";
import { contractOf } from "./commandContract";
import { walkTree } from "./describe";

/**
 * **`offers` is `next`'s optional sibling, held the same way across every payload (#757).**
 *
 * `next` is only what a run left required, so an agent acts on each one. `offers` is what a run found worth
 * putting to the person and did not require: an agent asks before it runs one. Mixing them would break both
 * promises, so they are two keys with one shape, and the same two checks hold `offers` that hold `next` in
 * `nextKeys.test.ts`: every emitter is named here, and every declaration is {@link OffersKey}, which refuses `[]`.
 */
const EMITTERS = ["deploy"];

const nodes = await walkTree(main);

const { $schema: _, ...OFFERS_SHAPE } = z.toJSONSchema(OffersKey, { io: "input" });

/** Every `offers` property a JSON Schema declares, at the top or in any branch of a union. */
function offersProperties(schema: unknown): unknown[] {
  if (schema === null || typeof schema !== "object") return [];
  const node = schema as Record<string, unknown>;
  const found: unknown[] = [];
  const properties = node.properties as Record<string, unknown> | undefined;
  if (properties !== undefined && Object.hasOwn(properties, "offers")) found.push(properties.offers);
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[keyword];
    if (Array.isArray(branches)) for (const branch of branches) found.push(...offersProperties(branch));
  }
  return found;
}

function declared(): Map<string, unknown[]> {
  const found = new Map<string, unknown[]>();
  for (const node of nodes) {
    const payload = contractOf(node.cmd)?.payload;
    if (payload === undefined) continue;
    const properties = offersProperties(z.toJSONSchema(payload, { io: "input" }));
    if (properties.length > 0) found.set(node.path.join(" "), properties);
  }
  return found;
}

describe("offers, across every payload", () => {
  test("the commands that can carry offers are the ones held to a condition, and no others", () => {
    expect([...declared().keys()].sort()).toEqual(EMITTERS);
  });

  test("every offers any payload declares is the one shape, which refuses an empty list", () => {
    expect(OFFERS_SHAPE).toMatchObject({ type: "array", minItems: 1 });
    for (const [path, properties] of declared()) {
      for (const property of properties) expect({ path, property }).toEqual({ path, property: OFFERS_SHAPE });
    }
  });
});
