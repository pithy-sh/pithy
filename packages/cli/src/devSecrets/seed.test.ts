// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import type { VersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import type { DevSecretsStore } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import { defineSecretRegistry, type SecretValueType } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { devSecretsPath, readDevSecrets } from "./file";
import { seedProjectDevSecrets } from "./seed";
import type { DevSecretsStoreHandle } from "./store";

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
let store: FakeStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-seed-secrets-"));
  store = new FakeStore();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Seed one Worker named `board`, against the in-memory store unless a handle is supplied. */
function seed(handle?: DevSecretsStoreHandle) {
  return seedProjectDevSecrets({
    projectDir: dir,
    targets: [{ name: "board", dir: join(dir, "apps", "board"), registry }],
    openStore: async () => handle ?? { ready: true, store, dispose: async () => {} },
  });
}

describe("seedProjectDevSecrets", () => {
  test("mints the generatable secret into the file and seeds it — one path, not two", async () => {
    const report = await seed();

    expect(report.minted).toEqual(["auth-session-secret"]);
    expect(report.seeded).toEqual(["auth-session-secret"]);
    const envelope = (await readDevSecrets(dir))["auth-session-secret"];
    expect(envelope?.currentVersion).toBe("1");
    expect(store.rows.get("auth-session-secret")?.value).toEqual(envelope);
  });

  test("the file it writes is 0600, on the first write and on the second", async () => {
    await seed();
    await writeFile(
      devSecretsPath(dir),
      `${(await readFile(devSecretsPath(dir), "utf8")).trimEnd().slice(0, -1)},
  "auth-google-credentials": { "currentVersion": "1", "versions": { "1": { "clientId": "a", "clientSecret": "b" } } }
}
`,
    );
    await seed();
    expect((await stat(devSecretsPath(dir))).mode & 0o777).toBe(0o600);
  });

  test("a secret nothing can honestly mint is named missing, not invented", async () => {
    // Both of these must come from somewhere real: Google's console issued one, Cloudflare the other.
    // A generated value would authenticate against nothing and hide the gap behind one that looks filled.
    const report = await seed();
    expect(report.missing).toEqual(["CLOUDFLARE_API_TOKEN", "auth-google-credentials"]);
  });

  test("a cf-secrets-store secret comes back as a .dev.vars line — there is no local store", async () => {
    await writeFile(
      devSecretsPath(dir),
      '{ "CLOUDFLARE_API_TOKEN": { "currentVersion": "1", "versions": { "1": "cf-token" } } }',
    );
    const report = await seed();

    expect(report.devVars).toContain("CLOUDFLARE_API_TOKEN");
    // The one that matters here: it never reaches the store. `.dev.vars` also carries the transitional
    // copy of every `d1` secret (#153), so the list is not this name alone.
    expect(store.rows.has("CLOUDFLARE_API_TOKEN")).toBe(false);
    expect(parseDevVars(await readFile(join(dir, ".dev.vars"), "utf8")).CLOUDFLARE_API_TOKEN).toContain("cf-token");
  });

  test("re-running seeds nothing and mints nothing — idempotent, and it never rotates", async () => {
    const first = await seed();
    const minted = (await readDevSecrets(dir))["auth-session-secret"];
    const bytes = await readFile(devSecretsPath(dir), "utf8");

    const second = await seed();

    expect(first.seeded).toEqual(["auth-session-secret"]);
    expect(second.seeded).toEqual([]);
    expect(second.minted).toEqual([]);
    expect(second.unchanged).toEqual(["auth-session-secret"]);
    // Not one write on the second run: re-encrypting an unchanged value churns `updated_at` and the
    // ciphertext, and a value replaced is every live session gone.
    expect(store.writes).toBe(1);
    expect((await readDevSecrets(dir))["auth-session-secret"]).toEqual(minted);
    expect(await readFile(devSecretsPath(dir), "utf8")).toBe(bytes);
  });

  test("a d1 secret is injected into .dev.vars too — dev resolves it from the binding until #153", async () => {
    // The transition. `secretsStore`'s dev branch reads every secret from its injected binding
    // whatever its backend, so a value that only reaches the local SECRETS D1 reaches nothing dev
    // looks at. Seeding without this made `pithy add auth` hand a fresh project a Worker that
    // answers `secrets/not_found` at the first sign-in. Both, until dev routes by backend.
    const report = await seed();

    const injected = parseDevVars(await readFile(join(dir, ".dev.vars"), "utf8"))["auth-session-secret"];
    const envelope = (await readDevSecrets(dir))["auth-session-secret"];
    expect(injected).toBeDefined();
    // The encoded envelope, not the bare value: it is what the store holds, what `decodeVersionedValue`
    // round-trips, and it keeps every version rather than collapsing to whichever one is current.
    expect(JSON.parse(injected ?? "")).toEqual(envelope);
    expect(report.devVars).toContain("auth-session-secret");
  });

  test("the injection tracks the file, so a hand-edited value reaches dev on the next run", async () => {
    await seed();
    await writeFile(
      devSecretsPath(dir),
      '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "edited-by-hand" } } }',
    );

    await seed();

    const injected = parseDevVars(await readFile(join(dir, ".dev.vars"), "utf8"))["auth-session-secret"];
    expect(JSON.parse(injected ?? "").versions["1"]).toBe("edited-by-hand");
  });

  test("a secret still only in .dev.vars is not re-injected — nothing rewrites the adopter's line", async () => {
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=already-mine\n");

    await seed();

    expect(parseDevVars(await readFile(join(dir, ".dev.vars"), "utf8"))["auth-session-secret"]).toBe("already-mine");
  });

  test("a value changed in the file is written through — the file is dev's source of truth", async () => {
    await seed();
    await writeFile(
      devSecretsPath(dir),
      '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "edited-by-hand" } } }',
    );

    const report = await seed();

    expect(report.seeded).toEqual(["auth-session-secret"]);
    expect(store.rows.get("auth-session-secret")?.value.versions["1"]).toBe("edited-by-hand");
  });

  test("a secret still in .dev.vars is left alone entirely — never minted a second value beside it", async () => {
    // The migration case, and the bug it caused: `pithy add` refuses to mint over a `.dev.vars` value,
    // and the seeder minted anyway, so one `pithy add auth` printed "nothing was rewritten" and "minted
    // into .dev.secrets.jsonc" about the same secret — and the project ended up holding both values.
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=already-mine\n");

    const report = await seed();

    expect(report.minted).toEqual([]);
    expect(report.seeded).toEqual([]);
    expect(report.missing).not.toContain("auth-session-secret");
    await expect(readFile(devSecretsPath(dir), "utf8")).rejects.toThrow();
    expect(parseDevVars(await readFile(join(dir, ".dev.vars"), "utf8"))["auth-session-secret"]).toBe("already-mine");
  });

  test("a secret in both files is seeded from the file — that is the copy the adopter moved", async () => {
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=stale\n");
    await writeFile(
      devSecretsPath(dir),
      '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "moved" } } }',
    );

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
    await expect(readFile(devSecretsPath(dir), "utf8")).rejects.toThrow();
  });

  test("a name no capability declares is reported, never fatal — a removed capability must not brick dev", async () => {
    await writeFile(
      devSecretsPath(dir),
      '{ "gone-capability-key": { "currentVersion": "1", "versions": { "1": "x" } } }',
    );
    const report = await seed();
    expect(report.undeclared).toEqual(["gone-capability-key"]);
  });

  test("two Workers declaring the same secret mint it once — the second sees the first's value", async () => {
    const report = await seedProjectDevSecrets({
      projectDir: dir,
      targets: [
        { name: "board", dir: join(dir, "apps", "board"), registry },
        { name: "api", dir: join(dir, "apps", "api"), registry },
      ],
      openStore: async () => ({ ready: true, store, dispose: async () => {} }),
    });

    expect(report.minted).toEqual(["auth-session-secret"]);
    expect(Object.keys(await readDevSecrets(dir))).toEqual(["auth-session-secret"]);
  });

  test("with no registry to consult, nothing in the file is called undeclared", async () => {
    // `pithy add auth` in a project that has not composed `secrets` mints into the file and has no
    // registry to check it against. Reporting the value it just minted as one no capability declares
    // was a statement it had no standing to make — and it made it, in the real CLI, out loud.
    await writeFile(
      devSecretsPath(dir),
      '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "v" } } }',
    );
    const report = await seedProjectDevSecrets({
      projectDir: dir,
      targets: [],
      openStore: async () => ({ ready: true, store, dispose: async () => {} }),
    });
    expect(report.undeclared).toEqual([]);
  });

  test("no Worker composes secrets: nothing happens, and nothing is claimed to have happened", async () => {
    const report = await seedProjectDevSecrets({
      projectDir: dir,
      targets: [],
      openStore: async () => ({ ready: true, store, dispose: async () => {} }),
    });
    expect(report).toEqual({
      seeded: [],
      unchanged: [],
      minted: [],
      devVars: [],
      missing: [],
      undeclared: [],
      skipped: [],
    });
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
        dispose: async () => {
          disposals += 1;
        },
      }),
    });
    expect(disposals).toBe(2);
  });

  test("a malformed file is the loader's error, raised before anything is written", async () => {
    await writeFile(devSecretsPath(dir), '{ "auth-session-secret": "bare-value" }');
    await expect(seed()).rejects.toThrow(/not a versioned envelope/);
    expect(store.writes).toBe(0);
  });
});
