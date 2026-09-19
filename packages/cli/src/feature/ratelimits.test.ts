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
import type { SecretsStore, StoreEntry } from "../provision/store";
import { deprovisionFeature, provisionFeature } from "./provision";
import {
  allocateFeatureRatelimits,
  FEATURE_RATELIMIT_MIN,
  featureRatelimitClaims,
  isFeatureRatelimitId,
  ratelimitClaimName,
} from "./ratelimits";

/**
 * **A feature's rate-limit namespaces are impossible to share, not unlikely to (#643).**
 *
 * The review of 8858558c reproduced three ways the hashed id failed: `feature/643-foo` and `feature/0643-foo`
 * always shared one, a sibling slug or another project did one time in a hundred, and two Workers' distinct
 * limiters were put in one namespace. Staging's ids were checked against one Worker's file only. Each is a test
 * here, against a stand-in Secrets Store that orders entries by creation, as Cloudflare's does.
 */

/** A Secrets Store as allocation reads it: entries by name, each with the moment it was created. */
function standInStore(hooks: { onCreate?: (name: string, store: ReturnType<typeof standInStore>) => void } = {}) {
  const entries = new Map<string, StoreEntry>();
  let clock = 1_000;
  const store = {
    entries,
    /** Put an entry in as though some other run created it at `at`. */
    seed(name: string, at: number): void {
      entries.set(name, { id: `e-${name}`, name, created: new Date(at) });
    },
    storeId: "store-1",
    exists: async (name: string) => entries.has(name),
    put: async () => {
      throw new Error("allocation never overwrites");
    },
    create: async (name: string) => {
      if (entries.has(name)) return "present" as const;
      clock += 1;
      entries.set(name, { id: `e-${name}`, name, created: new Date(clock) });
      hooks.onCreate?.(name, store);
      return "created" as const;
    },
    remove: async (name: string) => entries.delete(name),
    list: async () => [...entries.values()],
  } satisfies SecretsStore & Record<string, unknown>;
  return store;
}

const acme = (slug: string, issue = "643"): FeatureIdentity => ({ project: "acme", issue, slug });

async function allocate(
  identity: FeatureIdentity,
  store: ReturnType<typeof standInStore>,
  limiters = ["ns-1001"],
  declared: string[] = [],
) {
  return allocateFeatureRatelimits({ identity, limiters, declared: new Set(declared), store });
}

describe("allocateFeatureRatelimits", () => {
  test("every id is in the reserved range, which no declared environment may use", async () => {
    const ids = await allocate(acme("foo"), standInStore(), ["ns-1001", "ns-2002", "binding-x"]);
    for (const id of ids.values()) expect(isFeatureRatelimitId(id)).toBe(true);
    expect(new Set(ids.values()).size).toBe(3);
  });

  /** The reviewer's repro: `0643` and `643` are one issue — one feature, so one namespace, never two colliding. */
  test("a leading zero is the same feature, and keeps the same namespace", async () => {
    const store = standInStore();
    const first = await allocate(acme("foo", "643"), store);
    const again = await allocate(acme("foo", "0643"), store);
    expect(again).toEqual(first);
    expect(await featureRatelimitClaims(acme("foo", "643"), store)).toHaveLength(1);
  });

  /**
   * The reviewer's repro, generalized: a same-issue sibling and another project, on one account, each take an id
   * no one else holds — and a claim already standing on the id one would pick first moves it along, however it got
   * there.
   */
  test("siblings and other projects never share an id, even one each would pick first", async () => {
    const store = standInStore();
    const mine = await allocate(acme("foo"), store);
    const id = mine.get("ns-1001") as string;
    // Another project, whose first pick is contrived to be the same id: its claim on it is refused.
    const other: FeatureIdentity = { project: "globex", issue: "643", slug: "foo" };
    store.seed(ratelimitClaimName(other, "ns-1001", id), 5_000);
    const theirs = await allocate(other, store);
    expect(theirs.get("ns-1001")).not.toBe(id);
    const sibling = await allocate(acme("foo-2"), store);
    const all = [id, theirs.get("ns-1001"), sibling.get("ns-1001")];
    expect(new Set(all).size).toBe(3);
  });

  test("a re-run keeps its namespace, and teardown gives it back", async () => {
    const store = standInStore();
    const first = await allocate(acme("foo"), store);
    expect(await allocate(acme("foo"), store)).toEqual(first);
    for (const claim of await featureRatelimitClaims(acme("foo"), store)) await store.remove(claim);
    expect(store.entries.size).toBe(0);
  });

  /**
   * **Two runs racing for one id.** Another feature's claim on the id this run picked appears while this run is
   * creating its own, and it is older — so it stands. This run withdraws its claim and takes the next free id.
   */
  test("a lost race withdraws its claim and takes another id", async () => {
    const rival: FeatureIdentity = { project: "globex", issue: "1", slug: "rival" };
    let raced = false;
    const store = standInStore({
      onCreate: (name, self) => {
        if (raced) return;
        raced = true;
        const id = /--ratelimit-([0-9]{10})-/.exec(name)?.[1] as string;
        self.seed(ratelimitClaimName(rival, "ns-1001", id), 0);
      },
    });
    const ids = await allocate(acme("foo"), store);
    const rivalClaims = await featureRatelimitClaims(rival, store);
    const rivalId = /--ratelimit-([0-9]{10})-/.exec(rivalClaims[0] as string)?.[1];
    expect(ids.get("ns-1001")).not.toBe(rivalId);
    expect(await featureRatelimitClaims(acme("foo"), store)).toEqual([
      ratelimitClaimName(acme("foo"), "ns-1001", ids.get("ns-1001") as string),
    ]);
  });

  test("never takes an id a tracked config declares", async () => {
    const store = standInStore();
    const free = await allocate(acme("foo"), standInStore());
    const taken = free.get("ns-1001") as string;
    const ids = await allocate(acme("foo"), store, ["ns-1001"], [taken]);
    expect(ids.get("ns-1001")).not.toBe(taken);
    expect(Number(ids.get("ns-1001"))).toBeGreaterThanOrEqual(FEATURE_RATELIMIT_MIN);
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

  async function app(name: string, config: object) {
    const workerDir = join(dir, "apps", name);
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

  const provision = (workers: { name: string; dir: string; capabilities: never[] }[], store?: SecretsStore) =>
    provisionFeature({
      projectDir: dir,
      capabilities: [],
      identity: acme("foo"),
      provisioners,
      administersItself: false,
      resolveWorkers: async () => workers,
      migrate: async () => {},
      seed: async () => {},
      ...(store ? { store } : {}),
    });

  test("two Workers' distinct limiters get two namespaces, neither of them production's", async () => {
    const api = await app("api", {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } }],
    });
    const web = await app("web", {
      ratelimits: [{ name: "UPLOAD_LIMITER", namespace_id: "1002", simple: { limit: 1000, period: 60 } }],
    });
    await provision([api, web], standInStore());
    const [a] = await limits(api.dir);
    const [w] = await limits(web.dir);
    expect(a?.namespace_id).not.toBe(w?.namespace_id);
    expect([a?.namespace_id, w?.namespace_id].every((id) => isFeatureRatelimitId(String(id)))).toBe(true);
  });

  test("two Workers bound to one namespace in production share one in the feature", async () => {
    const limiter = { name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } };
    const api = await app("api", { ratelimits: [limiter] });
    const web = await app("web", { ratelimits: [limiter] });
    await provision([api, web], standInStore());
    expect((await limits(api.dir))[0]?.namespace_id).toBe((await limits(web.dir))[0]?.namespace_id);
  });

  test("a staging id in the feature range, in any Worker's tracked config, is refused", async () => {
    const api = await app("api", {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } }],
    });
    const web = await app("web", {
      env: { staging: { ratelimits: [{ name: "X", namespace_id: "1000000007", simple: { limit: 5, period: 60 } }] } },
    });
    await expect(provision([api, web], standInStore())).rejects.toThrow(
      "acme-web declares rate-limit namespace 1000000007 in env.staging",
    );
  });

  test("a feature that binds a limiter and has no store to allocate from is refused", async () => {
    const api = await app("api", {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } }],
    });
    await expect(provision([api])).rejects.toThrow("each takes a namespace of its own from the Secrets Store");
  });

  test("teardown removes the feature's claims, and no one else's", async () => {
    const api = await app("api", {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } }],
    });
    const store = standInStore();
    const theirs = ratelimitClaimName(acme("foo-2"), "ns-1001", "1000000001");
    store.seed(theirs, 1);
    await provision([api], store);
    expect(await featureRatelimitClaims(acme("foo"), store)).toHaveLength(1);
    await deprovisionFeature({
      projectDir: dir,
      identity: acme("foo"),
      capabilities: [],
      env: "feature",
      provisioners,
      scripts: { exists: async () => false, delete: async () => {} },
      workflows: { hostedBy: async () => [], delete: async () => {} },
      workers: [],
      store,
    });
    expect([...store.entries.keys()]).toEqual([theirs]);
  });
});
