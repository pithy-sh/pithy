// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { type AuditEventInsert, auditDatabase } from "../data/tables";
import { AuditWriteFailedError } from "../error/errors";
import { audit_0001_init } from "../migrations/0001_init";
import { audit_0002_actor_kind } from "../migrations/0002_actor_kind";
import { audit_0003_call_index } from "../migrations/0003_call_index";
import { audit_0004_request_index } from "../migrations/0004_request_index";
import { audit_0005_chain } from "../migrations/0005_chain";
import { appendChained, CHAIN_APPEND_STALLS, isUnmigratedChain } from "./append";

/**
 * `appendChained` (#822), driven directly. The races it handles are staged through a D1 binding that runs a hook in
 * place of each insert into the audit table, so a competitor can take the position between the head read and the
 * write, a transient fault can follow a write that landed, and a chain can refuse without moving.
 */

const db = () => auditDatabase(env.DB);

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
});

/** Runs in place of one insert into the audit table; `run` performs the real one. */
type InsertHook = (run: () => Promise<D1Result>) => Promise<D1Result>;

/** The test D1, with every insert into the audit table passed through `hook`. */
function hooked(hook: InsertHook): D1Database {
  const real = env.DB as unknown as D1Database;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        }
        if (property === "all" && /^insert into "pithy_audit_events"/i.test(sql)) {
          return () => hook(() => target.all());
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(real, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let ids = 0;
function event(tenant: string | null = "acme"): AuditEventInsert {
  ids++;
  return {
    eventId: `evt_${ids}`,
    occurredAt: Date.UTC(2026, 5, 10, 12) + ids,
    action: "auth/login",
    outcome: "success",
    actorType: "user",
    tenant,
  } as AuditEventInsert;
}

/** Another append taking the chain's next position, the way a concurrent winner would. */
async function competitor(tenant: string): Promise<void> {
  const head = await env.DB.prepare("select max(chain_seq) as seq from pithy_audit_events where tenant = ?")
    .bind(tenant)
    .first<{ seq: number | null }>();
  const seq = (head?.seq ?? 0) + 1;
  await env.DB.prepare(
    "insert into pithy_audit_events (event_id, occurred_at, action, outcome, actor_type, tenant, chain_seq, chain_prev, chain_hash, chain_salt) values (?, 0, 'auth/login', 'success', 'user', ?, ?, null, ?, 'salt')",
  )
    .bind(`competitor_${seq}`, tenant, seq, `hash_${seq}`)
    .run();
}

async function rows(tenant = "acme") {
  const { results } = await env.DB.prepare(
    "select event_id, chain_seq, chain_prev from pithy_audit_events where tenant = ? order by chain_seq",
  )
    .bind(tenant)
    .all<{ event_id: string; chain_seq: number; chain_prev: string | null }>();
  return results;
}

describe("appendChained", () => {
  test("appends at the head, linked to it", async () => {
    await appendChained(db(), event());
    await appendChained(db(), event());
    expect((await rows()).map((row) => row.chain_seq)).toEqual([1, 2]);
  });

  test("a position taken between the head read and the insert is re-read, and the event lands after it", async () => {
    let raced = false;
    const record = event();
    await appendChained(
      auditDatabase(
        hooked(async (run) => {
          if (!raced) {
            raced = true;
            await competitor("acme");
          }
          return run();
        }),
      ),
      record,
    );
    expect(await rows()).toEqual([
      { event_id: "competitor_1", chain_seq: 1, chain_prev: null },
      { event_id: record.eventId, chain_seq: 2, chain_prev: "hash_1" },
    ]);
  });

  test("a retry after an insert that landed finds its own event, and appends it no second time", async () => {
    let faults = 0;
    const record = event();
    await appendChained(
      auditDatabase(
        hooked(async (run) => {
          const result = await run();
          if (faults++ === 0) throw new Error("D1_ERROR: Network connection lost.");
          return result;
        }),
      ),
      record,
      { retry: { initialDelayMs: 0 } },
    );
    expect(faults).toBe(2);
    expect(await rows()).toEqual([{ event_id: record.eventId, chain_seq: 1, chain_prev: null }]);
  });

  test("a head that never stops moving ends the append at its deadline", async () => {
    const write = appendChained(
      auditDatabase(
        hooked(async (run) => {
          await competitor("acme");
          return run();
        }),
      ),
      event(),
      { deadlineMs: 1_000, backoffCeilingMs: 0 },
    );
    await expect(write).rejects.toBeInstanceOf(AuditWriteFailedError);
    const landed = await rows();
    expect(landed.length).toBeGreaterThan(1);
    expect(landed.every((row) => row.event_id.startsWith("competitor_"))).toBe(true);
  });

  test("a chain that refuses without its head moving is given up on, not spun on", async () => {
    let inserts = 0;
    const write = appendChained(
      auditDatabase(
        hooked(async () => {
          inserts++;
          return { results: [], success: true, meta: { changes: 0 } } as unknown as D1Result;
        }),
      ),
      event(),
      { backoffCeilingMs: 0 },
    );
    await expect(write).rejects.toBeInstanceOf(AuditWriteFailedError);
    expect(inserts).toBe(CHAIN_APPEND_STALLS);
    expect(await rows()).toEqual([]);
  });

  test("a burst far past any per-append bound lands every event, in one unforked chain", async () => {
    const records = Array.from({ length: 100 }, () => event());
    await Promise.all(records.map((record) => appendChained(db(), record)));
    const chain = await rows();
    expect(chain.map((row) => row.chain_seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(new Set(chain.map((row) => row.event_id))).toEqual(new Set(records.map((record) => record.eventId)));
  }, 300_000);
});

describe("isUnmigratedChain", () => {
  test.each([
    ["D1_ERROR: table pithy_audit_events has no column named chain_seq: SQLITE_ERROR", true],
    ["D1_ERROR: no such column: chain_hash: SQLITE_ERROR", true],
    ["no such column: chain_salt", true],
    ["table x has no column named chain_prev", true],
    ["D1_ERROR: UNIQUE constraint failed: pithy_audit_events.tenant, pithy_audit_events.chain_seq", false],
    ["no such column: actor_kind", false],
    ["D1_ERROR: Network connection lost.", false],
  ])("%s → %s", (message, expected) => {
    expect(isUnmigratedChain(new Error(message))).toBe(expected);
  });

  test("a value that is not an Error is never an unmigrated chain", () => {
    expect(isUnmigratedChain("no such column: chain_seq")).toBe(false);
    expect(isUnmigratedChain({ message: "no such column: chain_seq" })).toBe(false);
    expect(isUnmigratedChain(undefined)).toBe(false);
  });
});
