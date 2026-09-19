// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { featureConfigPath } from "../provision/featureConfig";
import type { ResourceProvisioners } from "../provision/resources";
import { provisionFeature } from "./provision";
import { featureNamespaceId, isFeatureRatelimitId, namespaceIdValue } from "./ratelimits";

/**
 * **A feature's rate-limit namespace is fixed by its limiter, and never a staging or production one (#643).**
 *
 * Features may share a limiter with each other; they never share with a declared environment. So there is nothing
 * to allocate: the id is the declared namespace offset into the reserved range, and an offset cannot collide.
 */

const acme = (slug: string, issue = "643"): FeatureIdentity => ({ project: "acme", issue, slug });

describe("featureNamespaceId", () => {
  test("is the declared namespace offset into the reserved range", () => {
    expect(featureNamespaceId({ name: "A", namespace_id: "1001" })).toBe("1000001001");
    expect(featureNamespaceId({ name: "A", namespace_id: 1 })).toBe("1000000001");
    expect(featureNamespaceId({ name: "A", namespace_id: " 0999999999 " })).toBe("1999999999");
    for (const id of ["1", "1001", "999999999"]) {
      expect(isFeatureRatelimitId(featureNamespaceId({ namespace_id: id })), id).toBe(true);
    }
  });

  /** Injective, not unlikely to collide: a seeded sweep over the whole declarable span, and its two edges. */
  test("distinct declared namespaces never share a feature id", () => {
    let seed = 643;
    const random = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };
    const declared = new Set([1, 2, 999999998, 999999999]);
    while (declared.size < 5000) declared.add(1 + (random() % 999999999));
    const ids = new Set([...declared].map((id) => featureNamespaceId({ namespace_id: String(id) })));
    expect(ids.size).toBe(declared.size);
  });

  test("refuses a limiter it cannot map, naming it", () => {
    for (const namespace_id of [
      undefined,
      "",
      "abc",
      "1.5",
      "1001abc",
      "1e3",
      1.5,
      0,
      "0",
      -4,
      "1000000000",
      2000000001,
    ]) {
      expect(
        () => featureNamespaceId({ name: "AUTH_RATE_LIMITER", namespace_id }, "acme-api"),
        String(namespace_id),
      ).toThrow(/acme-api's rate limiter AUTH_RATE_LIMITER/);
    }
  });
});

/**
 * **A declared id is read as the integer it spells (#643).** Cloudflare documents `namespace_id` as "a string
 * containing a positive integer" and says nothing of zero padding, so every spelling a number parser accepts is
 * read as its integer: `"01031275746"` does not slip past the range check by being eleven characters.
 */
describe("namespace ids are integers", () => {
  test.each([
    ["1031275746", 1031275746],
    ["01031275746", 1031275746],
    [" 1031275746 ", 1031275746],
    [1031275746, 1031275746],
    ["1.031275746e9", 1031275746],
    ["1031275746abc", 1031275746],
    ["1001", 1001],
  ])("%j is %i", (spelled, value) => {
    expect(namespaceIdValue(spelled)).toBe(value);
  });

  test("the range check reads the integer, never the string", () => {
    for (const id of ["1031275746", "01031275746", "001000000000", 1999999999, "1.5e9"]) {
      expect(isFeatureRatelimitId(id), String(id)).toBe(true);
    }
    for (const id of ["999999999", "2000000000", "1001", "", "abc", 1.5]) {
      expect(isFeatureRatelimitId(id), String(id)).toBe(false);
    }
  });
});

/** The reviewer's two provisioning repros: two Workers' limiters, and a staging id in another Worker's file. */
describe("provisionFeature's rate limiters", () => {
  let dir: string;
  const none = { find: async () => null, create: async (name: string) => ({ id: name }), delete: async () => {} };
  const provisioners = { d1: none, kv: none, r2: none } as unknown as ResourceProvisioners;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-ratelimits-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function app(name: string, config: object, root = dir) {
    const workerDir = join(root, "apps", name);
    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      JSON.stringify({
        name: `acme-${name}`,
        main: "./src/index.ts",
        compatibility_date: "2026-06-01",
        vars: { ENVIRONMENT: "dev" },
        ...config,
      }),
    );
    return { name: `acme-${name}`, dir: workerDir, capabilities: [] };
  }

  const limits = async (workerDir: string) =>
    (
      parse(await readFile(featureConfigPath(workerDir), "utf8")) as unknown as {
        env: { feature: { ratelimits: { name: string; namespace_id: string }[] } };
      }
    ).env.feature.ratelimits;

  const provisionFeatureAs = (
    identity: FeatureIdentity,
    workers: { name: string; dir: string; capabilities: never[] }[],
    root = dir,
  ) =>
    provisionFeature({
      projectDir: root,
      capabilities: [],
      identity,
      provisioners,
      administersItself: false,
      resolveWorkers: async () => workers,
      migrate: async () => {},
      seed: async () => {},
    });

  const provision = (workers: { name: string; dir: string; capabilities: never[] }[]) =>
    provisionFeatureAs(acme("foo"), workers);

  /**
   * **Features share a limiter's namespace with each other, never with staging or prod (#643).** The id is fixed by
   * the limiter: two features of one project, and a feature of another project, bind the same id for the same
   * declared namespace, and two declared namespaces keep two ids. No registry is passed: nothing is claimed.
   */
  test("every feature binds the same fixed id for a limiter, and distinct limiters keep distinct ids", async () => {
    // Each feature in a worktree of its own, as `pithy feature create` makes them.
    const ids = async (identity: FeatureIdentity) => {
      const root = join(dir, `${identity.project}-f${identity.issue}-${identity.slug}`);
      const api = await app(
        "api",
        {
          ratelimits: [
            { name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } },
            { name: "UPLOAD_LIMITER", namespace_id: "1002", simple: { limit: 50, period: 60 } },
          ],
        },
        root,
      );
      await provisionFeatureAs(identity, [api], root);
      return (await limits(api.dir)).map((entry) => [entry.name, entry.namespace_id]);
    };
    const foo = await ids(acme("foo"));
    const bar = await ids(acme("bar", "7"));
    const globex = await ids({ project: "globex", issue: "643", slug: "foo" });
    expect(foo).toEqual([
      ["AUTH_RATE_LIMITER", "1000001001"],
      ["UPLOAD_LIMITER", "1000001002"],
    ]);
    expect(bar).toEqual(foo);
    expect(globex).toEqual(foo);
  });

  test("two Workers' distinct limiters get two namespaces, neither of them production's", async () => {
    const api = await app("api", {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } }],
    });
    const web = await app("web", {
      ratelimits: [{ name: "UPLOAD_LIMITER", namespace_id: "1002", simple: { limit: 1000, period: 60 } }],
    });
    await provision([api, web]);
    const [a] = await limits(api.dir);
    const [w] = await limits(web.dir);
    expect(a?.namespace_id).not.toBe(w?.namespace_id);
    expect([a?.namespace_id, w?.namespace_id].every((id) => isFeatureRatelimitId(String(id)))).toBe(true);
  });

  test("two Workers bound to one namespace in production share one in the feature", async () => {
    const limiter = { name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } };
    const api = await app("api", { ratelimits: [limiter] });
    const web = await app("web", { ratelimits: [limiter] });
    await provision([api, web]);
    expect((await limits(api.dir))[0]?.namespace_id).toBe((await limits(web.dir))[0]?.namespace_id);
  });

  test("a staging id in the feature range, in any Worker's tracked config, is refused", async () => {
    const api = await app("api", {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } }],
    });
    const web = await app("web", {
      env: { staging: { ratelimits: [{ name: "X", namespace_id: "1000000007", simple: { limit: 5, period: 60 } }] } },
    });
    await expect(provision([api, web])).rejects.toThrow(
      "acme-web declares rate-limit namespace 1000000007 in env.staging.",
    );
  });

  test("a limiter a feature cannot map is refused before anything is created", async () => {
    const api = await app("api", {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "2000000001", simple: { limit: 5, period: 60 } }],
    });
    const created: string[] = [];
    const recording = {
      find: async () => null,
      create: async (name: string) => {
        created.push(name);
        return { id: name };
      },
      delete: async () => {},
    };
    await expect(
      provisionFeature({
        projectDir: dir,
        capabilities: [],
        identity: acme("foo"),
        provisioners: { d1: recording, kv: recording, r2: recording } as unknown as ResourceProvisioners,
        administersItself: false,
        resolveWorkers: async () => [api],
        migrate: async () => {},
        seed: async () => {},
      }),
    ).rejects.toThrow("acme-api's rate limiter AUTH_RATE_LIMITER declares namespace 2000000001");
    expect(created).toEqual([]);
  });
});
