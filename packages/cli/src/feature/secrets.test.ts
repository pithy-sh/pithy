// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { secretsTables } from "@pithy-sh/secrets/src/data/tables";
import { secrets_0001_init } from "@pithy-sh/secrets/src/migrations/0001_init";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { secretsStore } from "@pithy-sh/secrets/src/secretsStore";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { devSecretsFile } from "../devSecrets/location";
import type { ResourceProvisioner, ResourceProvisioners } from "../provision/resources";
import type { SecretsStore } from "../provision/store";
import { deprovisionFeature, provisionFeature } from "./provision";

/**
 * **A feature's own secrets: created once, in the feature's own Cloudflare stores, and nowhere else (#643).**
 *
 * The first review reproduced that a feature had no `auth-session-secret`, so magic link and OTP answered
 * `404 secrets/not_found`. The second reproduced what keeping a copy on the provisioning machine cost: a second
 * machine with no copy generated new values over the deployed ones and the first then re-sealed every row under
 * a master key the store no longer held (1); two concurrent runs crashed on the unique name or left rows the
 * Worker could not open (2); and the copy's permissions were never re-tightened (4). The direction: the stores
 * are the only copy, provision creates what is absent and never overwrites, and a race has one winner.
 *
 * What stands in for Cloudflare: the Secrets Store is a map with create-if-absent and **an overwrite that
 * throws**, so a run that would replace a value fails here rather than passing; and the feature's `SECRETS` D1
 * is a Miniflare D1. The proof is always the Worker's own read — `secretsStore`, over that D1 and the master key
 * the store holds.
 */

const identity: FeatureIdentity = { project: "acme", issue: "643", slug: "feature-address" };

/** What auth declares, in miniature: a `d1` secret nothing outside issues, one a provider issues, and a link key. */
const REGISTRY = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  "auth-github-credentials": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
  "email-link-signing-key": {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
});
const capabilities = [secrets({ registry: REGISTRY })];

const MASTER_KEY_ENTRY = "acme-f643-feature-address-secrets-encryption-keys";
const LINK_KEY_ENTRY = "acme-f643-feature-address-email-link-signing-key";

/** Let every other pending run take a turn, so two runs interleave at each account call rather than in series. */
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** An in-memory provisioner over a name→id map, as the real adapter behaves — one resource per name. */
function fakeKind(kind: string): ResourceProvisioner {
  const names = new Map<string, string>();
  let seq = 0;
  return {
    find: async (name) => {
      await yieldTurn();
      return names.has(name) ? { id: names.get(name) as string } : null;
    },
    create: async (name) => {
      await yieldTurn();
      const existing = names.get(name);
      if (existing !== undefined) return { id: existing };
      seq += 1;
      const id = `${kind}-${seq}`;
      names.set(name, id);
      return { id };
    },
    delete: async (id) => {
      for (const [name, value] of names) if (value === id) names.delete(name);
    },
  };
}

let checkouts: string[];
let miniflare: Miniflare;
let d1: D1Database;
let entries: Map<string, string>;
let creates: string[];
let provisioners: ResourceProvisioners;

/** The account's Secrets Store: create-if-absent, and an overwrite that fails the run which attempts it. */
const store = (): SecretsStore => ({
  storeId: "store-1",
  exists: async (name) => {
    await yieldTurn();
    return entries.has(name);
  },
  put: async (name) => {
    throw new Error(`overwrote ${name}: a feature run must never replace a value`);
  },
  create: async (name, value) => {
    await yieldTurn();
    if (entries.has(name)) return false;
    entries.set(name, value);
    creates.push(name);
    return true;
  },
  remove: async (name) => entries.delete(name),
});

/** A checkout of the feature branch — a laptop, a CI runner — with its own directory. */
async function checkout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-feature-secrets-"));
  checkouts.push(dir);
  await mkdir(join(dir, "apps", "board"), { recursive: true });
  await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), '{ "name": "acme-board" }\n');
  return dir;
}

/** One `pithy provision --feature` run from `dir` — migrate included, seed stubbed. */
function provision(
  dir: string,
  database: D1Database = d1,
  // Short, so a run that waits for another's seal waits in milliseconds here rather than a minute.
  sealPatience = { attempts: 500, delayMs: 1 },
  account: SecretsStore = store(),
) {
  return provisionFeature({
    administersItself: false,
    projectDir: dir,
    capabilities,
    identity,
    provisioners,
    store: account,
    resolveWorkers: async () => [{ name: "acme-board", dir: join(dir, "apps", "board"), capabilities }],
    // What `pithy migrate --env feature` does to the feature's SECRETS database: its schema, before any row.
    migrate: async () => {
      await secrets_0001_init.up(createDatabase(d1, secretsTables)).catch(() => {});
    },
    seed: async () => {},
    secretsDatabase: () => database,
    sealPatience,
  });
}

/** Read one secret the way the deployed Worker does: its SECRETS D1, and the master key its binding resolves. */
async function workerReads(name: keyof typeof REGISTRY): Promise<string> {
  const masterKey = entries.get(MASTER_KEY_ENTRY);
  if (masterKey === undefined) throw new Error("no master key in the store");
  const env = { SECRETS: d1, SECRETS_ENCRYPTION_KEYS: masterKey, EMAIL_LINK_SIGNING_KEY: entries.get(LINK_KEY_ENTRY) };
  const accessor = await secretsStore(env, REGISTRY);
  return String(accessor.get(name));
}

/** Every sealed row, as stored — so "nothing changed" is a comparison of ciphertexts, not of a claim. */
async function rows(): Promise<unknown[]> {
  const result = await d1
    .prepare("select name, encrypted_value, iv, key_version from pithy_secrets_system_secrets order by name")
    .all();
  return result.results;
}

/** A D1 whose reads of the secrets table fail, as a transient outage would — every other statement passes. */
function failingReads(database: D1Database): D1Database {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          if (/^\s*select/i.test(sql) && sql.includes("pithy_secrets_system_secrets")) {
            throw new Error("D1_ERROR: transient read failure");
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  checkouts = [];
  miniflare = new Miniflare({ modules: true, script: "export default {};", d1Databases: { SECRETS: "SECRETS" } });
  d1 = (await miniflare.getD1Database("SECRETS")) as unknown as D1Database;
  entries = new Map();
  creates = [];
  provisioners = { d1: fakeKind("d1"), kv: fakeKind("kv"), r2: fakeKind("r2") } as unknown as ResourceProvisioners;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await miniflare.dispose();
  for (const dir of checkouts) await rm(dir, { recursive: true, force: true });
});

describe("pithy provision --feature, and the feature's own secrets", () => {
  test("seals every mintable d1 secret into the feature's SECRETS database, and the Worker reads them all", async () => {
    const report = await provision(await checkout());

    expect(await workerReads("auth-session-secret")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await workerReads("email-link-signing-key")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(report.featureSecrets).toEqual({
      sealed: ["auth-session-secret"],
      written: ["auth-session-secret"],
      resealed: [],
    });
  });

  test("keeps nothing on the provisioning machine: the config directory is untouched", async () => {
    const config = await mkdtemp(join(tmpdir(), "pithy-feature-secrets-config-"));
    checkouts.push(config);
    vi.stubEnv("PITHY_CONFIG_DIR", config);

    await provision(await checkout());

    expect(await readdir(config)).toEqual([]);
  });

  test("a secret nothing may invent is neither generated nor sealed — it stays the operator's to supply", async () => {
    await provision(await checkout());
    await expect(workerReads("auth-github-credentials")).rejects.toThrow();
  });

  /**
   * **Finding 1: two machines, in sequence.** A laptop, then a CI runner with nothing on its disk, then the laptop
   * again — each with its own checkout and its own config directory. The first creates; the other two change
   * nothing, and the Worker reads every secret after each.
   */
  test("from two machines in sequence, nothing is regenerated and the Worker reads every secret throughout", async () => {
    const laptop = await checkout();
    const ci = await checkout();
    const configs = [
      await mkdtemp(join(tmpdir(), "pithy-laptop-")),
      await mkdtemp(join(tmpdir(), "pithy-ci-")),
    ] as const;
    checkouts.push(...configs);

    vi.stubEnv("PITHY_CONFIG_DIR", configs[0]);
    await provision(laptop);
    const first = {
      master: entries.get(MASTER_KEY_ENTRY),
      link: entries.get(LINK_KEY_ENTRY),
      rows: await rows(),
      session: await workerReads("auth-session-secret"),
    };

    for (const [dir, config] of [
      [ci, configs[1]],
      [laptop, configs[0]],
    ] as const) {
      vi.stubEnv("PITHY_CONFIG_DIR", config);
      const report = await provision(dir);
      expect(report.featureSecrets?.written).toEqual([]);
      expect(entries.get(MASTER_KEY_ENTRY)).toBe(first.master);
      expect(entries.get(LINK_KEY_ENTRY)).toBe(first.link);
      expect(await rows()).toEqual(first.rows);
      expect(await workerReads("auth-session-secret")).toBe(first.session);
    }
    // One creation per entry, ever.
    expect(creates.sort()).toEqual([LINK_KEY_ENTRY, MASTER_KEY_ENTRY]);
  });

  /**
   * **Finding 2: two machines at once.** Reproduced ten runs in ten as a crash on the unique name or rows the Worker
   * could not open. Every account call here yields, so the two runs interleave at each one.
   */
  test("two concurrent provisions never crash, one seals, and the Worker reads every secret afterwards", async () => {
    for (let round = 0; round < 10; round += 1) {
      entries.clear();
      creates.length = 0;
      await d1.prepare("drop table if exists pithy_secrets_system_secrets").run();
      await d1.prepare("drop table if exists pithy_secrets_rotations").run();

      const reports = await Promise.all([provision(await checkout()), provision(await checkout())]);

      // Exactly one run created the master key, and it sealed; the other sealed nothing under a key of its own.
      expect(creates.filter((name) => name === MASTER_KEY_ENTRY)).toHaveLength(1);
      expect(reports.flatMap((report) => report.featureSecrets?.written ?? [])).toEqual(["auth-session-secret"]);
      expect(await workerReads("auth-session-secret")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await workerReads("email-link-signing-key")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  /**
   * **The run that loses the race seals nothing.** Pinned here without relying on how two runs happen to
   * interleave: the second run is told the key is absent — a listing taken a moment before the first run's
   * create landed — and then loses the create. It must write no row, since the only key it could seal under is
   * one the store will never hold.
   */
  test("a run that loses the master key's create writes no row, and every row still opens", async () => {
    await provision(await checkout());
    const before = await rows();
    const stale: SecretsStore = { ...store(), exists: async (name) => name !== MASTER_KEY_ENTRY && entries.has(name) };

    const report = await provision(await checkout(), d1, undefined, stale);

    expect(report.featureSecrets).toEqual({ sealed: ["auth-session-secret"], written: [], resealed: [] });
    expect(await rows()).toEqual(before);
    expect(await workerReads("auth-session-secret")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  /**
   * **A read that fails is not a row that is absent.** The existence read is the one question a run without the
   * master key asks, and answering it wrongly is how it would decide to write. So a failed read fails the run and
   * writes nothing — on a first run, and on a re-run over rows that are already there.
   */
  test("a failed read of the SECRETS database fails the run and writes nothing", async () => {
    await expect(provision(await checkout(), failingReads(d1))).rejects.toThrow("transient read failure");
    expect(await rows()).toEqual([]);
  });

  test("a failed read over existing rows fails the run and leaves every row as it was", async () => {
    await provision(await checkout());
    const before = await rows();

    await expect(provision(await checkout(), failingReads(d1))).rejects.toThrow("transient read failure");

    expect(await rows()).toEqual(before);
    expect(await workerReads("auth-session-secret")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  /**
   * **The one case the stores alone cannot answer, refused loudly.** A master key that exists beside a `d1` secret
   * that does not — a capability that declared it after the feature was provisioned, or a run that died between
   * creating the key and sealing. The key is write-only from here, so nothing can seal the row.
   */
  test("a master key that exists beside a missing d1 secret is refused by name, and nothing is written", async () => {
    await provision(await checkout());
    const master = entries.get(MASTER_KEY_ENTRY);
    await d1.prepare("delete from pithy_secrets_system_secrets where name = ?").bind("auth-session-secret").run();

    await expect(provision(await checkout(), d1, { attempts: 3, delayMs: 1 })).rejects.toSatisfy(
      (error) =>
        error instanceof PithyError &&
        error.payload.code === "core/conflict" &&
        error.payload.message.includes("auth-session-secret") &&
        (error.payload.action ?? "").includes(MASTER_KEY_ENTRY),
    );
    expect(entries.get(MASTER_KEY_ENTRY)).toBe(master);
    expect(await rows()).toEqual([]);
  });

  test("with the master key gone, a run creates a new one and seals again the rows nothing could open", async () => {
    await provision(await checkout());
    entries.delete(MASTER_KEY_ENTRY);

    const report = await provision(await checkout());

    expect(report.featureSecrets).toMatchObject({ written: [], resealed: ["auth-session-secret"] });
    expect(await workerReads("auth-session-secret")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("never opens the dev secrets file: dev is the only environment that reads it (#159)", async () => {
    const dev = devSecretsFile("acme");
    await mkdir(dirname(dev), { recursive: true });
    await writeFile(dev, JSON.stringify({ "auth-session-secret": { currentVersion: "1", versions: { "1": "DEV" } } }));
    await chmod(dev, 0o000);
    try {
      await provision(await checkout());
    } finally {
      await chmod(dev, 0o600);
      await rm(dev, { force: true });
    }
    expect(await workerReads("auth-session-secret")).not.toBe("DEV");
  });

  test("feature destroy removes the feature's own store entries with the rest of the feature", async () => {
    const dir = await checkout();
    await provision(dir);

    await deprovisionFeature({
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
      store: store(),
      scripts: { exists: async () => false, delete: async () => {} },
      workers: [],
    });

    expect(entries.has(MASTER_KEY_ENTRY)).toBe(false);
    expect(entries.has(LINK_KEY_ENTRY)).toBe(false);
  });
});
