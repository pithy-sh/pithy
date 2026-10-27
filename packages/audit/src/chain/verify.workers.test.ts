// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { R2Bucket } from "@cloudflare/workers-types";
import { AuditChainExport, chainHash, verifyChainExport } from "@pithy-sh/core/src/audit/chain";
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
import { chainFieldsOf, readChainRows } from "./rows";
import { exportChainRange, parseExportCursor, verifyChainRange } from "./verify";

/**
 * The verify and export reads (#822), against real D1 and R2. Each kind of tampering is done the way somebody with
 * write access to the database would do it — straight SQL — and each is asserted to come back as a break naming the
 * event and its position.
 */

const db = () => auditDatabase(env.DB);
const bucket = () => env.AUDIT_CHECKPOINTS as unknown as R2Bucket;
const T0 = Date.UTC(2026, 5, 10, 12);

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

/** Record `n` events for a tenant, one minute apart, each with personal values. */
async function record(n: number, tenant: string | null = "acme", from = 0): Promise<void> {
  for (let i = from; i < from + n; i++) {
    await recordAuditEvent(db(), {
      action: "auth/login",
      outcome: "success",
      actorType: "user",
      actorId: `u${i}`,
      tenant,
      ip: `203.0.113.${i}`,
      userAgent: "curl/8",
      metadata: { n: i },
      occurredAt: new Date(T0 + i * 60_000),
    });
  }
}

async function eventIdAt(seq: number): Promise<string> {
  const row = await env.DB.prepare("select event_id from pithy_audit_events where tenant = 'acme' and chain_seq = ?")
    .bind(seq)
    .first<{ event_id: string }>();
  return row?.event_id as string;
}

/** A row as a recorder from before the chain writes it: every column but the chain's. */
async function insertUnchained(eventId: string, occurredAt: number, tenant = "acme"): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, tenant) values (?, ?, 'auth/login', 'success', 'user', ?)",
  )
    .bind(eventId, occurredAt, tenant)
    .run();
}

/** Copy the row at `seq` as a new row at the same position, with the unique index that stops it dropped. */
async function duplicateAt(seq: number): Promise<void> {
  await env.DB.prepare("drop index if exists pithy_audit_events_tenant_chain_idx").run();
  await env.DB.prepare(
    "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, tenant, chain_seq, chain_prev, chain_hash, chain_salt) select 'forged', occurred_at, action, outcome, actor_type, tenant, chain_seq, chain_prev, chain_hash, chain_salt from pithy_audit_events where tenant = 'acme' and chain_seq = ?",
  )
    .bind(seq)
    .run();
}

/**
 * The checkpoint bucket, but the first time it is listed another event lands and the checkpoint run takes it first —
 * the hourly run racing a read. Whatever the read did before its listing sees the chain without that event.
 */
function racingBucket(tenant: string | null): R2Bucket {
  const real = bucket();
  let raced = false;
  return new Proxy(real, {
    get(target, property) {
      if (property === "list") {
        return async (...args: Parameters<R2Bucket["list"]>) => {
          if (!raced) {
            raced = true;
            await recordAuditEvent(db(), { action: "auth/login", outcome: "success", actorType: "user", tenant });
            await writeCheckpoints(db(), real, new Date(T0));
          }
          return target.list(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("verifyChainRange", () => {
  test("an untouched chain is intact, held to its checkpoints", async () => {
    await record(4);
    await writeCheckpoints(db(), bucket(), new Date(T0));
    await record(2, "acme", 4);
    expect(await verifyChainRange(db(), bucket(), { tenant: "acme" })).toMatchObject({
      intact: true,
      checked: 6,
      checkpoints: 1,
      break: null,
    });
  });

  test("a checkpoint taken while the verify runs is no truncation", async () => {
    await record(3);
    await writeCheckpoints(db(), bucket(), new Date(T0));
    expect(await verifyChainRange(db(), racingBucket("acme"), { tenant: "acme" })).toMatchObject({
      intact: true,
      checked: 4,
      break: null,
    });
  });

  test("an edited row is a break at that event and its position", async () => {
    await record(5);
    const target = await eventIdAt(3);
    await env.DB.prepare("update pithy_audit_events set action = 'auth/logout' where event_id = ?").bind(target).run();
    expect((await verifyChainRange(db(), null, { tenant: "acme" })).break).toMatchObject({
      eventId: target,
      position: 3,
      reason: "edited",
    });
  });

  test("an edited IP is a break, though the IP is not in the hash itself", async () => {
    await record(3);
    const target = await eventIdAt(2);
    await env.DB.prepare("update pithy_audit_events set ip = '198.51.100.1' where event_id = ?").bind(target).run();
    expect((await verifyChainRange(db(), null, { tenant: "acme" })).break).toMatchObject({
      eventId: target,
      position: 2,
      reason: "edited",
    });
  });

  test("a deleted row is a break at the event after the gap", async () => {
    await record(5);
    const after = await eventIdAt(4);
    await env.DB.prepare("delete from pithy_audit_events where tenant = 'acme' and chain_seq = 3").run();
    expect((await verifyChainRange(db(), null, { tenant: "acme" })).break).toMatchObject({
      eventId: after,
      position: 3,
      reason: "missing",
    });
  });

  test("a row an older recorder writes after the chain began is counted outside it, never a break", async () => {
    // A Worker not yet redeployed, an isolate still serving the old version, or an older CLI emitting into the same
    // D1, interleaved with the new recorder's chained appends.
    await record(2);
    await insertUnchained("old-recorder", T0 + 2 * 60_000);
    await record(2, "acme", 2);
    await insertUnchained("old-recorder-2", T0 + 4 * 60_000);
    expect(await verifyChainRange(db(), null, { tenant: "acme" })).toMatchObject({
      intact: true,
      checked: 4,
      beforeChain: 0,
      outsideChain: 2,
      break: null,
    });
  });

  test("a row outside the chain never hides a real break after it", async () => {
    await record(2);
    await insertUnchained("old-recorder", T0 + 2 * 60_000);
    await record(3, "acme", 2);
    const target = await eventIdAt(4);
    await env.DB.prepare("update pithy_audit_events set action = 'auth/logout' where event_id = ?").bind(target).run();
    expect(await verifyChainRange(db(), null, { tenant: "acme" })).toMatchObject({
      intact: false,
      outsideChain: 1,
      break: { eventId: target, position: 4, reason: "edited" },
    });
  });

  test("a window counts the rows outside the chain that sit inside it, not the first one anywhere", async () => {
    await record(1);
    await insertUnchained("early", T0 + 60_000);
    await record(4, "acme", 1);
    await insertUnchained("inside", T0 + 5 * 60_000);
    await record(2, "acme", 5);
    await insertUnchained("past", T0 + 7 * 60_000);
    await record(1, "acme", 7);
    // Positions 4 to 6: "inside" sits at 6, after seq 5; "early" at 2 and "past" at 8 are outside the window.
    const window = { tenant: "acme", since: new Date(T0 + 3 * 60_000), until: new Date(T0 + 5 * 60_000 + 1) };
    expect(await verifyChainRange(db(), null, window)).toMatchObject({ intact: true, checked: 3, outsideChain: 1 });
    expect(await verifyChainRange(db(), null, { tenant: "acme" })).toMatchObject({ intact: true, outsideChain: 3 });
  });

  test("an inserted row given a chain position is a break where it sits", async () => {
    await record(3);
    await env.DB.prepare("drop index pithy_audit_events_tenant_chain_idx").run();
    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, tenant, chain_seq, chain_prev, chain_hash, chain_salt) select 'forged', occurred_at, action, outcome, actor_type, tenant, chain_seq, chain_prev, chain_hash, chain_salt from pithy_audit_events where chain_seq = 2",
    ).run();
    expect((await verifyChainRange(db(), null, { tenant: "acme" })).break).toMatchObject({
      position: 3,
      reason: "inserted",
    });
  });

  test("a copy at the position that ends a page is still read, and is a break", async () => {
    await record(4);
    await duplicateAt(2);
    // Pages of two: the first ends on the original at position 2, so the copy is the second page's first row.
    expect((await verifyChainRange(db(), null, { tenant: "acme" }, { pageSize: 2 })).break).toMatchObject({
      eventId: "forged",
      position: 3,
      reason: "inserted",
    });
  });

  test("a tail rewritten with every hash recomputed is caught against the checkpoint", async () => {
    await record(5);
    await writeCheckpoints(db(), bucket(), new Date(T0));
    // Rewrite the last three events and recompute every link, exactly as somebody with the database could.
    const rows = await readChainRows(db(), { tenant: "acme", afterSeq: 0, limit: 10 });
    let prev = rows[1]?.chainHash ?? null;
    for (const row of rows.slice(2)) {
      const action = "auth/logout";
      const hash = await chainHash(
        { seq: row.chainSeq as number, prev },
        await chainFieldsOf({ ...row, action }, row.chainSalt as string),
      );
      await env.DB.prepare("update pithy_audit_events set action = ?, chain_prev = ?, chain_hash = ? where id = ?")
        .bind(action, prev, hash, row.id)
        .run();
      prev = hash;
    }
    expect(await verifyChainRange(db(), null, { tenant: "acme" })).toMatchObject({ intact: true });
    expect((await verifyChainRange(db(), bucket(), { tenant: "acme" })).break).toMatchObject({
      eventId: rows[4]?.eventId,
      position: 5,
      reason: "checkpoint",
    });
  });

  test("a truncated tail is caught against the checkpoint", async () => {
    await record(5);
    await writeCheckpoints(db(), bucket(), new Date(T0));
    await env.DB.prepare("delete from pithy_audit_events where tenant = 'acme' and chain_seq >= 4").run();
    expect((await verifyChainRange(db(), bucket(), { tenant: "acme" })).break).toMatchObject({
      eventId: null,
      position: 4,
      reason: "truncated",
    });
  });

  test("a window walks the positions it resolves to, from the link before it", async () => {
    await record(6);
    const window = { tenant: "acme", since: new Date(T0 + 2 * 60_000), until: new Date(T0 + 4 * 60_000) };
    expect(await verifyChainRange(db(), null, window)).toMatchObject({ intact: true, checked: 3 });
    await env.DB.prepare("delete from pithy_audit_events where tenant = 'acme' and chain_seq = 2").run();
    expect((await verifyChainRange(db(), null, window)).break).toMatchObject({
      eventId: null,
      position: 2,
      reason: "missing",
    });
  });

  test("events from before the chain are counted, never walked, and never a break", async () => {
    await env.DB.prepare(
      "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, tenant) values ('old', ?, 'auth/login', 'success', 'user', 'acme')",
    )
      .bind(T0)
      .run();
    await record(2);
    expect(await verifyChainRange(db(), null, { tenant: "acme" })).toMatchObject({
      intact: true,
      checked: 2,
      beforeChain: 1,
    });
    const old = await env.DB.prepare(
      "select chain_seq, chain_hash from pithy_audit_events where event_id = 'old'",
    ).first();
    expect(old).toEqual({ chain_seq: null, chain_hash: null });
  });
});

describe("exportChainRange", () => {
  test("carries canonical events, their hashes and the covering checkpoints, and verifies offline", async () => {
    await record(4);
    await writeCheckpoints(db(), bucket(), new Date(T0));
    const doc = await exportChainRange(
      db(),
      bucket(),
      { tenant: "acme" },
      { detail: true, limit: 100, now: new Date(T0) },
    );
    expect(AuditChainExport.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(doc).toMatchObject({ prior: null, complete: true, nextCursor: null, detail: true });
    expect(doc.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(doc.events[0]).toMatchObject({ ip: "203.0.113.0", metadata: JSON.stringify({ n: 0 }) });
    expect(doc.checkpoints.map((checkpoint) => checkpoint.count)).toEqual([4]);
    expect(await verifyChainExport(doc)).toMatchObject({ intact: true, checked: 4, checkpoints: 1 });
  });

  test("without the detail it carries the commitments and no personal value, and still verifies", async () => {
    await record(3);
    const doc = await exportChainRange(
      db(),
      bucket(),
      { tenant: "acme" },
      { detail: false, limit: 100, now: new Date(T0) },
    );
    for (const event of doc.events) {
      expect(event).not.toHaveProperty("ip");
      expect(event).not.toHaveProperty("userAgent");
      expect(event).not.toHaveProperty("metadata");
      expect(event).not.toHaveProperty("salt");
      expect(event.ipCommitment).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(await verifyChainExport(doc)).toMatchObject({ intact: true });
  });

  test("pages carry the link before them, and each verifies on its own", async () => {
    await record(5);
    await writeCheckpoints(db(), bucket(), new Date(T0));
    const first = await exportChainRange(
      db(),
      bucket(),
      { tenant: "acme" },
      { detail: false, limit: 2, now: new Date(T0) },
    );
    expect(first).toMatchObject({ complete: false });
    const second = await exportChainRange(
      db(),
      bucket(),
      { tenant: "acme" },
      { detail: false, limit: 2, cursor: first.nextCursor as string, now: new Date(T0) },
    );
    expect(second.prior).toEqual({ seq: 2, hash: first.events[1]?.hash });
    expect(second.events.map((event) => event.seq)).toEqual([3, 4]);
    for (const page of [first, second]) expect(await verifyChainExport(page)).toMatchObject({ intact: true });
  });

  test("a checkpoint taken while the export runs is no truncation offline", async () => {
    await record(3);
    await writeCheckpoints(db(), bucket(), new Date(T0));
    const doc = await exportChainRange(
      db(),
      racingBucket("acme"),
      { tenant: "acme" },
      { detail: false, limit: 100, now: new Date(T0) },
    );
    expect(doc).toMatchObject({ complete: true });
    expect(doc.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(await verifyChainExport(doc)).toMatchObject({ intact: true });
  });

  test("an export of a truncated chain names the truncation offline", async () => {
    await record(4);
    await writeCheckpoints(db(), bucket(), new Date(T0));
    await env.DB.prepare("delete from pithy_audit_events where tenant = 'acme' and chain_seq = 4").run();
    const doc = await exportChainRange(
      db(),
      bucket(),
      { tenant: "acme" },
      { detail: false, limit: 100, now: new Date(T0) },
    );
    expect((await verifyChainExport(doc)).break).toMatchObject({ position: 4, reason: "truncated" });
  });

  test("a copy at the position that ends a page is the next page's first event, and a break offline", async () => {
    await record(4);
    await duplicateAt(2);
    const first = await exportChainRange(
      db(),
      null,
      { tenant: "acme" },
      { detail: false, limit: 2, now: new Date(T0) },
    );
    expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
    const second = await exportChainRange(
      db(),
      null,
      { tenant: "acme" },
      { detail: false, limit: 2, cursor: first.nextCursor as string, now: new Date(T0) },
    );
    expect(second.events.map((event) => [event.eventId, event.seq])).toEqual([
      ["forged", 2],
      [await eventIdAt(3), 3],
    ]);
    expect((await verifyChainExport(second)).break).toMatchObject({ eventId: "forged", reason: "inserted" });
  });

  test("the last page says so, even when it is exactly full", async () => {
    await record(4);
    const first = await exportChainRange(
      db(),
      null,
      { tenant: "acme" },
      { detail: false, limit: 2, now: new Date(T0) },
    );
    const second = await exportChainRange(
      db(),
      null,
      { tenant: "acme" },
      { detail: false, limit: 2, cursor: first.nextCursor as string, now: new Date(T0) },
    );
    expect(second).toMatchObject({ nextCursor: null, complete: true });
    expect(second.events.map((event) => event.seq)).toEqual([3, 4]);
  });

  test("counts the rows outside the chain beside the ones before it", async () => {
    await insertUnchained("old", T0 - 60_000);
    await record(2);
    await insertUnchained("old-recorder", T0 + 2 * 60_000);
    const doc = await exportChainRange(
      db(),
      null,
      { tenant: "acme" },
      { detail: false, limit: 100, now: new Date(T0) },
    );
    expect(doc).toMatchObject({ beforeChain: 1, outsideChain: 1 });
    expect(doc.events.map((event) => event.seq)).toEqual([1, 2]);
  });
});

describe("readChainRows", () => {
  test("resumes after a position and an id, so a second row at the same position is never skipped", async () => {
    await record(3);
    await duplicateAt(2);
    const [, original] = await readChainRows(db(), { tenant: "acme", afterSeq: 0, limit: 2 });
    expect(original?.chainSeq).toBe(2);
    const rest = await readChainRows(db(), {
      tenant: "acme",
      afterSeq: 2,
      afterId: original?.id as number,
      limit: 10,
    });
    expect(rest.map((row) => [row.eventId, row.chainSeq])).toEqual([
      ["forged", 2],
      [await eventIdAt(3), 3],
    ]);
    expect((await readChainRows(db(), { tenant: "acme", afterSeq: 2, limit: 10 })).map((row) => row.chainSeq)).toEqual([
      3,
    ]);
  });
});

describe("parseExportCursor", () => {
  test("reads a position and a row id, and nothing else", () => {
    expect(parseExportCursor("2:17")).toEqual({ seq: 2, id: 17 });
    for (const malformed of [undefined, "", "2", "2:", ":17", "-1:3", "2:3:4", "a:b", "1e3:2", `${"9".repeat(16)}:1`]) {
      expect(parseExportCursor(malformed)).toBeNull();
    }
  });
});
