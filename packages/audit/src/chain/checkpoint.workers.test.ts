// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { auditDatabase } from "../data/tables";
import { audit_0001_init } from "../migrations/0001_init";
import { audit_0002_actor_kind } from "../migrations/0002_actor_kind";
import { audit_0003_call_index } from "../migrations/0003_call_index";
import { audit_0004_request_index } from "../migrations/0004_request_index";
import { audit_0005_chain } from "../migrations/0005_chain";
import { recordAuditEvent } from "../recorder";
import { checkpointKey, listCheckpoints, readCheckpoints, writeCheckpoints } from "./checkpoint";
import { readChainHead } from "./rows";

/** Checkpoints (#822): each chain's head and count, one never-overwritten object per checkpoint. */

const db = () => auditDatabase(env.DB);
const bucket = () => env.AUDIT_CHECKPOINTS as unknown as R2Bucket;
const NOW = new Date("2026-06-10T12:00:00.000Z");

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
  const listed = await bucket().list();
  for (const object of listed.objects) await bucket().delete(object.key);
});

async function record(tenant: string | null, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await recordAuditEvent(db(), { action: "auth/login", outcome: "success", actorType: "user", tenant });
  }
}

describe("writeCheckpoints", () => {
  test("writes each chain's head and count, the untenanted chain included", async () => {
    await record("acme", 3);
    await record("a/b", 1);
    await record(null, 2);
    expect(await writeCheckpoints(db(), bucket(), NOW)).toEqual({ written: 3, unchanged: 0 });
    const acme = await readCheckpoints(bucket(), "acme", { fromCount: 1 });
    expect(acme).toEqual([
      {
        format: "pithy-audit-checkpoint/1",
        tenant: "acme",
        count: 3,
        head: (await readChainHead(db(), "acme"))?.hash,
        takenAt: NOW.toISOString(),
      },
    ]);
    expect((await readCheckpoints(bucket(), null, { fromCount: 1 })).map((c) => c.count)).toEqual([2]);
    // A tenant id with a slash stays inside its own prefix.
    expect(checkpointKey("a/b", 1)).toBe("checkpoints/tenant/a%2Fb/000000000000001.json");
    expect((await readCheckpoints(bucket(), "a/b", { fromCount: 1 })).map((c) => c.count)).toEqual([1]);
  });

  test("writes nothing for a head already checkpointed, and never replaces an object", async () => {
    await record("acme", 2);
    await writeCheckpoints(db(), bucket(), NOW);
    expect(await writeCheckpoints(db(), bucket(), new Date(NOW.getTime() + 3_600_000))).toEqual({
      written: 0,
      unchanged: 1,
    });
    const [only] = await readCheckpoints(bucket(), "acme", { fromCount: 1 });
    expect(only?.takenAt).toBe(NOW.toISOString());
    await record("acme", 1);
    expect(await writeCheckpoints(db(), bucket(), NOW)).toEqual({ written: 1, unchanged: 0 });
  });

  test("ignores rows from before the chain", async () => {
    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, tenant) values ('old', 1, 'auth/login', 'success', 'user', 'acme')",
    ).run();
    expect(await writeCheckpoints(db(), bucket(), NOW)).toEqual({ written: 0, unchanged: 0 });
  });
});

describe("readCheckpoints", () => {
  test("returns those in range and always the latest", async () => {
    for (let i = 0; i < 5; i++) {
      await record("acme");
      await writeCheckpoints(db(), bucket(), NOW);
    }
    expect((await readCheckpoints(bucket(), "acme", { fromCount: 2, throughCount: 3 })).map((c) => c.count)).toEqual([
      2, 3, 5,
    ]);
  });

  test("skips an object that does not parse, or names another chain or count than its key", async () => {
    await record("acme", 2);
    await writeCheckpoints(db(), bucket(), NOW);
    await bucket().put(checkpointKey("acme", 1), "not json");
    await bucket().put(
      checkpointKey("acme", 7),
      JSON.stringify({
        format: "pithy-audit-checkpoint/1",
        tenant: "acme",
        count: 6,
        head: "00".repeat(32),
        takenAt: NOW.toISOString(),
      }),
    );
    expect((await readCheckpoints(bucket(), "acme", { fromCount: 1 })).map((c) => c.count)).toEqual([2]);
  });

  test("held to a listing, reads only the checkpoints that listing saw", async () => {
    await record("acme", 2);
    await writeCheckpoints(db(), bucket(), NOW);
    const listing = await listCheckpoints(bucket(), "acme");
    await record("acme");
    await writeCheckpoints(db(), bucket(), NOW);
    expect(listing.entries.map((entry) => entry.count)).toEqual([2]);
    expect((await readCheckpoints(bucket(), "acme", { fromCount: 1 }, listing)).map((c) => c.count)).toEqual([2]);
    expect((await readCheckpoints(bucket(), "acme", { fromCount: 1 })).map((c) => c.count)).toEqual([2, 3]);
  });

  test("lists keys again when handed another chain's listing", async () => {
    await record("acme", 1);
    await record("globex", 2);
    await writeCheckpoints(db(), bucket(), NOW);
    const other = await listCheckpoints(bucket(), "globex");
    expect((await readCheckpoints(bucket(), "acme", { fromCount: 1 }, other)).map((c) => c.count)).toEqual([1]);
  });
});
