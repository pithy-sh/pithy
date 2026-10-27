// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import { chainHash, chainVerifier, commitment } from "@pithy-sh/core/src/audit/chain";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { chainedEventOf, readChainRows } from "./chain/rows";
import { auditDatabase } from "./data/tables";
import { audit_0001_init } from "./migrations/0001_init";
import { audit_0002_actor_kind } from "./migrations/0002_actor_kind";
import { audit_0003_call_index } from "./migrations/0003_call_index";
import { audit_0004_request_index } from "./migrations/0004_request_index";
import { audit_0005_chain } from "./migrations/0005_chain";
import { recordAuditEvent } from "./recorder";

/** The chained append (#822): every event links to the one before it in its tenant's chain, and nothing forks. */

const db = () => auditDatabase(env.DB);

async function migrate(through = 5): Promise<void> {
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  const all = [
    audit_0001_init,
    audit_0002_actor_kind,
    audit_0003_call_index,
    audit_0004_request_index,
    audit_0005_chain,
  ];
  for (const migration of all.slice(0, through)) await migration.up(db() as unknown as Kysely<unknown>);
}

beforeEach(() => migrate());

/** Every chained row of one tenant's chain, in chain order, as an export would carry it with the values. */
async function chainOf(tenant: string | null) {
  const rows = await readChainRows(db(), { tenant, afterSeq: 0, limit: 1000 });
  return Promise.all(rows.map((row) => chainedEventOf(row, { detail: true })));
}

describe("the chained append", () => {
  test("links each event to the one before it, over its canonical serialization", async () => {
    for (const action of ["auth/login", "auth/logout", "auth/login"]) {
      await recordAuditEvent(db(), { action, outcome: "success", actorType: "user", actorId: "u1", tenant: "acme" });
    }
    const events = await chainOf("acme");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events[0]?.prev).toBeNull();
    expect(events[1]?.prev).toBe(events[0]?.hash);
    expect(events[2]?.prev).toBe(events[1]?.hash);
    for (const event of events) {
      const { seq, prev, hash, salt: _s, ip: _i, userAgent: _u, metadata: _m, ...fields } = event;
      expect(await chainHash({ seq, prev }, fields)).toBe(hash);
    }
  });

  test("commits the IP, user-agent and metadata by salted hash, never by value", async () => {
    await recordAuditEvent(db(), {
      action: "auth/login",
      outcome: "success",
      actorType: "user",
      tenant: "acme",
      ip: "203.0.113.9",
      userAgent: "curl/8",
      metadata: { provider: "google" },
    });
    const [event] = await chainOf("acme");
    expect(event?.salt).toMatch(/^[0-9a-f]{32}$/);
    const salt = event?.salt as string;
    expect(event?.ipCommitment).toBe(await commitment(salt, "203.0.113.9"));
    expect(event?.userAgentCommitment).toBe(await commitment(salt, "curl/8"));
    expect(event?.metadataCommitment).toBe(await commitment(salt, JSON.stringify({ provider: "google" })));
    // Without the detail, the export carries the commitments and nothing they commit to.
    const [row] = await readChainRows(db(), { tenant: "acme", afterSeq: 0, limit: 10 });
    const bare = await chainedEventOf(row as never, { detail: false });
    expect(bare).not.toHaveProperty("ip");
    expect(bare).not.toHaveProperty("salt");
    expect(bare.ipCommitment).toBe(event?.ipCommitment);
  });

  test("keeps one chain per tenant, and one for events with no tenant", async () => {
    await recordAuditEvent(db(), { action: "auth/login", outcome: "success", actorType: "user", tenant: "acme" });
    await recordAuditEvent(db(), { action: "auth/login", outcome: "success", actorType: "user", tenant: "globex" });
    await recordAuditEvent(db(), { action: "auth/login", outcome: "success", actorType: "system" });
    await recordAuditEvent(db(), { action: "auth/login", outcome: "success", actorType: "user", tenant: "acme" });
    expect((await chainOf("acme")).map((event) => event.seq)).toEqual([1, 2]);
    expect((await chainOf("globex")).map((event) => event.seq)).toEqual([1]);
    expect((await chainOf(null)).map((event) => event.seq)).toEqual([1]);
  });

  test("a burst of concurrent appends to one tenant lands every event, and never forks its chain", async () => {
    // Past the 64 lost races the first cut gave one append, after which the recorder dropped the event.
    const appends = Array.from({ length: 100 }, (_, i) =>
      recordAuditEvent(
        db(),
        { action: "auth/login", outcome: "success", actorType: "user", actorId: `u${i}`, tenant: "acme" },
        { onError: (error) => expect.fail(`append ${i} dropped: ${error.message}`) },
      ),
    );
    // A second tenant and the untenanted chain contend for the same table at the same time.
    const others = Array.from({ length: 10 }, (_, i) =>
      recordAuditEvent(db(), {
        action: "auth/login",
        outcome: "success",
        actorType: "user",
        tenant: i % 2 ? "globex" : null,
      }),
    );
    await Promise.all([...appends, ...others]);

    for (const [tenant, length] of [
      ["acme", 100],
      ["globex", 5],
      [null, 5],
    ] as const) {
      const events = await chainOf(tenant);
      expect(events.map((event) => event.seq)).toEqual(Array.from({ length }, (_, i) => i + 1));
      const verifier = chainVerifier({ tenant, prior: null, checkpoints: [] });
      for (const event of events) expect(await verifier.push(event)).toBeNull();
    }
  });

  test("a database not yet migrated to the chain still records, unchained", async () => {
    await migrate(4);
    const errors: unknown[] = [];
    await recordAuditEvent(
      db(),
      { action: "auth/login", outcome: "success", actorType: "user", tenant: "acme" },
      { onError: (error) => errors.push(error) },
    );
    expect(errors).toEqual([]);
    expect(await env.DB.prepare("select count(*) as n from pithy_audit_events").first<{ n: number }>()).toEqual({
      n: 1,
    });
  });
});
