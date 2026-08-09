// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { claimMigrationOwnership } from "@pithy-sh/core/src/migrations/owner";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PITHY_OFFLINE_ENV } from "../cloudflare/config";
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

/** The credential pair `probeAccountEvidence` resolves and hands to its `connect` seam. */
interface Credentials {
  accountId: string;
  apiToken: string;
}

/** That seam's own type, so a recorder below is checked against it rather than cast past it. */
type Connect = (credentials: Credentials) => CloudflareClients;

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
    //
    // **Which means every test below depends on the overlay being on.** `PITHY_OFFLINE` turns it off
    // (#218), so a developer who exported that variable in their shell made four of these fail — and it
    // read as breakage in the code (#227). The unit configs pin it blank for that reason
    // (`vitest.shared.ts`), and the offline case is asserted here rather than arrived at by accident.
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
    const evidence = await probeAccountEvidence([candidate("old-name-dev-db", "d1")], null, () =>
      account({ databases: [{ name: "old-name-dev-db", uuid: "uuid-1" }], d1: db }),
    );
    expect(evidence.get("old-name-dev-db")).toEqual({ exists: true, owner: "old-name" });
  });

  test("a live database Pithy never migrated is present but unowned — existence is not proof", async () => {
    // No stamp: the bookkeeping table does not exist, and `readMigrationOwner` says so without throwing.
    // This is the case that must NOT escalate — an adopter's own database, named their own way.
    const { db, dispose } = await database();
    disposers.push(dispose);
    const evidence = await probeAccountEvidence([candidate("acme-dev-db", "d1")], null, () =>
      account({ databases: [{ name: "acme-dev-db", uuid: "uuid-1" }], d1: db }),
    );
    expect(evidence.get("acme-dev-db")).toEqual({ exists: true, owner: null });
  });

  test("a database the account does not hold is absent, and no stamp is read for it", async () => {
    const evidence = await probeAccountEvidence([candidate("gone-dev-db", "d1")], null, () =>
      // `d1` is undefined on purpose: reaching for it would throw, so this also proves the id guard holds.
      account({ databases: [{ name: "other-dev-db", uuid: "uuid-2" }] }),
    );
    expect(evidence.get("gone-dev-db")).toEqual({ exists: false, owner: null });
  });

  test("a listing the token may not read leaves the name unknown, not absent", async () => {
    // The distinction the tri-state exists for. Reporting `exists: false` here would let a permissions
    // gap read as "that resource is gone".
    const evidence = await probeAccountEvidence([candidate("acme-dev-db", "d1")], null, () =>
      account({ listThrows: true }),
    );
    expect(evidence.has("acme-dev-db")).toBe(false);
  });

  test("buckets are looked up but never carry an owner — R2 records none", async () => {
    const evidence = await probeAccountEvidence(
      [candidate("old-dev-media", "r2"), candidate("gone-dev-media", "r2")],
      null,
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
      const evidence = await probeAccountEvidence([candidate("acme-dev-db", "d1")], null, () => {
        throw new Error("must not reach the account without credentials");
      });
      expect(evidence.size).toBe(0);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("and offline is the same answer with the credentials still exported — the overlay is refused", async () => {
    // The pair from `beforeEach` is still in the environment, and that is the point: `PITHY_OFFLINE`
    // refuses the overlay rather than the file (#218), so a token a shell exported hours ago resolves to
    // nothing. `pithy doctor` in a sandbox therefore probes no account, which is the guarantee the
    // variable exists to give — and the one `PITHY_CONFIG_DIR` alone never gave.
    //
    // Stated with `vi.stubEnv` inside the test, not left to the shell: the ambient value is pinned blank
    // for every unit run (#227), so the only offline path in this suite is the one written down here.
    vi.stubEnv(PITHY_OFFLINE_ENV, "1");
    const evidence = await probeAccountEvidence([candidate("acme-dev-db", "d1")], null, () => {
      throw new Error("must not reach the account while offline");
    });
    expect(evidence.size).toBe(0);
  });
});

/**
 * # Two accounts on one machine, and the verdict that says a database is not yours
 *
 * The account was a **default parameter** here until #234 — `account: CloudflareAccountSelection | null = null`
 * — so every call site said nothing and every resolution read `<config>/cloudflare.json`. A project on
 * `cloudflare.accountName: "beta"` therefore had its resources looked for in *alpha*, found none, and fed
 * that absence to a deduction whose worst answer is `orphaned`: **"this live database is not yours."**
 *
 * That is why this parameter is verified against two real credentials files rather than a stub. The failure
 * is not a failed call, which a type error or a 403 would have caught. It is a confident sentence about
 * somebody else's production database, produced by a command whose entire job is to be trusted about that.
 *
 * The environment carries a third, hostile account throughout — the shell variable a developer exported
 * hours ago, which is exactly what made the original defect invisible on the machine that had it.
 */
describe("probeAccountEvidence resolves the account the project names, not the default file", () => {
  let configDir: string;

  /** Write one account's credentials file. Complete, so the hostile overlay below never fills a gap. */
  async function credentials(name: string | null, accountId: string): Promise<void> {
    const file = name === null ? "cloudflare.json" : `cloudflare.${name}.json`;
    await writeFile(
      join(configDir, file),
      JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: `tok-${accountId}` }),
    );
  }

  /** A `connect` that records the credentials handed to it and answers with an empty account. */
  function recorder(): { seen: Credentials[]; connect: Connect } {
    const seen: Credentials[] = [];
    return {
      seen,
      connect: (credentialPair) => {
        seen.push(credentialPair);
        return account({ databases: [] });
      },
    };
  }

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "pithy-two-accounts-"));
    vi.stubEnv("PITHY_CONFIG_DIR", configDir);
    // The hostile third account, exported for every case below. Nothing may resolve it: both files are
    // complete, and the overlay only ever fills a key the file left empty.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "hostile-acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok-hostile");
    await credentials("alpha", "alpha-acct");
    await credentials("beta", "beta-acct");
    await credentials(null, "default-acct");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(configDir, { recursive: true, force: true });
  });

  test("each project's own account is the one probed, on one machine holding three", async () => {
    const alpha = recorder();
    await probeAccountEvidence([candidate("x-dev-db", "d1")], { accountName: "alpha" }, alpha.connect);
    expect(alpha.seen).toEqual([{ accountId: "alpha-acct", apiToken: "tok-alpha-acct" }]);

    const beta = recorder();
    await probeAccountEvidence([candidate("x-dev-db", "d1")], { accountName: "beta" }, beta.connect);
    expect(beta.seen).toEqual([{ accountId: "beta-acct", apiToken: "tok-beta-acct" }]);

    // And `null` — "this project names no account" — is the unnamed file, which is what it always meant.
    // It is a claim a reviewer can see, not the silence an omitted argument used to be.
    const none = recorder();
    await probeAccountEvidence([candidate("x-dev-db", "d1")], null, none.connect);
    expect(none.seen).toEqual([{ accountId: "default-acct", apiToken: "tok-default-acct" }]);
  });

  test("a pin the credentials contradict refuses before the network, and claims nothing", async () => {
    // `cloudflare.beta.json` holds beta's credentials; the project pins alpha's id. The two disagree, so
    // there is no account this run is entitled to ask — and asking the wrong one is how `orphaned` gets
    // said about a database that is fine.
    const reached = vi.fn<Connect>(() => {
      throw new Error("nothing may call Cloudflare with credentials the project does not claim");
    });
    const evidence = await probeAccountEvidence(
      [candidate("x-dev-db", "d1")],
      { accountName: "beta", accountId: "alpha-acct" },
      reached,
    );
    expect(reached).not.toHaveBeenCalled();
    // Empty, not partial: no entry means "never established", which keeps the verdict on the local
    // deduction. `pithy doctor`'s own `Cloudflare:` line is what reports the mismatch — one fact, one line.
    expect(evidence.size).toBe(0);
  });

  test("a matching pin is not a refusal — the account is asked exactly as it would be without one", async () => {
    const alpha = recorder();
    await probeAccountEvidence(
      [candidate("x-dev-db", "d1")],
      { accountName: "alpha", accountId: "alpha-acct" },
      alpha.connect,
    );
    expect(alpha.seen).toEqual([{ accountId: "alpha-acct", apiToken: "tok-alpha-acct" }]);
  });
});
