// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { R2Bucket } from "@cloudflare/workers-types";
import { AuditChainExport, verifyChainExport } from "@pithy-sh/core/src/audit/chain";
import { type RetentionPolicy, resolveRetention } from "@pithy-sh/core/src/retention/policy";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { auditDatabase } from "../data/tables";
import { audit_0001_init } from "../migrations/0001_init";
import { audit_0002_actor_kind } from "../migrations/0002_actor_kind";
import { audit_0003_call_index } from "../migrations/0003_call_index";
import { audit_0004_request_index } from "../migrations/0004_request_index";
import { audit_0005_chain } from "../migrations/0005_chain";
import { recordAuditEvent } from "../recorder";
import { writeCheckpoints } from "./checkpoint";
import { chainTenants, pruneChainPage, pruneUnchainedPage } from "./prune";
import { readChainRows } from "./rows";
import { readTombstones, tombstoneKey, writeTombstone } from "./tombstone";
import { exportChainRange, verifyChainRange } from "./verify";

/**
 * The retention prune against real D1 and R2: what it removes, the tombstone it leaves, and the verify reading the
 * chain as whole across the gap.
 */

const db = () => auditDatabase(env.DB);
const bucket = () => env.AUDIT_CHECKPOINTS as unknown as R2Bucket;
const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 9, 27, 12));

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  for (const m of [
    audit_0001_init,
    audit_0002_actor_kind,
    audit_0003_call_index,
    audit_0004_request_index,
    audit_0005_chain,
  ]) {
    await m.up(db() as unknown as Kysely<unknown>);
  }
  for (const object of (await bucket().list()).objects) await bucket().delete(object.key);
});

/** Record one event per entry: its action and how many days before now it occurred. */
async function record(events: [action: string, daysAgo: number][], tenant: string | null = "acme"): Promise<void> {
  for (const [index, [action, daysAgo]] of events.entries()) {
    await recordAuditEvent(db(), {
      action: action as "auth/login",
      outcome: "success",
      actorType: "user",
      actorId: `u${index}`,
      tenant,
      ip: "203.0.113.7",
      metadata: { n: index },
      occurredAt: new Date(NOW.getTime() - daysAgo * DAY + index),
    });
  }
}

function policy(block: RetentionPolicy) {
  return resolveRetention(block, { purgeWindows: [], lifecycleActions: ["auth/user_deleted"] });
}

async function seqs(tenant = "acme"): Promise<number[]> {
  const rows = await env.DB.prepare("select chain_seq from pithy_audit_events where tenant = ? order by chain_seq")
    .bind(tenant)
    .all<{ chain_seq: number }>();
  return rows.results.map((row) => row.chain_seq);
}

const page = (retention: ReturnType<typeof policy>, tenant: string | null = "acme") =>
  pruneChainPage(db(), bucket(), { tenant, retention, now: NOW, afterSeq: 0, limit: 500 });

describe("pruneChainPage", () => {
  test("reads past events still inside their own window, so a long floored prefix at the chain's front never stalls it", async () => {
    // Three control-plane events at the front, old for the 30-day default and inside their 365-day floor, then two
    // default-window events past theirs. A page of two reaches the expired pair at once.
    await record([
      ["controlplane/key_created", 200],
      ["controlplane/key_created", 190],
      ["controlplane/key_created", 180],
      ["auth/login", 100],
      ["auth/login", 90],
      ["auth/login", 1],
    ]);
    await writeCheckpoints(db(), bucket(), NOW);
    const done = await pruneChainPage(db(), bucket(), {
      tenant: "acme",
      retention: policy({ audit: { default: "30d" } }),
      now: NOW,
      afterSeq: 0,
      limit: 2,
    });
    expect(done.pruned).toBe(2);
    expect(await seqs()).toEqual([1, 2, 3, 6]);
    expect(await verifyChainRange(db(), bucket(), { tenant: "acme" })).toMatchObject({ intact: true, pruned: 2 });
  });

  test("removes the run past its window, leaves a tombstone, and the verify reads the chain as intact", async () => {
    await record([
      ["auth/login", 200],
      ["auth/login", 150],
      ["auth/login", 120],
      ["auth/login", 10],
      ["auth/login", 1],
    ]);
    await writeCheckpoints(db(), bucket(), NOW);
    const done = await page(policy({ audit: { default: "90d" } }));
    expect(done).toEqual({ pruned: 3, refused: 0, next: null });
    expect(await seqs()).toEqual([4, 5]);
    const [tombstone] = await readTombstones(bucket(), "acme");
    expect(tombstone).toMatchObject({ fromSeq: 1, throughSeq: 3, count: 3, prior: null });
    expect(await verifyChainRange(db(), bucket(), { tenant: "acme" })).toMatchObject({
      intact: true,
      checked: 2,
      pruned: 3,
      break: null,
    });
  });

  test("an export of a pruned chain verifies offline, and a range starting after the gap reads its prior from it", async () => {
    await record([
      ["auth/login", 200],
      ["auth/login", 150],
      ["auth/login", 10],
    ]);
    await page(policy({ audit: { default: "90d" } }));
    const whole = AuditChainExport.parse(
      await exportChainRange(db(), bucket(), { tenant: "acme" }, { detail: true, limit: 100, now: NOW }),
    );
    expect(await verifyChainExport(whole)).toMatchObject({ intact: true, checked: 1, pruned: 2 });
    const since = await exportChainRange(
      db(),
      bucket(),
      { tenant: "acme", since: new Date(NOW.getTime() - 20 * DAY) },
      { detail: false, limit: 100, now: NOW },
    );
    expect(since.prior?.seq).toBe(2);
    expect((await verifyChainExport(since)).intact).toBe(true);
  });

  test("an event kept longer stays where it is, and the runs either side of it are pruned on their own", async () => {
    await record([
      ["auth/login", 400],
      ["controlplane/key_created", 200],
      ["auth/login", 150],
      ["auth/login", 140],
      ["auth/login", 1],
    ]);
    const done = await page(policy({ audit: { default: "30d" } }));
    // The control-plane event sits under the kit's floor of a year, so it is kept, and splits two runs.
    expect(done.pruned).toBe(3);
    expect(await seqs()).toEqual([2, 5]);
    expect((await readTombstones(bucket(), "acme")).map((t) => [t.fromSeq, t.throughSeq])).toEqual([
      [1, 1],
      [3, 4],
    ]);
    expect(await verifyChainRange(db(), bucket(), { tenant: "acme" })).toMatchObject({ intact: true, pruned: 3 });
  });

  test("a later pass prunes on from an earlier pass's tombstone", async () => {
    await record([
      ["auth/login", 200],
      ["auth/login", 60],
      ["auth/login", 1],
    ]);
    await page(policy({ audit: { default: "90d" } }));
    await page(policy({ audit: { default: "30d" } }));
    expect(await seqs()).toEqual([3]);
    expect((await readTombstones(bucket(), "acme")).map((t) => t.prior === null)).toEqual([true, false]);
    expect(await verifyChainRange(db(), bucket(), { tenant: "acme" })).toMatchObject({ intact: true, pruned: 2 });
  });

  test("never prunes the head, so the next event still links to the chain", async () => {
    await record([
      ["auth/login", 200],
      ["auth/login", 190],
    ]);
    await page(policy({ audit: { default: "90d" } }));
    expect(await seqs()).toEqual([2]);
    await record([["auth/login", 0]]);
    expect(await seqs()).toEqual([2, 3]);
    expect((await verifyChainRange(db(), bucket(), { tenant: "acme" })).intact).toBe(true);
  });

  test("a run that does not verify is refused and left in place", async () => {
    await record([
      ["auth/login", 200],
      ["auth/login", 190],
      ["auth/login", 1],
    ]);
    await env.DB.prepare("update pithy_audit_events set actor_id = 'someone-else' where chain_seq = 2").run();
    expect(await page(policy({ audit: { default: "90d" } }))).toEqual({ pruned: 0, refused: 1, next: null });
    expect(await seqs()).toEqual([1, 2, 3]);
    expect(await readTombstones(bucket(), "acme")).toEqual([]);
  });

  test("a second row at a run's position that the page never read is refused with the run, and both stay", async () => {
    await record([
      ["auth/login", 200],
      ["auth/login", 190],
      ["auth/login", 180],
      ["auth/login", 1],
    ]);
    await writeCheckpoints(db(), bucket(), NOW);
    // A recent row at position 2: inside its window, so the page never reads it, and a verify reports it.
    await env.DB.prepare("drop index if exists pithy_audit_events_tenant_chain_idx").run();
    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, tenant, chain_seq, chain_prev, chain_hash, chain_salt) values ('forged', ?, 'auth/login', 'success', 'user', 'acme', 2, null, ?, '')",
    )
      .bind(NOW.getTime() - DAY, "f".repeat(64))
      .run();
    expect((await verifyChainRange(db(), bucket(), { tenant: "acme" })).intact).toBe(false);
    expect(await page(policy({ audit: { default: "90d" } }))).toEqual({ pruned: 0, refused: 1, next: null });
    expect(await seqs()).toEqual([1, 2, 2, 3, 4]);
    expect(await readTombstones(bucket(), "acme")).toEqual([]);
    expect((await verifyChainRange(db(), bucket(), { tenant: "acme" })).intact).toBe(false);
  });

  test("removes a run longer than one statement's bound parameters", async () => {
    await record([...Array.from({ length: 150 }, (): [string, number] => ["auth/login", 200]), ["auth/login", 1]]);
    expect(await page(policy({ audit: { default: "90d" } }))).toEqual({ pruned: 150, refused: 0, next: null });
    expect(await seqs()).toEqual([151]);
  });

  test("a duplicate the page read leaves every run it touches in place", async () => {
    await record([
      ["auth/login", 200],
      ["auth/login", 190],
      ["auth/login", 180],
      ["auth/login", 1],
    ]);
    await env.DB.prepare("drop index if exists pithy_audit_events_tenant_chain_idx").run();
    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, tenant, chain_seq, chain_prev, chain_hash, chain_salt) select 'forged', occurred_at, action, outcome, actor_type, tenant, chain_seq, chain_prev, chain_hash, chain_salt from pithy_audit_events where tenant = 'acme' and chain_seq = 2",
    ).run();
    expect(await page(policy({ audit: { default: "90d" } }))).toMatchObject({ pruned: 0 });
    expect(await seqs()).toEqual([1, 2, 2, 3, 4]);
    expect(await readTombstones(bucket(), "acme")).toEqual([]);
  });

  test("a policy that keeps everything prunes nothing", async () => {
    await record([
      ["auth/login", 2000],
      ["auth/login", 1],
    ]);
    expect(await page(policy({}))).toEqual({ pruned: 0, refused: 0, next: null });
    expect(await seqs()).toEqual([1, 2]);
  });

  test("a retry after a failed delete deletes the run its tombstone names, and writes no second one", async () => {
    await record([
      ["auth/login", 200],
      ["auth/login", 190],
      ["auth/login", 1],
    ]);
    // As though an earlier attempt wrote the tombstone and died before its delete.
    const [one, two] = await readChainRows(db(), { tenant: "acme", afterSeq: 0, limit: 2 });
    await writeTombstone(bucket(), {
      format: "pithy-audit-tombstone/1",
      tenant: "acme",
      fromSeq: 1,
      throughSeq: 2,
      count: 2,
      prior: null,
      first: one?.chainHash as string,
      last: two?.chainHash as string,
      prunedAt: new Date(NOW.getTime() - DAY).toISOString(),
    });
    expect((await page(policy({ audit: { default: "90d" } }))).pruned).toBe(2);
    expect(await seqs()).toEqual([3]);
    expect((await bucket().list({ prefix: "checkpoints/tenant/acme/tombstones/" })).objects).toHaveLength(1);
  });

  test("a stored tombstone that does not name the rows in hand deletes nothing", async () => {
    await record([
      ["auth/login", 200],
      ["auth/login", 1],
    ]);
    await writeTombstone(bucket(), {
      format: "pithy-audit-tombstone/1",
      tenant: "acme",
      fromSeq: 1,
      throughSeq: 1,
      count: 1,
      prior: null,
      first: "c".repeat(64),
      last: "c".repeat(64),
      prunedAt: NOW.toISOString(),
    });
    expect(await page(policy({ audit: { default: "90d" } }))).toEqual({ pruned: 0, refused: 1, next: null });
    expect(await seqs()).toEqual([1, 2]);
  });

  test("the untenanted chain is pruned on its own terms", async () => {
    await record(
      [
        ["auth/login", 200],
        ["auth/login", 1],
      ],
      null,
    );
    expect((await page(policy({ audit: { default: "90d" } }), null)).pruned).toBe(1);
    expect(await verifyChainRange(db(), bucket(), { tenant: null })).toMatchObject({ intact: true, pruned: 1 });
  });

  test("lists every chain the trail holds, the untenanted one as null", async () => {
    await record([["auth/login", 1]], "beta");
    await record([["auth/login", 1]], null);
    await record([["auth/login", 1]], "acme");
    expect(await chainTenants(db())).toEqual([null, "acme", "beta"]);
  });
});

describe("writeTombstone", () => {
  test("hands back the tombstone already stored at a run's key rather than replacing it", async () => {
    const first = {
      format: "pithy-audit-tombstone/1" as const,
      tenant: "acme",
      fromSeq: 1,
      throughSeq: 3,
      count: 3,
      prior: null,
      first: "a".repeat(64),
      last: "b".repeat(64),
      prunedAt: NOW.toISOString(),
    };
    expect(await writeTombstone(bucket(), first)).toEqual(first);
    expect(await writeTombstone(bucket(), { ...first, throughSeq: 5, count: 5 })).toEqual(first);
  });

  test("refuses a stored object at the key that is not a tombstone", async () => {
    await bucket().put(tombstoneKey("acme", 1), "not json");
    await expect(
      writeTombstone(bucket(), {
        format: "pithy-audit-tombstone/1",
        tenant: "acme",
        fromSeq: 1,
        throughSeq: 1,
        count: 1,
        prior: null,
        first: "a".repeat(64),
        last: "a".repeat(64),
        prunedAt: NOW.toISOString(),
      }),
    ).rejects.toThrow(/cannot read/);
  });

  test("a stored tombstone naming another chain than its key is skipped on read", async () => {
    await bucket().put(
      tombstoneKey("acme", 1),
      JSON.stringify({
        format: "pithy-audit-tombstone/1",
        tenant: "beta",
        fromSeq: 1,
        throughSeq: 1,
        count: 1,
        prior: null,
        first: "a".repeat(64),
        last: "a".repeat(64),
        prunedAt: NOW.toISOString(),
      }),
    );
    expect(await readTombstones(bucket(), "acme")).toEqual([]);
  });
});

describe("pruneUnchainedPage", () => {
  async function insertUnchained(eventId: string, daysAgo: number, tenant: string, action = "auth/login") {
    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, tenant) values (?, ?, ?, 'success', 'user', ?)",
    )
      .bind(eventId, NOW.getTime() - daysAgo * DAY, action, tenant)
      .run();
  }

  test("removes the rows past their windows, and none on a held tenant's trail", async () => {
    await insertUnchained("old-acme", 200, "acme");
    await insertUnchained("old-beta", 200, "beta");
    await insertUnchained("old-control", 200, "acme", "controlplane/key_created");
    await insertUnchained("new-acme", 1, "acme");
    const done = await pruneUnchainedPage(db(), {
      retention: policy({ audit: { default: "90d" } }),
      now: NOW,
      afterId: 0,
      limit: 500,
      held: async (tenant) => tenant === "beta",
    });
    expect(done).toEqual({ deleted: 1, next: null });
    const left = await env.DB.prepare("select event_id from pithy_audit_events order by id").all<{
      event_id: string;
    }>();
    expect(left.results.map((row) => row.event_id)).toEqual(["old-beta", "old-control", "new-acme"]);
  });

  test("reads past rows still inside their own window, so kept rows at the front never stall it", async () => {
    for (const id of ["kept-1", "kept-2", "kept-3"]) await insertUnchained(id, 200, "acme", "controlplane/key_created");
    await insertUnchained("old-1", 100, "acme");
    await insertUnchained("old-2", 90, "acme");
    const done = await pruneUnchainedPage(db(), {
      retention: policy({ audit: { default: "30d" } }),
      now: NOW,
      afterId: 0,
      limit: 2,
      held: async () => false,
    });
    expect(done.deleted).toBe(2);
    const left = await env.DB.prepare("select event_id from pithy_audit_events order by id").all<{
      event_id: string;
    }>();
    expect(left.results.map((row) => row.event_id)).toEqual(["kept-1", "kept-2", "kept-3"]);
  });
});

/**
 * A bucket that counts its tombstone listings, and can run `race` straight after the first one: a prune that writes
 * its tombstone after a verify listed none, then deletes the rows the walk has not reached.
 */
function tombstoneWatch(race?: () => Promise<unknown>): { bucket: R2Bucket; listings: () => number } {
  const real = bucket();
  let listings = 0;
  const watched = new Proxy(real, {
    get(target, property) {
      if (property === "list") {
        return async (...args: Parameters<R2Bucket["list"]>) => {
          const tombstones = String(args[0]?.prefix ?? "").includes("tombstones/");
          const result = await target.list(...args);
          if (tombstones) {
            listings++;
            if (listings === 1 && race) await race();
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bucket: watched, listings: () => listings };
}

describe("a verify that overlaps the prune", () => {
  test("walks again when a prune tombstoned and removed rows after the listing, and reads the chain as intact", async () => {
    await record([
      ["auth/login", 200],
      ["auth/login", 150],
      ["auth/login", 10],
      ["auth/login", 1],
    ]);
    await writeCheckpoints(db(), bucket(), NOW);
    const watch = tombstoneWatch(() => page(policy({ audit: { default: "90d" } })));
    const result = await verifyChainRange(db(), watch.bucket, { tenant: "acme" });
    expect(watch.listings()).toBe(2);
    expect(result).toMatchObject({ intact: true, pruned: 2, break: null });
  });

  test("a gap no tombstone accounts for is still missing after the second walk", async () => {
    await record([
      ["auth/login", 3],
      ["auth/login", 2],
      ["auth/login", 1],
    ]);
    await env.DB.prepare("delete from pithy_audit_events where chain_seq = 2").run();
    const watch = tombstoneWatch();
    const result = await verifyChainRange(db(), watch.bucket, { tenant: "acme" });
    expect(watch.listings()).toBe(2);
    expect(result.intact).toBe(false);
    expect(result.break).toMatchObject({ reason: "missing" });
  });

  test("walks once for a break that is not a gap", async () => {
    await record([
      ["auth/login", 3],
      ["auth/login", 2],
      ["auth/login", 1],
    ]);
    await env.DB.prepare("update pithy_audit_events set action = 'auth/logout' where chain_seq = 2").run();
    const watch = tombstoneWatch();
    const result = await verifyChainRange(db(), watch.bucket, { tenant: "acme" });
    expect(watch.listings()).toBe(1);
    expect(result.break).toMatchObject({ reason: "edited" });
  });
});
