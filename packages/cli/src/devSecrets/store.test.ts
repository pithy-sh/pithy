// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { secretsTables } from "@pithy-sh/secrets/src/data/tables";
import { initialDevSecret } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/bindings";
import { secrets_0001_init } from "@pithy-sh/secrets/src/migrations/0001_init";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import { devSecretsFile } from "./location";
import { openDevSecretsStore, SECRETS_D1_BINDING } from "./store";

let dir: string;
let workerDir: string;
let config: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-secrets-store-"));
  config = await mkdtemp(join(tmpdir(), "pithy-secrets-store-cfg-"));
  workerDir = join(dir, "apps", "board");
  await mkdir(workerDir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

/** The config seams. Fresh per test, so nothing here can read or write the operator's own file. */
function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

/** A `wrangler.jsonc` declaring the SECRETS binding, the way `pithy add secrets` writes it (no id). */
async function withSecretsBinding(): Promise<void> {
  await writeFile(
    join(workerDir, "wrangler.jsonc"),
    '{ "d1_databases": [{ "binding": "SECRETS", "database_name": "replay-dev-secrets" }] }',
  );
}

/** A `.dev.vars` with a real dev master key, as `pithy add secrets` mints it. */
async function withMasterKey(): Promise<void> {
  await writeFile(
    join(dir, ".dev.vars"),
    `SECRETS_ENCRYPTION_KEYS=${JSON.stringify(await initialMasterKeyConfig())}\n`,
  );
}

/**
 * Migrate the same Miniflare store `openDevSecretsStore` opens — same persistence root, same resolved
 * database identity (`database_id` else the binding). If those two ever disagree, this test is what says
 * so: the store would come back ready and read an empty database the Worker never writes to.
 */
async function migrateLocalSecrets(): Promise<void> {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { [SECRETS_D1_BINDING]: SECRETS_D1_BINDING },
    d1Persist: join(dir, ".wrangler", "state", "v3", "d1"),
  });
  try {
    const d1 = (await miniflare.getD1Database(SECRETS_D1_BINDING)) as unknown as D1Database;
    await secrets_0001_init.up(createDatabase(d1, secretsTables));
  } finally {
    await miniflare.dispose();
  }
}

describe("openDevSecretsStore", () => {
  test("a Worker with no SECRETS binding is not an error — it names the command that adds one", async () => {
    await writeFile(join(workerDir, "wrangler.jsonc"), '{ "d1_databases": [] }');
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir, worker: "board" });
    expect(handle.ready).toBe(false);
    expect(handle.ready === false && handle.reason).toContain("pithy add secrets --worker board");
  });

  test("no master key names the master key, not the database", async () => {
    await withSecretsBinding();
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir });
    expect(handle.ready).toBe(false);
    expect(handle.ready === false && handle.reason).toContain("SECRETS_ENCRYPTION_KEYS");
  });

  test("an unmigrated database says pithy migrate — no adopter can act on `no such table`", async () => {
    await withSecretsBinding();
    await withMasterKey();
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir });
    await handle.dispose();
    expect(handle.ready).toBe(false);
    expect(handle.ready === false && handle.reason).toContain("pithy migrate");
  });

  test("a master key that is not a key config says so, instead of blaming the migration", async () => {
    await withSecretsBinding();
    await migrateLocalSecrets();
    await writeFile(join(dir, ".dev.vars"), "SECRETS_ENCRYPTION_KEYS=not-json\n");
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir });
    await handle.dispose();
    expect(handle.ready).toBe(false);
    expect(handle.ready === false && handle.reason).toContain("not a valid master key");
  });

  test("a migrated project opens the store the Worker itself reads — a put comes back out", async () => {
    await withSecretsBinding();
    await withMasterKey();
    await migrateLocalSecrets();

    const handle = await openDevSecretsStore({ projectDir: dir, workerDir });
    expect(handle.ready).toBe(true);
    if (!handle.ready) return;
    try {
      await handle.store.put("auth-session-secret", { currentVersion: "1", versions: { "1": "value" } }, "text");
      expect(await handle.store.getValue("auth-session-secret")).toEqual({
        currentVersion: "1",
        versions: { "1": "value" },
      });
    } finally {
      await handle.dispose();
    }
  });

  test("what it writes persists where wrangler dev looks — a second open finds the first one's row", async () => {
    await withSecretsBinding();
    await withMasterKey();
    await migrateLocalSecrets();

    const first = await openDevSecretsStore({ projectDir: dir, workerDir });
    if (!first.ready) throw new Error(first.reason);
    await first.store.put("auth-session-secret", { currentVersion: "1", versions: { "1": "value" } }, "text");
    await first.dispose();

    const second = await openDevSecretsStore({ projectDir: dir, workerDir });
    if (!second.ready) throw new Error(second.reason);
    try {
      expect(await second.store.getValue("auth-session-secret")).toBeDefined();
    } finally {
      await second.dispose();
    }
  });
});

/**
 * **The invariant, stated once: every failure to read a *stated* secret names the secret and says why.**
 *
 * `No SECRETS_ENCRYPTION_KEYS recorded` is a claim about the file, and it may only be made when the file
 * makes no claim. A bare `catch {}` made it about three states at once — no project name, an unreadable
 * file, and a value that is present and fails its schema — and the third is a false statement about the
 * world whose suggested remedy then does nothing, because a key is already there (#323).
 *
 * The cases below are corruptions, not messages. Each is a different way a stated master key can fail to
 * read, and the assertion is the same for all of them, because the rule is about the answer.
 */
const unreadableStatements: Record<string, unknown> = {
  "the value written bare, without its envelope": {
    currentVersion: "1",
    versions: { "1": "a2V5LW1hdGVyaWFs" },
    lastRotatedAt: "2026-08-06T16:21:53.830Z",
  },
  "an envelope whose version holds a string where a key config belongs": {
    currentVersion: "1",
    versions: { "1": "a2V5LW1hdGVyaWFs" },
  },
  "an envelope whose key config is missing lastRotatedAt": {
    currentVersion: "1",
    versions: { "1": { currentVersion: "1", versions: { "1": "a2V5LW1hdGVyaWFs" } } },
  },
  "an envelope pointing at a version it does not carry": {
    currentVersion: "2",
    versions: {
      "1": { currentVersion: "1", versions: { "1": "a2V5LW1hdGVyaWFs" }, lastRotatedAt: "2026-08-06T16:21:53.830Z" },
    },
  },
  "not an object at all": "a2V5LW1hdGVyaWFs",
};

describe("a stated master key that will not read", () => {
  /** A named project — the secrets file is resolved from the name, so without one there is no file. */
  async function namedProject(): Promise<void> {
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
  }

  /** State one value at the path the CLI resolves for this project, and answer with that path. */
  async function state(value: unknown): Promise<string> {
    const file = devSecretsFile("replay", paths());
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ [MASTER_KEY_BINDING]: value }), { mode: 0o600 });
    return file;
  }

  async function reasonFor(value: unknown): Promise<{ reason: string; file: string }> {
    await namedProject();
    await withSecretsBinding();
    const file = await state(value);
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir, worker: "board", paths: paths() });
    await handle.dispose();
    if (handle.ready) throw new Error("expected the store to refuse to open");
    return { reason: handle.reason, file };
  }

  for (const [corruption, value] of Object.entries(unreadableStatements)) {
    test(`${corruption} is named, not called absent`, async () => {
      const { reason, file } = await reasonFor(value);

      expect(reason).toContain(MASTER_KEY_BINDING);
      expect(reason).toContain(file);
      expect(reason).not.toContain(`No ${MASTER_KEY_BINDING} recorded`);
      // The file holds key material. A sentence about its shape reaches a terminal and a log.
      expect(reason).not.toContain("a2V5LW1hdGVyaWFs");
    });
  }

  test("a file that is there and will not open is that, not an absent key", async () => {
    await namedProject();
    await withSecretsBinding();
    const file = await state({ currentVersion: "1", versions: { "1": "x" } });
    await chmod(file, 0o000);
    try {
      const handle = await openDevSecretsStore({ projectDir: dir, workerDir, worker: "board", paths: paths() });
      await handle.dispose();
      expect(handle.ready).toBe(false);
      expect(handle.ready === false && handle.reason).toContain(file);
      expect(handle.ready === false && handle.reason).not.toContain(`No ${MASTER_KEY_BINDING} recorded`);
    } finally {
      await chmod(file, 0o600);
    }
  });

  test("a named project with no file at all is the one state 'not recorded' is true of", async () => {
    await namedProject();
    await withSecretsBinding();
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir, worker: "board", paths: paths() });
    await handle.dispose();
    expect(handle.ready).toBe(false);
    expect(handle.ready === false && handle.reason).toBe(
      `No ${MASTER_KEY_BINDING} recorded. Run pithy add secrets --worker board.`,
    );
  });

  test("a nameless project says so — the file is resolved from the name, so there is no file", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    await withSecretsBinding();
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir, worker: "board", paths: paths() });
    await handle.dispose();
    expect(handle.ready).toBe(false);
    expect(handle.ready === false && handle.reason).toContain(MASTER_KEY_BINDING);
    expect(handle.ready === false && handle.reason).toContain("pithy.config.ts has no `name`");
  });

  test("no project at all says that, and not that a key is missing from a file nobody located", async () => {
    await withSecretsBinding();
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir, worker: "board", paths: paths() });
    await handle.dispose();
    expect(handle.ready).toBe(false);
    expect(handle.ready === false && handle.reason).toContain("No pithy.config.ts here");
  });

  test("a stated key that reads is used — the whole point of naming the failures is that this one works", async () => {
    await namedProject();
    await withSecretsBinding();
    await migrateLocalSecrets();
    await state(initialDevSecret(await initialMasterKeyConfig()));
    const handle = await openDevSecretsStore({ projectDir: dir, workerDir, worker: "board", paths: paths() });
    try {
      expect(handle.ready).toBe(true);
    } finally {
      await handle.dispose();
    }
  });
});
