// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { featureConfigPath } from "../provision/featureConfig";
import type { ResourceProvisioners } from "../provision/resources";
import { deprovisionFeature, provisionFeature } from "./provision";
import {
  accountRatelimitRegistry,
  allocateFeatureRatelimits,
  FEATURE_RATELIMIT_MIN,
  isFeatureRatelimitId,
  namespaceIdValue,
  RATELIMIT_REGISTRY_DATABASE,
  type RatelimitRegistry,
  sqlRatelimitRegistry,
} from "./ratelimits";

/**
 * **A feature's rate-limit namespaces are impossible to share, not unlikely to (#643).**
 *
 * Each claim is a row in the account's feature registry, a D1 database whose primary key is the id — so it is
 * tested against real SQLite, the engine D1 runs, rather than a stand-in that would have to re-implement the
 * one property that matters: a second claim on an id inserts nothing.
 */

/** The registry over an in-memory SQLite, the engine D1 is. `rows` reads the table back for assertions. */
function sqliteRegistry(hooks: { beforeClaim?: (db: DatabaseSync) => void } = {}) {
  const db = new DatabaseSync(":memory:");
  const execute = async (sql: string, params: string[]): Promise<unknown[]> => {
    if (sql.startsWith("INSERT")) hooks.beforeClaim?.(db);
    const statement = db.prepare(sql);
    if (/SELECT|RETURNING/i.test(sql)) return statement.all(...params);
    statement.run(...params);
    return [];
  };
  const registry = sqlRatelimitRegistry(execute);
  const rows = (): { namespace_id: number; project: string; issue: string; slug: string; limiter: string }[] =>
    db.prepare("SELECT * FROM ratelimit_claims ORDER BY namespace_id").all() as never;
  return { db, registry, rows };
}

const acme = (slug: string, issue = "643"): FeatureIdentity => ({ project: "acme", issue, slug });

async function allocate(
  identity: FeatureIdentity,
  registry: RatelimitRegistry,
  limiters = ["ns-1001"],
  declared: string[] = [],
) {
  return allocateFeatureRatelimits({ identity, limiters, declared: new Set(declared), registry });
}

describe("allocateFeatureRatelimits", () => {
  test("every id is in the reserved range, which no declared environment may use", async () => {
    const ids = await allocate(acme("foo"), sqliteRegistry().registry, ["ns-1001", "ns-2002", "binding-x"]);
    for (const id of ids.values()) expect(isFeatureRatelimitId(id)).toBe(true);
    expect(new Set(ids.values()).size).toBe(3);
  });

  /** The reviewer's repro: `0643` and `643` are one issue — one feature, so one namespace, never two colliding. */
  test("a leading zero is the same feature, and keeps the same namespace", async () => {
    const { registry, rows } = sqliteRegistry();
    const first = await allocate(acme("foo", "643"), registry);
    const again = await allocate(acme("foo", "0643"), registry);
    expect(again).toEqual(first);
    expect(rows()).toHaveLength(1);
  });

  /**
   * The reviewer's repro of the review of 4828e1fc: `c` is the first hex of `login`'s hash, and ownership by fitted
   * slug gave `feature/12-login` the id `feature/12-c` held — and its teardown freed `c`'s claim.
   */
  test("feature/12-login and feature/12-c hold two ids, and login's teardown frees only its own", async () => {
    const { registry, rows } = sqliteRegistry();
    const c = await allocate({ project: "acme", issue: "12", slug: "c" }, registry);
    const login = await allocate({ project: "acme", issue: "12", slug: "login" }, registry);
    expect(login.get("ns-1001")).not.toBe(c.get("ns-1001"));
    expect(await registry.release({ project: "acme", issue: "12", slug: "login" })).toEqual([login.get("ns-1001")]);
    expect(rows().map((row) => [row.slug, String(row.namespace_id)])).toEqual([["c", c.get("ns-1001")]]);
  });

  test("siblings and other projects never share an id, even one each would pick first", async () => {
    const { registry, db } = sqliteRegistry();
    const mine = await allocate(acme("foo"), registry);
    const id = mine.get("ns-1001") as string;
    // Another project whose first pick is contrived to be the same id: it is already claimed, so it moves on.
    db.prepare("DELETE FROM ratelimit_claims").run();
    await registry.claim({ project: "globex", issue: "643", slug: "foo" }, "ns-9", id);
    const theirs = await allocate(acme("foo"), registry);
    expect(theirs.get("ns-1001")).not.toBe(id);
    const sibling = await allocate(acme("foo-2"), registry);
    expect(new Set([id, theirs.get("ns-1001"), sibling.get("ns-1001")]).size).toBe(3);
  });

  test("a re-run keeps its namespace, and teardown gives it back", async () => {
    const { registry, rows } = sqliteRegistry();
    const first = await allocate(acme("foo"), registry);
    expect(await allocate(acme("foo"), registry)).toEqual(first);
    await registry.release(acme("foo"));
    expect(rows()).toEqual([]);
  });

  /**
   * **Two runs racing for one id.** Another feature claims the id this run picked between this run's read and its
   * insert. The older claim is the row; this run's insert does nothing, it reads that it holds nothing, and it
   * takes the next free id.
   */
  test("a lost race inserts nothing and takes another id", async () => {
    let raced = false;
    const { registry, rows } = sqliteRegistry({
      beforeClaim: (db) => {
        if (raced) return;
        raced = true;
        db.prepare(
          "INSERT INTO ratelimit_claims (namespace_id, project, issue, slug, limiter, claimed_at) SELECT ?, 'globex', '1', 'rival', 'ns-1001', 'then'",
        ).run(firstPick);
      },
    });
    const firstPick = (await allocate(acme("foo"), sqliteRegistry().registry)).get("ns-1001") as string;
    const ids = await allocate(acme("foo"), registry);
    expect(ids.get("ns-1001")).not.toBe(firstPick);
    expect(rows().map((row) => [row.slug, String(row.namespace_id)])).toEqual(
      [
        ["rival", firstPick],
        ["foo", ids.get("ns-1001")],
      ].sort((a, b) => Number(a[1]) - Number(b[1])),
    );
  });

  /** Two runs of the same feature racing: one row per limiter, so both leave with the same id. */
  test("two runs of one feature racing leave one claim, and agree on it", async () => {
    const { registry, rows } = sqliteRegistry();
    const [a, b] = await Promise.all([allocate(acme("foo"), registry), allocate(acme("foo"), registry)]);
    expect(a).toEqual(b);
    expect(rows()).toHaveLength(1);
  });

  test("never takes an id a tracked config declares", async () => {
    const free = await allocate(acme("foo"), sqliteRegistry().registry);
    const taken = free.get("ns-1001") as string;
    const ids = await allocate(acme("foo"), sqliteRegistry().registry, ["ns-1001"], [`0${taken}`]);
    expect(ids.get("ns-1001")).not.toBe(taken);
    expect(Number(ids.get("ns-1001"))).toBeGreaterThanOrEqual(FEATURE_RATELIMIT_MIN);
  });
});

describe("accountRatelimitRegistry", () => {
  const sql = () => async () => [];

  test("creates the registry database when asked and absent, and only then", async () => {
    const created: string[] = [];
    const d1 = {
      find: async () => null,
      create: async (name: string) => {
        created.push(name);
        return { id: "db-1" };
      },
    };
    expect(await accountRatelimitRegistry({ d1, execute: sql, create: false })).toBeNull();
    expect(created).toEqual([]);
    expect(await accountRatelimitRegistry({ d1, execute: sql, create: true })).not.toBeNull();
    expect(created).toEqual([RATELIMIT_REGISTRY_DATABASE]);
  });

  test("a create that loses to another run's takes the winner's database", async () => {
    let exists = false;
    const opened: string[] = [];
    const d1 = {
      find: async () => (exists ? { id: "winner" } : null),
      create: async () => {
        exists = true;
        throw new Error("a database with that name already exists");
      },
    };
    const execute = (id: string) => {
      opened.push(id);
      return async () => [];
    };
    await accountRatelimitRegistry({ d1, execute, create: true });
    expect(opened).toEqual(["winner"]);
  });

  test("its name is no feature's and no environment's", () => {
    expect(RATELIMIT_REGISTRY_DATABASE).toContain("--");
    expect(RATELIMIT_REGISTRY_DATABASE.startsWith("pithy--")).toBe(true);
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

  const provision = (workers: { name: string; dir: string; capabilities: never[] }[], ratelimits?: RatelimitRegistry) =>
    provisionFeature({
      projectDir: dir,
      capabilities: [],
      identity: acme("foo"),
      provisioners,
      administersItself: false,
      resolveWorkers: async () => workers,
      migrate: async () => {},
      seed: async () => {},
      ...(ratelimits ? { ratelimits } : {}),
    });

  test("two Workers' distinct limiters get two namespaces, neither of them production's", async () => {
    const api = await app("api", {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } }],
    });
    const web = await app("web", {
      ratelimits: [{ name: "UPLOAD_LIMITER", namespace_id: "1002", simple: { limit: 1000, period: 60 } }],
    });
    await provision([api, web], sqliteRegistry().registry);
    const [a] = await limits(api.dir);
    const [w] = await limits(web.dir);
    expect(a?.namespace_id).not.toBe(w?.namespace_id);
    expect([a?.namespace_id, w?.namespace_id].every((id) => isFeatureRatelimitId(String(id)))).toBe(true);
  });

  test("two Workers bound to one namespace in production share one in the feature", async () => {
    const limiter = { name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } };
    const api = await app("api", { ratelimits: [limiter] });
    const web = await app("web", { ratelimits: [limiter] });
    await provision([api, web], sqliteRegistry().registry);
    expect((await limits(api.dir))[0]?.namespace_id).toBe((await limits(web.dir))[0]?.namespace_id);
  });

  test("a staging id in the feature range, in any Worker's tracked config, is refused", async () => {
    const api = await app("api", {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } }],
    });
    const web = await app("web", {
      env: { staging: { ratelimits: [{ name: "X", namespace_id: "1000000007", simple: { limit: 5, period: 60 } }] } },
    });
    await expect(provision([api, web], sqliteRegistry().registry)).rejects.toThrow(
      "acme-web declares rate-limit namespace 1000000007 in env.staging.",
    );
  });

  test("a feature that binds a limiter and has no registry to claim from is refused", async () => {
    const api = await app("api", {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } }],
    });
    await expect(provision([api])).rejects.toThrow("each takes a namespace from the account's feature registry");
  });

  test("teardown removes the feature's claims, and no one else's", async () => {
    const api = await app("api", {
      ratelimits: [{ name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } }],
    });
    const { registry, rows } = sqliteRegistry();
    await registry.claim(acme("foo-2"), "ns-1001", "1000000001");
    await provision([api], registry);
    expect(rows().map((row) => row.slug)).toEqual(expect.arrayContaining(["foo", "foo-2"]));
    await deprovisionFeature({
      projectDir: dir,
      identity: acme("foo"),
      capabilities: [],
      env: "feature",
      provisioners,
      scripts: { exists: async () => false, delete: async () => {} },
      workflows: { hostedBy: async () => [], delete: async () => {} },
      workers: [],
      ratelimits: registry,
    });
    expect(rows().map((row) => [row.slug, String(row.namespace_id)])).toEqual([["foo-2", "1000000001"]]);
  });
});
