// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { isValidEnvironment } from "./environment";
import {
  FEATURE_RESOURCE_KINDS,
  type FeatureResourceKind,
  featureMarkerInProjectName,
  featureResourceName,
  parseFeatureName,
} from "./feature";
import { NAMESPACE_LIMITS } from "./limits";
import { environmentScope } from "./provisionScope";
import { MAX_PROJECT_NAME } from "./resource";
import { resourceNames } from "./resourceNames";

/**
 * **An owned name is never a shared name, and no name a declared environment composes is a feature's.**
 *
 * Both are statements about every input, so they are tested over generated ones: projects from one character to the
 * longest legal, some carrying an `f<digits>` segment; every legal environment shape up to seven characters; Workers
 * and bindings short and far past every cap, so truncation is exercised in every namespace.
 */

/** A small deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = `${LETTERS}0123456789`;
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const between = (random: Random, low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

/** A kebab name of `length` characters, starting with a letter, never with a doubled or trailing hyphen. */
function kebabOf(random: Random, length: number): string {
  let out = pick(random, LETTERS.split(""));
  while (out.length < length) {
    const room = length - out.length;
    out += room >= 2 && random() < 0.25 && !out.endsWith("-") ? "-" : pick(random, ALNUM.split(""));
  }
  return out.endsWith("-") ? `${out.slice(0, -1)}a` : out;
}

/** A project: sometimes with a feature marker segment, the shape `acme-f3` takes. */
function project(random: Random): string {
  if (random() < 0.3) return `${kebabOf(random, between(random, 1, 10))}-f${between(random, 0, 999)}`;
  return kebabOf(random, between(random, 1, MAX_PROJECT_NAME));
}

/** A project features may run in: no `f<digits>` segment. */
function featureProject(random: Random): string {
  for (;;) {
    const candidate = kebabOf(random, between(random, 1, 10));
    if (featureMarkerInProjectName(candidate) === null) return candidate;
  }
}

function environment(random: Random): string {
  for (;;) {
    const candidate = kebabOf(random, between(random, 2, 7));
    if (isValidEnvironment(candidate)) return candidate;
  }
}

/** A binding as an adopter writes one: SCREAMING_SNAKE, short or far past every cap. */
function binding(random: Random): string {
  return kebabOf(random, between(random, 1, random() < 0.2 ? 90 : 20))
    .toUpperCase()
    .replace(/-/g, "_");
}

function worker(random: Random): string {
  return kebabOf(random, between(random, 1, random() < 0.2 ? 70 : 12));
}

const ROUNDS = 4000;

describe("an owned name against every shared name", () => {
  it("never equals a shared name in any kind, and holds the separator however it is truncated", () => {
    const random = rng(942);
    for (let round = 0; round < ROUNDS; round += 1) {
      const p = project(random);
      const env = resourceNames(p).env(environment(random));
      const w = worker(random);
      const b = binding(random);
      const kind = pick(random, FEATURE_RESOURCE_KINDS);
      const owned = env[kind](b, w);
      // The adversarial shared binding: the owner and the binding run together, which kebabs to `<w>-<b>`.
      for (const other of [b, `${w}_${b}`, binding(random)]) {
        const shared = env[kind](other);
        expect(owned, `${p} ${w} ${b} / ${other}`).not.toBe(shared);
        expect(shared).not.toContain("--");
      }
      expect(owned).toContain("---");
      expect(owned.length).toBeLessThanOrEqual(NAMESPACE_LIMITS[kind].maxLength);
    }
  });

  it("recomputes identically, truncated or not", () => {
    const random = rng(943);
    for (let round = 0; round < ROUNDS; round += 1) {
      const p = project(random);
      const e = environment(random);
      const w = worker(random);
      const b = binding(random);
      const kind = pick(random, FEATURE_RESOURCE_KINDS);
      expect(resourceNames(p).env(e)[kind](b, w)).toBe(resourceNames(p).env(e)[kind](b, w));
      expect(environmentScope(p, e).resource(b, kind, {}, w)).toBe(resourceNames(p).env(e)[kind](b, w));
    }
  });

  it("is never a feature's shared name either", () => {
    const random = rng(944);
    for (let round = 0; round < ROUNDS; round += 1) {
      const identity = {
        project: featureProject(random),
        issue: String(between(random, 0, 99999)),
        slug: kebabOf(random, between(random, 1, 8)),
      };
      const kind: FeatureResourceKind = pick(random, FEATURE_RESOURCE_KINDS);
      const w = kebabOf(random, between(random, 1, 8));
      const b = kebabOf(random, between(random, 1, 8))
        .toUpperCase()
        .replace(/-/g, "_");
      const owned = featureResourceName(identity, b, kind, w);
      expect(owned).not.toBe(featureResourceName(identity, `${w}_${b}`, kind));
      expect(owned).not.toBe(featureResourceName(identity, b, kind));
    }
  });
});

describe("a declared environment's names against every feature's", () => {
  it("names the acme-f3 prod and acme feature/3-prod-x pair apart, and reads only the feature's as one", () => {
    const prodOwned = environmentScope("acme-f3", "prod").resource("SESSIONS_KV", "kv", {}, "x");
    const branch = featureResourceName({ project: "acme", issue: "3", slug: "prod-x" }, "SESSIONS", "kv");
    expect(prodOwned).toBe("acme-f3-prod-x---sessions-kv");
    expect(branch).toBe("acme-f3-prod-x--sessions-kv");
    expect(prodOwned).not.toBe(branch);
    expect(parseFeatureName(prodOwned)).toBeNull();
    expect(parseFeatureName(branch)).not.toBeNull();
  });

  it("composes nothing, owned or shared, that parses as a feature name for any project", () => {
    const random = rng(945);
    for (let round = 0; round < ROUNDS; round += 1) {
      const p = project(random);
      const e = environment(random);
      const scope = environmentScope(p, e);
      const names = resourceNames(p).env(e);
      const b = binding(random);
      const w = worker(random);
      const kind = pick(random, FEATURE_RESOURCE_KINDS);
      const composed = [
        scope.resource(b, kind, {}),
        scope.resource(b, kind, {}, w),
        scope.resource(b, kind, { resource: binding(random) }, w),
        names.secretEntry(b),
        names.apiToken(b),
        resourceNames(p).global[kind](b),
      ];
      for (const name of composed) expect(parseFeatureName(name), name).toBeNull();
    }
  });
});
