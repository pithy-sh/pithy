// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { CapabilityManifest } from "./manifest";
import { manifestRecord } from "./manifestRecord";

/**
 * The probe: an object carrying an own `__proto__` key, built the way a manifest reaches a client.
 *
 * `JSON.parse` is load-bearing. A `{ __proto__: [...] }` literal sets the prototype and creates no own
 * key, so a test written with one would probe nothing and pass everywhere. The value is a legal array of
 * legal strings, so an unguarded record has no reason of its own to refuse it — the only thing that can
 * refuse it is a guard.
 */
function probe(): unknown {
  return JSON.parse('{"__proto__":["deployments:write"]}');
}

describe("manifestRecord", () => {
  test("refuses a record stating a key that would not survive the parse", () => {
    const guarded = manifestRecord(z.partialRecord(z.string(), z.array(z.string())));
    expect(guarded.safeParse(probe()).success).toBe(false);
  });

  test("leaves every key that does survive alone", () => {
    const guarded = manifestRecord(z.partialRecord(z.string(), z.array(z.string())));
    const stated = JSON.parse('{"cloudflare":["secrets:read"],"constructor":["x"],"toString":["y"]}') as unknown;
    expect(guarded.parse(stated)).toEqual({
      cloudflare: ["secrets:read"],
      constructor: ["x"],
      toString: ["y"],
    });
  });

  test("an inherited `__proto__` is not a stated key", () => {
    // Every object has one. Only an own property is something a manifest wrote, and refusing on the
    // inherited name would refuse every record there is.
    const guarded = manifestRecord(z.partialRecord(z.string(), z.array(z.string())));
    expect(guarded.parse({ cloudflare: ["secrets:read"] })).toEqual({ cloudflare: ["secrets:read"] });
  });

  test("the record behind the guard still owns its own key rule", () => {
    const guarded = manifestRecord(z.partialRecord(z.string().regex(/^[a-z]+$/), z.array(z.string())));
    expect(guarded.safeParse({ "Not Lower": ["x"] }).success).toBe(false);
  });
});

/**
 * The gate.
 *
 * #331 was one field. The exposure is not: it belongs to the shape, so every record a manifest may state
 * has it, and the fix that lives at one call site is how this codebase has repeatedly closed a hole and
 * left its siblings open. Enumerating today's records is what would produce the next miss, so this does
 * not enumerate them.
 *
 * It walks `CapabilityManifest` instead and **attacks** every record it finds with a key that vanishes.
 * A record added to the manifest without the guard fails this test on the commit that adds it, wherever
 * it sits and whatever it is called. Nothing here reads a marker the guard sets, and nothing asserts a
 * structure: the only question asked of a site is whether it lets the key through.
 *
 * **What it cannot see, said out loud.** The probe separates guarded from unguarded by whether the site
 * accepts an object that projects to `{}` — which is every record the manifest has, and would not be a
 * record that refused an empty object for its own reasons. Such a record would pass here without a guard.
 * The floor test below names today's sites for exactly that reason: a site that stops appearing, or one
 * whose refusal has nothing to do with the key, is a thing a reader can still notice.
 */
describe("every record a manifest may state refuses a key that would vanish", () => {
  /** A Zod node, as much of one as the walk needs. Zod's own types do not describe a schema generically. */
  interface ZodNode {
    readonly _zod?: { readonly def?: Record<string, unknown> };
  }

  /** A record found in the manifest: where it sits, and the schema the field holding it actually is. */
  interface RecordSite {
    path: string;
    attack: z.ZodType;
  }

  function isNode(value: unknown): value is ZodNode {
    return typeof value === "object" && value !== null;
  }

  /**
   * Every record under a schema, by path, each paired with the node to attack.
   *
   * The node to attack is not the record — it is the schema sitting at the last *structural* entry above
   * it: an object's field, an array's element, a record's value. A guard wraps the record, so attacking
   * the record itself would report every guarded site as unguarded. Wrappers between the two (a pipe, a
   * union, `lazy`, `optional`, `default`, `describe`) leave the attack node where it was, which is what
   * makes the walk indifferent to how a guard is spelled — it is the field's own schema being attacked,
   * exactly as a manifest hits it.
   *
   * `seen` bounds the recursion `ConfigOptionValue` introduces: that union refers to itself.
   */
  function recordSites(schema: unknown, path: string, attack: z.ZodType, seen: Set<unknown>): RecordSite[] {
    if (!isNode(schema) || seen.has(schema)) return [];
    seen.add(schema);
    const def = schema._zod?.def;
    if (!def) return [];
    const here = path === "" ? "<root>" : path;
    const descend = (child: unknown, childPath: string): RecordSite[] => recordSites(child, childPath, attack, seen);
    switch (def.type) {
      case "record": {
        const value = def.valueType as z.ZodType;
        return [{ path: here, attack }, ...recordSites(value, `${path}{value}`, value, seen)];
      }
      case "object": {
        const shape = def.shape as Record<string, unknown>;
        return Object.entries(shape).flatMap(([key, field]) =>
          recordSites(field, path === "" ? key : `${path}.${key}`, field as z.ZodType, seen),
        );
      }
      case "array": {
        const element = def.element as z.ZodType;
        return recordSites(element, `${path}[]`, element, seen);
      }
      case "union":
        return (def.options as unknown[]).flatMap((option, index) => descend(option, `${path}|${index}`));
      case "pipe":
        return [...descend(def.in, path), ...descend(def.out, path)];
      case "lazy":
        return descend((def.getter as () => unknown)(), path);
      case "optional":
      case "nullable":
      case "readonly":
      case "nonoptional":
      case "prefault":
      case "default":
        return descend(def.innerType, path);
      default:
        return [];
    }
  }

  const sites = recordSites(CapabilityManifest, "", CapabilityManifest, new Set());

  test("the walk reaches both records the manifest has today", () => {
    // Guards against a walk that stops early and passes vacuously. Both are records read out of
    // `node_modules`: one keyed by issuer, one an option default the CLI writes into `pithy.config.ts`.
    const paths = sites.map((site) => site.path);
    expect(paths.some((path) => path.startsWith("secrets[].origin") && path.endsWith("needs"))).toBe(true);
    expect(paths.some((path) => path.startsWith("configOptions[].default"))).toBe(true);
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  test("no record a manifest may state lets the key through", () => {
    const leaky = sites
      .filter((site) => {
        const result = site.attack.safeParse(probe());
        return result.success;
      })
      .map((site) => site.path);
    expect(
      leaky,
      `${leaky.join(", ")} accepts a manifest stating "__proto__" and returns without it. The key raises no issue and is not in the result, so nothing downstream can tell it was written. Wrap the record in manifestRecord().`,
    ).toEqual([]);
  });

  test("the gate bites — the same record without its guard fails it", () => {
    // The control, and the reason the test above is not passing because the probe is inert. This is the
    // `needs` record exactly as it was written before #331, attacked with the same input.
    const unguarded = z.partialRecord(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
      z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/)),
    );
    const result = unguarded.safeParse(probe());
    expect(result.success).toBe(true);
    expect(result.success && Object.keys(result.data)).toEqual([]);
  });
});
