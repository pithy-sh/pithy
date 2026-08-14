// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { masterKeyRegistryEntry } from "@pithy-sh/secrets/src/capability";
import type { VersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { DevSecretEnvelope } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import type { DevSecretsStore } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import { devSecretPayload } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import { defineSecretRegistry, type SecretValueType } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { StatePathOptions } from "../notifier/state";
import { readDevSecrets } from "./file";
import { devSecretsFile } from "./location";
import { renderDevSecretsNotes } from "./report";
import { seedProjectDevSecrets } from "./seed";
import { type DevSecretsStoreHandle, localDevStorePath } from "./store";

const registry = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  "auth-google-credentials": {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: z
      .object({
        clientId: z.string().describe("The OAuth client id."),
        clientSecret: z.string().describe("The OAuth client secret."),
      })
      .describe("A Google OAuth application's credentials."),
  },
  CLOUDFLARE_API_TOKEN: {
    backend: "cf-secrets-store",
    scope: "global",
    rotatable: false,
    valueType: "text",
  },
});

/** An in-memory stand-in for the local `SECRETS` D1 — the routing is what these tests are about. */
class FakeStore implements DevSecretsStore {
  readonly rows = new Map<string, { value: VersionedValue; valueType: SecretValueType }>();
  writes = 0;
  async getValue(name: string): Promise<VersionedValue | undefined> {
    return this.rows.get(name)?.value;
  }
  async put(name: string, value: VersionedValue, valueType: SecretValueType): Promise<void> {
    this.writes += 1;
    this.rows.set(name, { value, valueType });
  }
}

let dir: string;
let config: string;
/** The resolved secrets file for this test's project — outside `dir`, which is the point of #156. */
let secretsPath: string;
let store: FakeStore;

/** The config seams. A fresh directory per test, so no run can read or write the operator's own file. */
function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-seed-secrets-"));
  config = await mkdtemp(join(tmpdir(), "pithy-seed-config-"));
  // The seeder resolves the file from the project's *name*, so the project needs one.
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "seedling" };\n');
  secretsPath = devSecretsFile("seedling", paths());
  await mkdir(join(config, "seedling"), { recursive: true, mode: 0o700 });
  store = new FakeStore();
});
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

/** Seed one Worker named `board`, against the in-memory store unless a handle is supplied. */
function seed(handle?: DevSecretsStoreHandle) {
  return seedProjectDevSecrets({
    projectDir: dir,
    paths: paths(),
    targets: [{ name: "board", dir: join(dir, "apps", "board"), registry }],
    openStore: async () =>
      handle ?? { ready: true, store, persistPath: localDevStorePath(dir), dispose: async () => {} },
  });
}

/**
 * The upgrade off the old wrapped shape, run by the command every project runs (#323).
 *
 * A `bootstrap` secret needs a Worker that declares one, so this registry adds the master key beside the
 * ordinary secrets above. Everything else is the same seed the rest of this file exercises: the point is
 * that the migration is not a command anybody has to know about.
 */
const withMasterKey = defineSecretRegistry({ ...registry, SECRETS_ENCRYPTION_KEYS: masterKeyRegistryEntry });

/** The `EncryptionConfig` these cases carry. Shape only; the value is not a key anything opens. */
const CONFIG = {
  currentVersion: "1",
  versions: { "1": "a2V5LW1hdGVyaWFs" },
  lastRotatedAt: "2026-08-06T16:21:53.830Z",
};

function seedWithMasterKey() {
  return seedProjectDevSecrets({
    projectDir: dir,
    paths: paths(),
    targets: [{ name: "board", dir: join(dir, "apps", "board"), registry: withMasterKey }],
    openStore: async () => ({ ready: true, store, persistPath: localDevStorePath(dir), dispose: async () => {} }),
  });
}

describe("seedProjectDevSecrets — an existing file is migrated in place", () => {
  test("a wrapped bootstrap payload is restated as the payload, and the run says so", async () => {
    // Written by a pithy older than #323. Nothing about the project changes but the bytes of this file.
    await writeFile(
      secretsPath,
      JSON.stringify({ SECRETS_ENCRYPTION_KEYS: { currentVersion: "1", versions: { "1": CONFIG } } }),
      { mode: 0o600 },
    );

    const report = await seedWithMasterKey();

    expect(report.migrated).toEqual(["SECRETS_ENCRYPTION_KEYS"]);
    expect((await readDevSecrets(secretsPath)).SECRETS_ENCRYPTION_KEYS).toEqual(CONFIG);
    expect(renderDevSecretsNotes(report).join("\n")).toContain("SECRETS_ENCRYPTION_KEYS");
  });

  test("the Worker still gets the same binding across the upgrade — migrating is not a key rotation", async () => {
    await writeFile(
      secretsPath,
      JSON.stringify({ SECRETS_ENCRYPTION_KEYS: { currentVersion: "1", versions: { "1": CONFIG } } }),
      { mode: 0o600 },
    );

    await seedWithMasterKey();
    const after = devSecretPayload(
      masterKeyRegistryEntry,
      "SECRETS_ENCRYPTION_KEYS",
      (await readDevSecrets(secretsPath)).SECRETS_ENCRYPTION_KEYS,
    );

    // The string a `.dev.vars` line carries, before and after. A different one here would orphan every
    // secret already encrypted under the old key, with no error naming the cause.
    expect(after.text).toBe(JSON.stringify(CONFIG));
    expect(after.wrapped).toBe(false);
  });

  test("a second run migrates nothing and rewrites no bytes", async () => {
    await writeFile(
      secretsPath,
      JSON.stringify({ SECRETS_ENCRYPTION_KEYS: { currentVersion: "1", versions: { "1": CONFIG } } }),
      { mode: 0o600 },
    );

    await seedWithMasterKey();
    const settled = await readFile(secretsPath, "utf8");
    const again = await seedWithMasterKey();

    expect(again.migrated).toEqual([]);
    expect(await readFile(secretsPath, "utf8")).toBe(settled);
  });

  test("a file already in the payload shape is left exactly as it is", async () => {
    // Every mintable secret already stated, so a mint cannot account for a byte that changed.
    const original = `// a note the adopter wrote\n${JSON.stringify(
      { SECRETS_ENCRYPTION_KEYS: CONFIG, "auth-session-secret": { currentVersion: "1", versions: { "1": "s3ss10n" } } },
      null,
      2,
    )}\n`;
    await writeFile(secretsPath, original, { mode: 0o600 });

    const report = await seedWithMasterKey();

    expect(report.migrated).toEqual([]);
    expect(await readFile(secretsPath, "utf8")).toBe(original);
  });

  test("every other secret in the file survives the migration, comments and all", async () => {
    const original = `// where these came from\n${JSON.stringify(
      {
        SECRETS_ENCRYPTION_KEYS: { currentVersion: "1", versions: { "1": CONFIG } },
        "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "id", clientSecret: "shh" } } },
      },
      null,
      2,
    )}\n`;
    await writeFile(secretsPath, original, { mode: 0o600 });

    await seedWithMasterKey();
    const after = await readFile(secretsPath, "utf8");

    expect(after).toContain("// where these came from");
    expect((await readDevSecrets(secretsPath))["auth-google-credentials"]).toEqual({
      currentVersion: "1",
      versions: { "1": { clientId: "id", clientSecret: "shh" } },
    });
  });
});

describe("seedProjectDevSecrets", () => {
  test("mints the generatable secret into the file and seeds it — one path, not two", async () => {
    const report = await seed();

    expect(report.minted).toEqual(["auth-session-secret"]);
    expect(report.seeded).toEqual(["auth-session-secret"]);
    const envelope = DevSecretEnvelope.parse((await readDevSecrets(secretsPath))["auth-session-secret"]);
    expect(envelope.currentVersion).toBe("1");
    expect(store.rows.get("auth-session-secret")?.value).toEqual(envelope);
  });

  test("the file it writes is 0600, on the first write and on the second", async () => {
    await seed();
    await writeFile(
      secretsPath,
      `${(await readFile(secretsPath, "utf8")).trimEnd().slice(0, -1)},
  "auth-google-credentials": { "currentVersion": "1", "versions": { "1": { "clientId": "a", "clientSecret": "b" } } }
}
`,
    );
    await seed();
    expect((await stat(secretsPath)).mode & 0o777).toBe(0o600);
  });

  test("a secret nothing can honestly mint is named missing, not invented", async () => {
    // Both of these must come from somewhere real: Google's console issued one, Cloudflare the other.
    // A generated value would authenticate against nothing and hide the gap behind one that looks filled.
    const report = await seed();
    expect(report.missing).toEqual(["CLOUDFLARE_API_TOKEN", "auth-google-credentials"]);
  });

  test("a cf-secrets-store secret comes back as a .dev.vars line — there is no local store", async () => {
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), "{}\n");
    await writeFile(
      secretsPath,
      '{ "CLOUDFLARE_API_TOKEN": { "currentVersion": "1", "versions": { "1": "cf-token" } } }',
    );
    const report = await seed();

    // The whole list, not just a member of it: since #153 a `cf-secrets-store` secret is the only kind
    // that reaches `.dev.vars` at all, and asserting containment would not have noticed the difference.
    expect(report.devVars).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(store.rows.has("CLOUDFLARE_API_TOKEN")).toBe(false);
    // Where wrangler reads it: the Worker's own generated file, not the project root (#154).
    const beside = join(dir, "apps", "board", ".dev.vars");
    expect(parseDevVars(await readFile(beside, "utf8")).CLOUDFLARE_API_TOKEN).toContain("cf-token");
  });

  test("re-running seeds nothing and mints nothing — idempotent, and it never rotates", async () => {
    const first = await seed();
    const minted = (await readDevSecrets(secretsPath))["auth-session-secret"];
    const bytes = await readFile(secretsPath, "utf8");

    const second = await seed();

    expect(first.seeded).toEqual(["auth-session-secret"]);
    expect(second.seeded).toEqual([]);
    expect(second.minted).toEqual([]);
    expect(second.unchanged).toEqual(["auth-session-secret"]);
    // Not one write on the second run: re-encrypting an unchanged value churns `updated_at` and the
    // ciphertext, and a value replaced is every live session gone.
    expect(store.writes).toBe(1);
    expect((await readDevSecrets(secretsPath))["auth-session-secret"]).toEqual(minted);
    expect(await readFile(secretsPath, "utf8")).toBe(bytes);
  });

  test("a d1 secret reaches the store and nothing else — .dev.vars is not written at all (#153)", async () => {
    // The dual-write, deleted. Dev routes by backend now, so the row is the whole delivery: a copy in
    // `.dev.vars` would be a second plaintext of the session key in a file with no reader.
    const report = await seed();

    expect(report.seeded).toEqual(["auth-session-secret"]);
    expect(report.devVars).toEqual([]);
    // No file at all, rather than a file without the name in it: nothing else in this run writes one.
    await expect(readFile(join(dir, ".dev.vars"), "utf8")).rejects.toThrow();
  });

  test("a secret still only in .dev.vars is not re-injected — nothing rewrites the adopter's line", async () => {
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=already-mine\n");

    await seed();

    expect(parseDevVars(await readFile(join(dir, ".dev.vars"), "utf8"))["auth-session-secret"]).toBe("already-mine");
  });

  test("a value changed in the file is written through — the file is dev's source of truth", async () => {
    await seed();
    await writeFile(
      secretsPath,
      '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "edited-by-hand" } } }',
    );

    const report = await seed();

    expect(report.seeded).toEqual(["auth-session-secret"]);
    expect(store.rows.get("auth-session-secret")?.value.versions["1"]).toBe("edited-by-hand");
  });

  test("a secret stranded in .dev.vars is minted and seeded anyway — that line signs nothing now", async () => {
    // The migration case, inverted by #153. It used to be dev's live value, so minting beside it made
    // two values with nothing to say which signed what, and the run had to stand down. Dev reads the
    // seeded row now: standing down would leave the Worker with no session key at all. So it mints,
    // seeds, and leaves their file exactly as it found it — `pithy doctor` names the stranded line.
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=already-mine\n");

    const report = await seed();

    expect(report.minted).toEqual(["auth-session-secret"]);
    expect(report.seeded).toEqual(["auth-session-secret"]);
    expect(parseDevVars(await readFile(join(dir, ".dev.vars"), "utf8"))["auth-session-secret"]).toBe("already-mine");
  });

  test("deleting the secret from the file mints a fresh one, whatever .dev.vars still holds", async () => {
    // Deleting the entry is the obvious way to ask for a new value, and a leftover line in `.dev.vars`
    // used to suppress every mint after the first one — silently, for good.
    const first = await seed();
    expect(first.minted).toEqual(["auth-session-secret"]);
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=left-over\n");
    await rm(secretsPath);

    const second = await seed();

    expect(second.minted).toEqual(["auth-session-secret"]);
    expect(second.seeded).toEqual(["auth-session-secret"]);
  });

  test("a secret named for an Object.prototype key travels the whole path", async () => {
    // `constructor` and `toString` are own-property lookups everywhere here or they answer for
    // `Object.prototype`: a secret read as already present in an empty file, minted and reported and
    // never written. The name is adopter-supplied — a capability author picks it — so it is checked.
    const prototypeRegistry = defineSecretRegistry({
      constructor: { backend: "d1", scope: "environment", rotatable: false, valueType: "text", devValue: "random" },
      toString: { backend: "d1", scope: "environment", rotatable: false, valueType: "text", devValue: "random" },
    });

    const report = await seedProjectDevSecrets({
      projectDir: dir,
      paths: paths(),
      targets: [{ name: "board", dir: join(dir, "apps", "board"), registry: prototypeRegistry }],
      openStore: async () => ({ ready: true, store, persistPath: localDevStorePath(dir), dispose: async () => {} }),
    });

    expect(report.minted).toEqual(["constructor", "toString"]);
    expect(report.seeded).toEqual(["constructor", "toString"]);
    expect(report.undeclared).toEqual([]);
    expect(Object.keys(await readDevSecrets(secretsPath)).sort()).toEqual(["constructor", "toString"]);
    // Both are `d1`, so both land in the store and neither reaches `.dev.vars`.
    expect(report.devVars).toEqual([]);
  });

  test("a secret in both files is seeded from the file — that is the copy the adopter moved", async () => {
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=stale\n");
    await writeFile(secretsPath, '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "moved" } } }');

    const report = await seed();

    expect(report.seeded).toEqual(["auth-session-secret"]);
    expect(store.rows.get("auth-session-secret")?.value.versions["1"]).toBe("moved");
  });

  test("a store that cannot open is a reason, never a thrown command", async () => {
    const report = await seed({ ready: false, reason: "Run pithy migrate.", dispose: async () => {} });

    expect(report.skipped).toEqual([{ worker: "board", reason: "Run pithy migrate." }]);
    expect(report.seeded).toEqual([]);
    // Nothing minted either: a value written into the file that no run seeded is a value the adopter
    // believes is live. The next run, after `pithy migrate`, mints and seeds it together.
    await expect(readFile(secretsPath, "utf8")).rejects.toThrow();
  });

  test("a name no capability declares is reported, never fatal — a removed capability must not brick dev", async () => {
    await writeFile(secretsPath, '{ "gone-capability-key": { "currentVersion": "1", "versions": { "1": "x" } } }');
    const report = await seed();
    expect(report.undeclared).toEqual(["gone-capability-key"]);
  });

  test("two Workers declaring the same secret mint it once — the second sees the first's value", async () => {
    const report = await seedProjectDevSecrets({
      projectDir: dir,
      paths: paths(),
      targets: [
        { name: "board", dir: join(dir, "apps", "board"), registry },
        { name: "api", dir: join(dir, "apps", "api"), registry },
      ],
      openStore: async () => ({ ready: true, store, persistPath: localDevStorePath(dir), dispose: async () => {} }),
    });

    expect(report.minted).toEqual(["auth-session-secret"]);
    expect(Object.keys(await readDevSecrets(secretsPath))).toEqual(["auth-session-secret"]);
  });

  test("with no registry to consult, nothing in the file is called undeclared", async () => {
    // `pithy add auth` in a project that has not composed `secrets` mints into the file and has no
    // registry to check it against. Reporting the value it just minted as one no capability declares
    // was a statement it had no standing to make — and it made it, in the real CLI, out loud.
    await writeFile(secretsPath, '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "v" } } }');
    const report = await seedProjectDevSecrets({
      projectDir: dir,
      paths: paths(),
      targets: [],
      openStore: async () => ({ ready: true, store, persistPath: localDevStorePath(dir), dispose: async () => {} }),
    });
    expect(report.undeclared).toEqual([]);
  });

  test("no Worker composes secrets: nothing happens, and nothing is claimed to have happened", async () => {
    const report = await seedProjectDevSecrets({
      projectDir: dir,
      paths: paths(),
      targets: [],
      openStore: async () => ({ ready: true, store, persistPath: localDevStorePath(dir), dispose: async () => {} }),
    });
    expect(report).toEqual({
      path: secretsPath,
      migrated: [],
      seeded: [],
      unchanged: [],
      minted: [],
      devVars: [],
      missing: [],
      undeclared: [],
      skipped: [],
      devVarsRefused: [],
      relinked: [],
    });
  });

  test("the run names the file it minted into — nothing in the project points at it", async () => {
    // The file is outside the checkout (#156), so "Minted auth-session-secret. Local only." is a
    // sentence about a file the reader cannot find. The path is the actionable half.
    const report = await seed();

    expect(report.path).toBe(secretsPath);
    expect(renderDevSecretsNotes(report).join("\n")).toContain(secretsPath);
  });

  test("a mint leaves nothing about secrets in the checkout — not the file, not a .gitignore line", async () => {
    // The run used to write the project's `.gitignore` before writing a byte of secret, and refuse the
    // whole mint when it could not. There is nothing in the repository to ignore now, so a seeding run
    // touches `.gitignore` never and leaves the checkout with `.dev.vars` and its own files alone.
    const report = await seed();

    expect(report.minted).toEqual(["auth-session-secret"]);
    // Not even `.dev.vars` now (#153): a `d1` secret's whole delivery is the row, so this run creates
    // no file in the checkout at all.
    expect((await readdir(dir)).sort()).toEqual(["pithy.config.ts"]);
  });

  test("the file holds a minted value before the store does — a row with no file is unrecoverable", async () => {
    // Proved by the store failing: the value is on disk, so the next run re-uses it rather than
    // minting a second one. The other order left D1 holding a value the file had never heard of.
    const failing: DevSecretsStoreHandle = {
      ready: true,
      store: {
        getValue: async () => undefined,
        put: async () => {
          throw new Error("D1 is gone");
        },
      },
      persistPath: localDevStorePath(dir),
      dispose: async () => {},
    };

    await expect(seed(failing)).rejects.toThrow(/D1 is gone/);

    const envelope = DevSecretEnvelope.parse((await readDevSecrets(secretsPath))["auth-session-secret"]);
    expect(typeof envelope.versions["1"]).toBe("string");
  });

  test("every store it opens is disposed — a leaked Miniflare holds the local D1 open", async () => {
    let disposals = 0;
    await seedProjectDevSecrets({
      projectDir: dir,
      targets: [
        { name: "board", dir: join(dir, "apps", "board"), registry },
        { name: "api", dir: join(dir, "apps", "api"), registry },
      ],
      openStore: async () => ({
        ready: true,
        store,
        persistPath: localDevStorePath(dir),
        dispose: async () => {
          disposals += 1;
        },
      }),
    });
    expect(disposals).toBe(2);
  });

  test("a malformed file is the loader's error, raised before anything is written", async () => {
    await writeFile(secretsPath, '{ "auth-session-secret": "bare-value" }');
    await expect(seed()).rejects.toThrow(/not a versioned envelope/);
    expect(store.writes).toBe(0);
  });
});

/**
 * #159. The dev secrets file holds minted random dev values, so seeding it into staging or production
 * would not set some secrets — it would rotate every one at once, with no undo, because the values it
 * overwrote were the only copies. The refusal belongs in the seeder rather than in one of its callers.
 */
describe("the environment boundary", () => {
  test("a store that is not this project's local dev store is refused, whatever the caller passed", async () => {
    // The destination is asserted, not the intent. A caller can still hand the seeder a handle bound to
    // a remote D1 — a `--env prod` path that grew a store seam, a helper that took the wrong project
    // root — and a parameter that says "dev" would have blessed it.
    await expect(
      seedProjectDevSecrets({
        projectDir: dir,
        targets: [{ name: "board", dir: join(dir, "apps", "board"), registry }],
        openStore: async () => ({
          ready: true,
          store,
          persistPath: join(dir, "..", "somebody-elses-project", ".wrangler", "state", "v3", "d1"),
          dispose: async () => {},
        }),
      }),
    ).rejects.toThrow(/local dev store/);
    expect(store.writes).toBe(0);
  });

  test("a store that will not say where it writes is refused too — permissive-by-default is the bug", async () => {
    await expect(
      seedProjectDevSecrets({
        projectDir: dir,
        targets: [{ name: "board", dir: join(dir, "apps", "board"), registry }],
        // A handle from outside TypeScript, or one written before `persistPath` existed. An unresolvable
        // destination is refused for the same reason an unknown environment is: the dangerous default is
        // the permissive one.
        openStore: async () => ({ ready: true, store, dispose: async () => {} }) as unknown as DevSecretsStoreHandle,
      }),
    ).rejects.toThrow(/local dev store/);
    expect(store.writes).toBe(0);
  });

  test("the real local dev store is the one it accepts", async () => {
    const report = await seedProjectDevSecrets({
      projectDir: dir,
      targets: [{ name: "board", dir: join(dir, "apps", "board"), registry }],
      openStore: async () => ({ ready: true, store, persistPath: localDevStorePath(dir), dispose: async () => {} }),
    });
    expect(report.seeded).toContain("auth-session-secret");
  });

  test("nothing carrying a managed environment can reach the seeder", async () => {
    // The tripwire. Four defect classes in this series each had three or more producers, every one
    // because a rule lived at a call site instead of at the thing being called. A seventh caller makes
    // this list grow and the failure names the file: prove it cannot carry an environment, or pin it.
    const root = join(import.meta.dirname, "..");
    const files = await readdir(root, { recursive: true, withFileTypes: true });
    const callers: string[] = [];
    let seedCommand = "";
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".ts") || file.name.endsWith(".test.ts")) continue;
      const full = join(file.parentPath, file.name);
      const text = (await readFile(full, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const path = relative(root, full);
      if (path === join("commands", "seed.ts")) seedCommand = text;
      if (/seedProjectDevSecrets\(/.test(text)) callers.push(path);
    }

    expect(callers.sort()).toEqual(
      [
        // The seeder itself, and the two commands with no environment concept at all.
        join("devSecrets", "seed.ts"),
        join("dev", "orchestrator.ts"),
        join("capabilities", "addBootstrap.ts"),
        // The one caller that has an environment. Its guard stays — belt and braces — and the seeder no
        // longer depends on it, which is the point of #159.
        join("commands", "seed.ts"),
      ].sort(),
    );
    expect(seedCommand).toMatch(/env === "dev"[\s\S]{0,120}seedProjectDevSecrets\(/);
  });
});
