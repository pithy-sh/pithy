// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ClientProjection } from "./client";
import { CapabilityManifest } from "./manifest";
import { manifestRecord, refusesVanishingKey, statesNoVanishingKey } from "./vanishingKey";

/**
 * The probe: an object carrying an own `__proto__` key, built the way a payload reaches a client.
 *
 * `JSON.parse` is load-bearing. A `{ __proto__: [...] }` literal sets the prototype and creates no own
 * key, so a test written with one would probe nothing and pass everywhere. The value is a legal array of
 * legal strings, so an unguarded record has no reason of its own to refuse it — the only thing that can
 * refuse it is a guard.
 */
function probe(): unknown {
  return JSON.parse('{"__proto__":["deployments:write"]}');
}

describe("refusesVanishingKey", () => {
  test("refuses a record stating a key that would not survive the parse", () => {
    const guarded = refusesVanishingKey(z.partialRecord(z.string(), z.array(z.string())), "A payload");
    expect(guarded.safeParse(probe()).success).toBe(false);
  });

  test("names the subject, because the reader has to go and change what wrote it", () => {
    const guarded = refusesVanishingKey(z.record(z.string(), z.unknown()), "A capability's client projection");
    const result = guarded.safeParse(probe());
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain("A capability's client projection");
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
    // Every object has one. Only an own property is something a payload wrote, and refusing on the
    // inherited name would refuse every record there is.
    const guarded = manifestRecord(z.partialRecord(z.string(), z.array(z.string())));
    expect(guarded.parse({ cloudflare: ["secrets:read"] })).toEqual({ cloudflare: ["secrets:read"] });
  });

  test("the schema behind the guard still owns its own key rule", () => {
    const guarded = manifestRecord(z.partialRecord(z.string().regex(/^[a-z]+$/), z.array(z.string())));
    expect(guarded.safeParse({ "Not Lower": ["x"] }).success).toBe(false);
  });
});

/**
 * The answer to the question #331 left open, kept as a test because it is the reason the guard is shaped
 * the way it is rather than a note somebody has to trust.
 *
 * The proposal was that projecting into `Object.create(null)` would close the whole class at once: with no
 * `__proto__` setter on the target, the assignment creates a property and the key survives. It does not,
 * and the reason is one line of Zod: the key is compared by name and skipped *before* anything is
 * assigned, so no prototype anywhere in the transaction is consulted. A guard in front of the schema is
 * the only altitude that works.
 */
describe("a null prototype does not close the class", () => {
  test("a null-prototype input still loses the key", () => {
    const stated = Object.assign(Object.create(null) as Record<string, unknown>, probe());
    expect(Object.hasOwn(stated, "__proto__")).toBe(true);
    const parsed = z.record(z.string(), z.array(z.string())).parse(stated);
    expect(Object.keys(parsed)).toEqual([]);
  });

  test("the predicate sees the own key on either prototype", () => {
    expect(statesNoVanishingKey(probe())).toBe(false);
    expect(statesNoVanishingKey(Object.assign(Object.create(null) as object, probe()))).toBe(false);
    expect(statesNoVanishingKey({ cloudflare: ["secrets:read"] })).toBe(true);
    expect(statesNoVanishingKey("not an object")).toBe(true);
  });
});

/**
 * The gate.
 *
 * #331 was one field. The exposure is not: it belongs to the shape, so every record read from outside this
 * process has it, and the fix that lives at one call site is how this codebase has repeatedly closed a
 * hole and left its siblings open. Enumerating today's records is what would produce the next miss, so
 * this does not enumerate them.
 *
 * It walks each guarded root instead and **attacks** every record it finds with a key that vanishes. A
 * record added to a root without the guard fails this test on the commit that adds it, wherever it sits
 * and whatever it is called. Nothing here reads a marker the guard sets, and nothing asserts a structure:
 * the only question asked of a site is whether it lets the key through.
 *
 * **Two roots, and the second is why the walk is not a manifest test.** `#331` closed the manifest and the
 * gate was written around it; `ClientProjection` is a record space of exactly the same kind, read from a
 * capability rather than from `node_modules`, and it was open. A gate that only knows one root cannot
 * report that. Add a third root here rather than a third gate.
 *
 * **A refusal only counts when the same payload without the key is accepted.** The first draft of this
 * gate attacked every site with `{"__proto__":[...]}` and called a refusal a guard. That reads as rigour
 * and is not: `ClientProjection` requires `enabled`, so it refused the probe for having no `enabled` —
 * and reported itself guarded while the guard was removed. Verified by removing it. So each site is
 * attacked with a baseline it *accepts*, plus the key: refusing that is about the key and nothing else,
 * and a site no baseline reaches is reported `unprobed` rather than counted as a pass.
 */
describe("every record a payload may state refuses a key that would vanish", () => {
  /** A Zod node, as much of one as the walk needs. Zod's own types do not describe a schema generically. */
  interface ZodNode {
    readonly _zod?: { readonly def?: Record<string, unknown> };
  }

  /** A record found under a root: where it sits, and the schema the field holding it actually is. */
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
   * it: an object's field, an array's element, a record's value, a catchall. A guard wraps the record, so
   * attacking the record itself would report every guarded site as unguarded. Wrappers between the two (a
   * pipe, a union, `lazy`, `optional`, `default`, `describe`) leave the attack node where it was, which is
   * what makes the walk indifferent to how a guard is spelled — it is the field's own schema being
   * attacked, exactly as a payload hits it.
   *
   * **An object counts as a record only when it has a catchall**, and that distinction is the whole reason
   * `ClientProjection` was found. A stripping object drops every unknown key, so `__proto__` is not
   * special there and nothing is lost that a reader would expect to keep; a strict object refuses them all,
   * `__proto__` included. A catchall *keeps* every extra key — which makes the one it silently drops a
   * defect, and makes the object itself a record for this purpose.
   *
   * `seen` bounds the recursion `ConfigOptionValue` and `JsonValue` introduce: both refer to themselves.
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
        const fields = Object.entries(shape).flatMap(([key, field]) =>
          recordSites(field, path === "" ? key : `${path}.${key}`, field as z.ZodType, seen),
        );
        const catchall = def.catchall as z.ZodType | undefined;
        if (!catchall) return fields;
        return [{ path: here, attack }, ...fields, ...recordSites(catchall, `${path}{extra}`, catchall, seen)];
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

  interface Root {
    name: string;
    schema: z.ZodType;
  }

  /** Every root a payload is parsed through. A record space added later belongs on this list. */
  const MANIFEST: Root = { name: "CapabilityManifest", schema: CapabilityManifest };
  const PROJECTION: Root = { name: "ClientProjection", schema: ClientProjection };
  const roots: readonly Root[] = [MANIFEST, PROJECTION];

  /** A fresh `seen` per root: one shared across roots would skip whatever the first root already visited. */
  const sitesOf = (root: Root): RecordSite[] => recordSites(root.schema, "", root.schema, new Set());

  test("the walk reaches every record these roots have today", () => {
    // Guards against a walk that stops early and passes vacuously.
    const manifest = sitesOf(MANIFEST).map((site) => site.path);
    expect(manifest.some((path) => path.startsWith("secrets[].origin") && path.endsWith("needs"))).toBe(true);
    expect(manifest.some((path) => path.startsWith("configOptions[].default"))).toBe(true);

    // The projection's own top level, and the JSON space every value in it lives in.
    const projection = sitesOf(PROJECTION).map((site) => site.path);
    expect(projection).toContain("<root>");
    expect(projection.some((path) => path.startsWith("{extra}"))).toBe(true);

    expect(manifest.length + projection.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * Payloads a site may accept, smallest first. Each is attacked as itself plus the vanishing key, so the
   * difference between the two parses is the key and only the key. A root whose records require a field
   * no baseline here supplies adds one; the `unprobed` verdict is what tells you that has happened.
   */
  const BASELINES = ["{}", '{"enabled":true}'] as const;

  /** The same JSON, with the one key that will not survive being read. */
  function attacked(baseline: string): unknown {
    const key = '"__proto__":["deployments:write"]';
    return JSON.parse(baseline === "{}" ? `{${key}}` : `${baseline.slice(0, -1)},${key}}`);
  }

  type Verdict = "guarded" | "leaky" | "unprobed";

  function verdictFor(site: RecordSite): Verdict {
    for (const baseline of BASELINES) {
      if (!site.attack.safeParse(JSON.parse(baseline)).success) continue;
      return site.attack.safeParse(attacked(baseline)).success ? "leaky" : "guarded";
    }
    return "unprobed";
  }

  test.each(roots)("no record $name may state lets the key through", (root) => {
    const verdicts = sitesOf(root).map((site) => [site.path, verdictFor(site)] as const);
    const leaky = verdicts.filter(([, verdict]) => verdict === "leaky").map(([path]) => path);
    expect(
      leaky,
      `${root.name}: ${leaky.join(", ")} accepts a payload stating "__proto__" and returns without it. The key raises no issue and is not in the result, so nothing downstream can tell it was written. Wrap the record in refusesVanishingKey().`,
    ).toEqual([]);

    const unprobed = verdicts.filter(([, verdict]) => verdict === "unprobed").map(([path]) => path);
    expect(
      unprobed,
      `${root.name}: ${unprobed.join(", ")} accepts no baseline this gate has, so its refusal proves nothing about the key. Add a baseline it accepts to BASELINES.`,
    ).toEqual([]);
  });

  test("the gate's own control: a site that refuses for an unrelated reason is not a pass", () => {
    // Why `verdictFor` compares two parses rather than counting a refusal. This site refuses the probe
    // outright — for having no `enabled` — and holds no guard whatever. The first draft of this gate
    // called that guarded.
    const unguarded = z.object({ enabled: z.boolean() }).catchall(z.unknown());
    expect(unguarded.safeParse(JSON.parse('{"__proto__":["x"]}')).success).toBe(false);
    expect(verdictFor({ path: "control", attack: unguarded })).toBe("leaky");
  });

  test("the gate bites — the same record without its guard fails it", () => {
    // The control, and the reason the tests above are not passing because the probe is inert. This is the
    // `needs` record exactly as it was written before #331, attacked with the same input.
    const unguarded = z.partialRecord(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
      z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/)),
    );
    const result = unguarded.safeParse(probe());
    expect(result.success).toBe(true);
    expect(result.success && Object.keys(result.data)).toEqual([]);
  });

  test("the gate bites at a catchall too — an object that keeps every extra key but that one", () => {
    // The control for the case the walk learned in this change. `ClientProjection` before its guard:
    // every extra key survives, `__proto__` does not, and nothing says so.
    const unguarded = z.object({ enabled: z.boolean() }).catchall(z.unknown());
    const stated = JSON.parse('{"enabled":true,"sitekey":"k","__proto__":{"any":1}}') as unknown;
    const result = unguarded.safeParse(stated);
    expect(result.success).toBe(true);
    expect(result.success && Object.keys(result.data).sort()).toEqual(["enabled", "sitekey"]);
  });
});
