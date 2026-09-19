// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { secretsTables } from "@pithy-sh/secrets/src/data/tables";
import { secrets_0001_init } from "@pithy-sh/secrets/src/migrations/0001_init";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { secretsStore } from "@pithy-sh/secrets/src/secretsStore";
import { parse } from "comment-json";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { devSecretsFile } from "../devSecrets/location";
import type { StatePathOptions } from "../notifier/state";
import type { ResourceProvisioner, ResourceProvisioners } from "../provision/resources";
import { deprovisionFeature, provisionFeature } from "./provision";
import { featureSecretsPath } from "./secrets";

/**
 * **A feature's own secrets: generated once, at provision, and kept (#643).**
 *
 * The review reproduced it: a feature had no `auth-session-secret`, so magic link and OTP answered
 * `404 secrets/not_found`, and the feature seed signed its dev login with a fresh random value per run that
 * nothing kept, so no claim could ever verify. The direction: `provision --feature` creates the feature's own
 * secrets with stable values, the Worker reads them, and the seed signs with those same values.
 *
 * What stands in for Cloudflare: the Secrets Store is a map, and the feature's `SECRETS` D1 is a Miniflare D1 —
 * the database a deployed Worker reads its `d1` secrets from, handed to provisioning through its seam. The read
 * that proves it is the Worker's own: `secretsStore`, over that D1 and the master key the store was given.
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

/** An in-memory provisioner over a name→id map, as the real adapter behaves. */
function fakeKind(kind: string): ResourceProvisioner {
  const names = new Map<string, string>();
  let seq = 0;
  return {
    find: async (name) => (names.has(name) ? { id: names.get(name) as string } : null),
    create: async (name) => {
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

let dir: string;
let config: string;
let miniflare: Miniflare;
let d1: D1Database;
let entries: Map<string, string>;
let provisioners: ResourceProvisioners;
/** The database ids provisioning asked the seam for. */
let asked: string[];

/** The config seams: this test's own directory, never the operator's. */
function paths(): StatePathOptions {
  return { env: { PITHY_CONFIG_DIR: config } };
}

const store = () => ({
  storeId: "store-1",
  exists: async (name: string) => entries.has(name),
  put: async (name: string, value: string) => void entries.set(name, value),
  remove: async (name: string) => entries.delete(name),
});

/** One provisioning run, as `pithy provision --feature` makes it — migrate included, seed stubbed. */
function provision() {
  return provisionFeature({
    administersItself: false,
    projectDir: dir,
    capabilities,
    identity,
    provisioners,
    store: store(),
    paths: paths(),
    resolveWorkers: async () => [{ name: "acme-board", dir: join(dir, "apps", "board"), capabilities }],
    // What `pithy migrate --env feature` does to the feature's SECRETS database: its schema, before any row.
    migrate: async () => {
      await secrets_0001_init.up(createDatabase(d1, secretsTables)).catch(() => {});
    },
    seed: async () => {},
    secretsDatabase: (databaseId) => {
      asked.push(databaseId);
      return d1;
    },
  });
}

/** Read one secret the way the deployed Worker does: its SECRETS D1, and the master key its binding resolves. */
async function workerReads(name: keyof typeof REGISTRY): Promise<string> {
  const masterKey = entries.get(MASTER_KEY_ENTRY);
  if (masterKey === undefined) throw new Error("no master key in the store");
  // Every secret by its own route: a `d1` one from the sealed row, a store one off its binding, as deployed.
  const env = { SECRETS: d1, SECRETS_ENCRYPTION_KEYS: masterKey, EMAIL_LINK_SIGNING_KEY: entries.get(LINK_KEY_ENTRY) };
  const accessor = await secretsStore(env, REGISTRY);
  return String(accessor.get(name));
}

/** The kept file, as the seed reads it. */
async function kept(): Promise<Record<string, { versions: Record<string, string> } | unknown>> {
  // JSONC, as the dev secrets file is: a header comment, then the values. Plain JSON once parsed.
  return JSON.parse(JSON.stringify(parse(await readFile(featureSecretsPath(identity, paths()), "utf8"))));
}

function keptValue(file: Record<string, unknown>, name: string): string | undefined {
  const envelope = file[name] as { currentVersion: string; versions: Record<string, string> } | undefined;
  return envelope?.versions[envelope.currentVersion];
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-feature-secrets-"));
  config = await mkdtemp(join(tmpdir(), "pithy-feature-secrets-config-"));
  await mkdir(join(dir, "apps", "board"), { recursive: true });
  await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), '{ "name": "acme-board" }\n');
  miniflare = new Miniflare({ modules: true, script: "export default {};", d1Databases: { SECRETS: "SECRETS" } });
  d1 = (await miniflare.getD1Database("SECRETS")) as unknown as D1Database;
  entries = new Map();
  asked = [];
  provisioners = { d1: fakeKind("d1"), kv: fakeKind("kv"), r2: fakeKind("r2") } as unknown as ResourceProvisioners;
});

afterEach(async () => {
  await miniflare.dispose();
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

describe("pithy provision --feature, and the feature's own secrets", () => {
  test("seals every generated d1 secret into the feature's SECRETS database, where the Worker reads it", async () => {
    const report = await provision();

    const file = await kept();
    const session = keptValue(file, "auth-session-secret");
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The Worker's own read, over the database it is bound to and the master key its binding resolves.
    expect(await workerReads("auth-session-secret")).toBe(session);
    // The seam was handed the SECRETS database provisioning created, not some other binding's.
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked).size).toBe(1);

    expect(report.featureSecrets).toEqual({
      path: featureSecretsPath(identity, paths()),
      sealed: ["auth-session-secret"],
      written: ["auth-session-secret"],
      regenerated: [],
    });
  });

  test("the store holds the kept values: the master key the Worker decrypts with, and the link key", async () => {
    await provision();
    const file = await kept();

    expect(JSON.parse(entries.get(MASTER_KEY_ENTRY) as string)).toEqual(file.SECRETS_ENCRYPTION_KEYS);
    expect(await workerReads("email-link-signing-key")).toBe(keptValue(file, "email-link-signing-key"));
  });

  test("a secret nothing may invent is neither generated nor sealed — it stays the operator's to supply", async () => {
    await provision();
    expect((await kept())["auth-github-credentials"]).toBeUndefined();
    await expect(workerReads("auth-github-credentials")).rejects.toThrow();
  });

  test("the kept file is the operator's alone: mode 600, in a 700 directory under the config dir", async () => {
    await provision();
    const path = featureSecretsPath(identity, paths());
    expect(path.startsWith(join(config, "acme"))).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  test("a re-run rotates nothing: the same values in the file, the store, and the database", async () => {
    await provision();
    const before = { file: await kept(), master: entries.get(MASTER_KEY_ENTRY), link: entries.get(LINK_KEY_ENTRY) };
    const session = await workerReads("auth-session-secret");

    const report = await provision();

    expect(await kept()).toEqual(before.file);
    expect(entries.get(MASTER_KEY_ENTRY)).toBe(before.master);
    expect(entries.get(LINK_KEY_ENTRY)).toBe(before.link);
    expect(await workerReads("auth-session-secret")).toBe(session);
    expect(report.featureSecrets).toMatchObject({ sealed: ["auth-session-secret"], written: [], regenerated: [] });
  });

  test("with the kept copy gone, the run says it regenerated them — never a silent rotation", async () => {
    await provision();
    const old = await workerReads("auth-session-secret");
    await rm(featureSecretsPath(identity, paths()));

    const report = await provision();

    const session = keptValue(await kept(), "auth-session-secret");
    expect(session).not.toBe(old);
    // Loud, and consistent: every value the deployment holds is the one now kept.
    expect(report.featureSecrets?.regenerated).toEqual([
      "SECRETS_ENCRYPTION_KEYS",
      "auth-session-secret",
      "email-link-signing-key",
    ]);
    expect(await workerReads("auth-session-secret")).toBe(session);
    expect(await workerReads("email-link-signing-key")).toBe(keptValue(await kept(), "email-link-signing-key"));
  });

  test("never opens the dev secrets file: dev is the only environment that reads it (#159)", async () => {
    const dev = devSecretsFile("acme", paths());
    await mkdir(dirname(dev), { recursive: true });
    await writeFile(dev, JSON.stringify({ "auth-session-secret": { currentVersion: "1", versions: { "1": "DEV" } } }));
    await chmod(dev, 0o000);
    try {
      await provision();
    } finally {
      await chmod(dev, 0o600);
    }
    expect(await workerReads("auth-session-secret")).not.toBe("DEV");
  });

  test("feature destroy removes the kept values with the rest of the feature", async () => {
    await provision();
    const path = featureSecretsPath(identity, paths());
    await stat(path);

    await deprovisionFeature({
      projectDir: dir,
      identity,
      capabilities,
      env: "feature",
      provisioners,
      store: store(),
      paths: paths(),
      scripts: { exists: async () => false, delete: async () => {} },
      workers: [],
    });

    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(entries.has(MASTER_KEY_ENTRY)).toBe(false);
  });
});

describe("featureSecretsPath", () => {
  test("is keyed by project and feature, and is never the dev secrets file", () => {
    const path = featureSecretsPath(identity, paths());
    expect(path).toBe(join(config, "acme", "features", "f643-feature-address.secrets.jsonc"));
    expect(path).not.toBe(devSecretsFile("acme", paths()));
    expect(featureSecretsPath({ ...identity, slug: "other" }, paths())).not.toBe(path);
  });
});
