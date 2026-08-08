// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { claimMigrationOwnership } from "@pithy-sh/core/src/migrations/owner";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type MisnamedCandidate, probeAccountEvidence } from "./projectName";

/**
 * The account probe itself — the layer every other doctor test stubs past.
 *
 * `projectName.test.ts` injects `probeAccount`, which replaces this function wholesale. That left the
 * branching *inside* it with no test: which kinds get probed, how a database the account does not hold
 * differs from a listing it would not answer, and whether the `pithy_migrations_owner` stamp is read at
 * all. It is the only path that can reach the `orphaned` verdict, and that verdict tells an adopter a live
 * database is not theirs — an earlier version of this check said so on the strength of a name's shape and
 * would have had them delete a database in use.
 *
 * So the stamp is read from a **real D1** here, through Miniflare and the real `readMigrationOwner`, rather
 * than from a hand-written row. A fake that returns `{ project: "old" }` proves only that the test can
 * type an object; what has to hold is that the bookkeeping one command writes is the bookkeeping another
 * reads back.
 */

/** A D1 the probe can read, stamped or not, backed by real SQLite. */
async function database(stamp?: string): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const miniflare = new Miniflare({ modules: true, script: "export default {};", d1Databases: { DB: "DB" } });
  const db = (await miniflare.getD1Database("DB")) as unknown as D1Database;
  if (stamp) await claimMigrationOwnership(db, { project: stamp });
  return { db, dispose: () => miniflare.dispose() };
}

/** A `CloudflareClients` that answers only what the probe asks of it. */
function account(options: {
  databases?: { name: string; uuid: string }[];
  buckets?: { name: string }[];
  d1?: D1Database;
  listThrows?: boolean;
}): CloudflareClients {
  return {
    d1Provisioner: () => ({
      listDatabases: async () => {
        if (options.listThrows) throw new Error("403 Forbidden");
        return options.databases ?? [];
      },
    }),
    r2Provisioner: () => ({
      listBuckets: async () => {
        if (options.listThrows) throw new Error("403 Forbidden");
        return options.buckets ?? [];
      },
    }),
    d1: () => options.d1,
  } as unknown as CloudflareClients;
}

function candidate(name: string, kind: "d1" | "r2"): MisnamedCandidate {
  return { name, project: "old", kind, worker: "api", env: "dev", binding: kind === "d1" ? "DB" : "MEDIA" };
}

describe("probeAccountEvidence", () => {
  let dir: string;
  const disposers: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-probe-"));
    // Through the environment, not a file in the checkout: the credentials are account-scoped since
    // #182, so `<dir>/.dev.vars` supplies nothing to anybody. The overlay is the other real supply
    // route — it is how CI runs — and it needs no config directory of its own.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const dispose of disposers.splice(0)) await dispose();
    await rm(dir, { recursive: true, force: true });
  });

  test("reads a real owner stamp off a live database — the only path to proof", async () => {
    const { db, dispose } = await database("old-name");
    disposers.push(dispose);
    const evidence = await probeAccountEvidence([candidate("old-name-dev-db", "d1")], () =>
      account({ databases: [{ name: "old-name-dev-db", uuid: "uuid-1" }], d1: db }),
    );
    expect(evidence.get("old-name-dev-db")).toEqual({ exists: true, owner: "old-name" });
  });

  test("a live database Pithy never migrated is present but unowned — existence is not proof", async () => {
    // No stamp: the bookkeeping table does not exist, and `readMigrationOwner` says so without throwing.
    // This is the case that must NOT escalate — an adopter's own database, named their own way.
    const { db, dispose } = await database();
    disposers.push(dispose);
    const evidence = await probeAccountEvidence([candidate("acme-dev-db", "d1")], () =>
      account({ databases: [{ name: "acme-dev-db", uuid: "uuid-1" }], d1: db }),
    );
    expect(evidence.get("acme-dev-db")).toEqual({ exists: true, owner: null });
  });

  test("a database the account does not hold is absent, and no stamp is read for it", async () => {
    const evidence = await probeAccountEvidence([candidate("gone-dev-db", "d1")], () =>
      // `d1` is undefined on purpose: reaching for it would throw, so this also proves the id guard holds.
      account({ databases: [{ name: "other-dev-db", uuid: "uuid-2" }] }),
    );
    expect(evidence.get("gone-dev-db")).toEqual({ exists: false, owner: null });
  });

  test("a listing the token may not read leaves the name unknown, not absent", async () => {
    // The distinction the tri-state exists for. Reporting `exists: false` here would let a permissions
    // gap read as "that resource is gone".
    const evidence = await probeAccountEvidence([candidate("acme-dev-db", "d1")], () => account({ listThrows: true }));
    expect(evidence.has("acme-dev-db")).toBe(false);
  });

  test("buckets are looked up but never carry an owner — R2 records none", async () => {
    const evidence = await probeAccountEvidence(
      [candidate("old-dev-media", "r2"), candidate("gone-dev-media", "r2")],
      () => account({ buckets: [{ name: "old-dev-media" }] }),
    );
    expect(evidence.get("old-dev-media")).toEqual({ exists: true, owner: null });
    expect(evidence.get("gone-dev-media")).toEqual({ exists: false, owner: null });
  });

  test("no credentials means no probe at all — nothing is claimed either way", async () => {
    // `cloudflareEnv` falls through to `process.env` when there is no `cloudflare.json`, so both
    // sources have to be empty for this to be the no-credentials case. Stubbed rather than assumed: a
    // developer with `CLOUDFLARE_ACCOUNT_ID` exported would otherwise have this test reach a real account.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const bare = await mkdtemp(join(tmpdir(), "pithy-probe-bare-"));
    try {
      const evidence = await probeAccountEvidence([candidate("acme-dev-db", "d1")], () => {
        throw new Error("must not reach the account without credentials");
      });
      expect(evidence.size).toBe(0);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
