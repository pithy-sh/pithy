// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  AUDIT_CHAIN_FORMAT,
  AuditChainExport,
  type AuditCheckpoint,
  type AuditTombstone,
  type ChainedEvent,
  type ChainedEventFields,
  canonicalEvent,
  chainHash,
  chainVerifier,
  commitment,
  newChainSalt,
  sha256Hex,
  verifyChainExport,
} from "./chain";

/** One event's hashed fields, every personal field already committed. */
function fields(overrides: Partial<ChainedEventFields> = {}): ChainedEventFields {
  return {
    eventId: "0f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13",
    occurredAt: 1_780_000_000_000,
    action: "auth/login",
    outcome: "success",
    severity: "info",
    actorType: "user",
    actorId: "user-1",
    actorKind: null,
    sessionId: null,
    resourceType: null,
    resourceId: null,
    requestId: "ray-1",
    tenant: "acme",
    project: "shop",
    environment: "prod",
    worker: "api",
    version: null,
    ipCommitment: null,
    userAgentCommitment: null,
    metadataCommitment: null,
    ...overrides,
  };
}

/** A chain of `n` linked events for one tenant, each with personal values and their salt. */
async function chain(n: number, tenant: string | null = "acme"): Promise<ChainedEvent[]> {
  const events: ChainedEvent[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const salt = newChainSalt();
    const ip = `203.0.113.${seq}`;
    const userAgent = "curl/8";
    const metadata = JSON.stringify({ n: seq });
    const hashed = fields({
      eventId: `evt-${seq}`,
      occurredAt: 1_780_000_000_000 + seq,
      tenant,
      ipCommitment: await commitment(salt, ip),
      userAgentCommitment: await commitment(salt, userAgent),
      metadataCommitment: await commitment(salt, metadata),
    });
    const hash = await chainHash({ seq, prev }, hashed);
    events.push({ ...hashed, seq, prev, hash, salt, ip, userAgent, metadata });
    prev = hash;
  }
  return events;
}

/** The export a route would hand over for a whole chain, with the given checkpoints. */
function exportOf(
  events: ChainedEvent[],
  checkpoints: AuditCheckpoint[] = [],
  overrides: Partial<AuditChainExport> = {},
): AuditChainExport {
  return {
    format: "pithy-audit-export/1",
    chain: AUDIT_CHAIN_FORMAT,
    tenant: events[0]?.tenant ?? "acme",
    since: null,
    until: null,
    exportedAt: "2026-06-10T12:00:00.000Z",
    detail: true,
    prior: null,
    events,
    checkpoints,
    tombstones: [],
    complete: true,
    beforeChain: 0,
    outsideChain: 0,
    nextCursor: null,
    ...overrides,
  };
}

function checkpoint(event: ChainedEvent, tenant: string | null = "acme"): AuditCheckpoint {
  return {
    format: "pithy-audit-checkpoint/1",
    tenant,
    count: event.seq,
    head: event.hash,
    takenAt: "2026-06-10T11:00:00.000Z",
  };
}

describe("the canonical serialization", () => {
  test("is a fixed-order JSON array led by the format, the position and the link", () => {
    const text = canonicalEvent({ seq: 3, prev: "ab".repeat(32) }, fields());
    const parsed = JSON.parse(text) as unknown[];
    expect(parsed.slice(0, 4)).toEqual([
      AUDIT_CHAIN_FORMAT,
      3,
      "ab".repeat(32),
      "0f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13",
    ]);
    expect(parsed).toHaveLength(23);
  });

  test("does not depend on the order an object's keys were written in", () => {
    const forward = fields();
    const reversed = Object.fromEntries(Object.entries(forward).reverse()) as ChainedEventFields;
    expect(canonicalEvent({ seq: 1, prev: null }, reversed)).toBe(canonicalEvent({ seq: 1, prev: null }, forward));
  });

  test("tells a null from the string 'null' and an absent tenant from an empty one", () => {
    const link = { seq: 1, prev: null };
    expect(canonicalEvent(link, fields({ actorId: null }))).not.toBe(canonicalEvent(link, fields({ actorId: "null" })));
    expect(canonicalEvent(link, fields({ tenant: null }))).not.toBe(canonicalEvent(link, fields({ tenant: "" })));
  });

  test("covers every field: changing any one changes the hash", async () => {
    const base = fields();
    const link = { seq: 1, prev: null };
    const original = await chainHash(link, base);
    for (const key of Object.keys(base) as (keyof ChainedEventFields)[]) {
      const value = base[key];
      const changed = { ...base, [key]: typeof value === "number" ? value + 1 : `${value ?? ""}x` };
      expect(await chainHash(link, changed), key).not.toBe(original);
    }
    expect(await chainHash({ seq: 2, prev: null }, base)).not.toBe(original);
    expect(await chainHash({ seq: 1, prev: "00".repeat(32) }, base)).not.toBe(original);
  });
});

describe("commitments", () => {
  test("a null value commits to null", async () => {
    expect(await commitment(newChainSalt(), null)).toBeNull();
  });

  test("the same value under two salts commits to two hashes, so a commitment cannot be looked up", async () => {
    const a = await commitment(newChainSalt(), "203.0.113.7");
    const b = await commitment(newChainSalt(), "203.0.113.7");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  test("sha256Hex is lowercase hex SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("a salt is 32 hex characters, fresh every time", () => {
    expect(newChainSalt()).toMatch(/^[0-9a-f]{32}$/);
    expect(newChainSalt()).not.toBe(newChainSalt());
  });
});

describe("verifyChainExport", () => {
  test("accepts an untouched chain, with and without its personal values", async () => {
    const events = await chain(5);
    const intact = await verifyChainExport(exportOf(events, [checkpoint(events[2] as ChainedEvent)]));
    expect(intact).toMatchObject({ intact: true, checked: 5, checkpoints: 1, break: null });
    const withoutValues = events.map(({ salt: _s, ip: _i, userAgent: _u, metadata: _m, ...rest }) => rest);
    expect(await verifyChainExport(exportOf(withoutValues, [], { detail: false }))).toMatchObject({ intact: true });
  });

  test("an untenanted chain verifies on its own terms", async () => {
    const events = await chain(3, null);
    expect(
      await verifyChainExport(exportOf(events, [checkpoint(events[2] as ChainedEvent, null)], { tenant: null })),
    ).toMatchObject({ intact: true, checkpoints: 1 });
  });

  test("an edited field is a break at that event", async () => {
    const events = await chain(4);
    (events[2] as ChainedEvent).action = "auth/logout";
    expect((await verifyChainExport(exportOf(events))).break).toMatchObject({
      eventId: "evt-3",
      position: 3,
      reason: "edited",
    });
  });

  test("an edited personal value is a break, though the hash it is committed under is untouched", async () => {
    const events = await chain(4);
    (events[1] as ChainedEvent).ip = "198.51.100.1";
    expect((await verifyChainExport(exportOf(events))).break).toMatchObject({
      eventId: "evt-2",
      position: 2,
      reason: "commitment",
    });
  });

  test("an edited personal value with its salt stripped is still a break", async () => {
    const events = await chain(4);
    const target = events[1] as ChainedEvent;
    target.ip = "198.51.100.1";
    delete target.salt;
    for (const detail of [true, false]) {
      expect((await verifyChainExport(exportOf(events, [], { detail }))).break).toMatchObject({
        eventId: "evt-2",
        position: 2,
        reason: "commitment",
      });
    }
  });

  test("an edited metadata value with its salt stripped is still a break", async () => {
    const events = await chain(3);
    const target = events[2] as ChainedEvent;
    target.metadata = JSON.stringify({ n: 99 });
    delete target.salt;
    expect((await verifyChainExport(exportOf(events))).break).toMatchObject({ eventId: "evt-3", reason: "commitment" });
  });

  test("an export that says it carries the values is a break at an event carrying none", async () => {
    const events = await chain(3);
    const { salt: _s, ip: _i, userAgent: _u, metadata: _m, ...bare } = events[1] as ChainedEvent;
    events[1] = bare;
    expect((await verifyChainExport(exportOf(events, [], { detail: true }))).break).toMatchObject({
      eventId: "evt-2",
      position: 2,
      reason: "commitment",
    });
    // Without the claim, an event without values is one whose commitments stand unopened, as in the listing.
    expect(await verifyChainExport(exportOf(events, [], { detail: false }))).toMatchObject({ intact: true });
  });

  test("a deleted event is a break at the event after the gap", async () => {
    const events = await chain(5);
    events.splice(2, 1);
    expect((await verifyChainExport(exportOf(events))).break).toMatchObject({
      eventId: "evt-4",
      position: 3,
      reason: "missing",
    });
  });

  test("an inserted event is a break where it sits", async () => {
    const events = await chain(4);
    const forged = { ...(events[1] as ChainedEvent), eventId: "evt-forged" };
    events.splice(2, 0, forged);
    expect((await verifyChainExport(exportOf(events))).break).toMatchObject({
      eventId: "evt-forged",
      position: 3,
      reason: "inserted",
    });
  });

  test("a rewritten tail with every hash recomputed is caught against the checkpoint", async () => {
    const events = await chain(5);
    const cp = checkpoint(events[3] as ChainedEvent);
    // Rewrite events 3..5 and recompute the chain over them, so every link checks.
    let prev = (events[1] as ChainedEvent).hash;
    for (let i = 2; i < events.length; i++) {
      const event = events[i] as ChainedEvent;
      event.action = "auth/logout";
      const { seq, prev: _p, hash: _h, salt: _s, ip: _i, userAgent: _u, metadata: _m, ...hashed } = event;
      event.prev = prev;
      event.hash = await chainHash({ seq, prev }, hashed);
      prev = event.hash;
    }
    expect((await verifyChainExport(exportOf(events, [cp]))).break).toMatchObject({
      eventId: "evt-4",
      position: 4,
      reason: "checkpoint",
    });
  });

  test("a truncated tail is caught against a checkpoint past the end", async () => {
    const events = await chain(5);
    const cp = checkpoint(events[4] as ChainedEvent);
    expect((await verifyChainExport(exportOf(events.slice(0, 3), [cp]))).break).toMatchObject({
      eventId: null,
      position: 4,
      reason: "truncated",
    });
    // A page that does not run to the head says nothing about what follows it.
    expect(await verifyChainExport(exportOf(events.slice(0, 3), [cp], { complete: false }))).toMatchObject({
      intact: true,
    });
  });

  test("a range verifies from the prior link, and a wrong prior is a break", async () => {
    const events = await chain(5);
    const prior = { seq: 2, hash: (events[1] as ChainedEvent).hash };
    expect(await verifyChainExport(exportOf(events.slice(2), [], { prior }))).toMatchObject({ intact: true });
    expect(
      (await verifyChainExport(exportOf(events.slice(2), [], { prior: { seq: 2, hash: "00".repeat(32) } }))).break,
    ).toMatchObject({ eventId: "evt-3", position: 3, reason: "unlinked" });
    expect((await verifyChainExport(exportOf(events.slice(2)))).break).toMatchObject({
      eventId: "evt-3",
      position: 1,
      reason: "missing",
    });
  });

  test("an event from another tenant's chain is a break", async () => {
    const events = await chain(3);
    (events[1] as ChainedEvent).tenant = "globex";
    expect((await verifyChainExport(exportOf(events))).break).toMatchObject({ eventId: "evt-2", reason: "inserted" });
  });

  test("a checkpoint for another tenant is ignored", async () => {
    const events = await chain(3);
    const foreign = { ...checkpoint(events[1] as ChainedEvent), tenant: "globex", head: "00".repeat(32) };
    expect(await verifyChainExport(exportOf(events, [foreign]))).toMatchObject({ intact: true, checkpoints: 0 });
  });

  test("the export parses with its own schema, and refuses a document that is not one", async () => {
    const doc = exportOf(await chain(2));
    expect(AuditChainExport.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(AuditChainExport.safeParse({ format: "something-else" }).success).toBe(false);
  });
});

describe("chainVerifier, fed page by page", () => {
  test("carries the link across pages and reports the head", async () => {
    const events = await chain(6);
    const verifier = chainVerifier({ tenant: "acme", prior: null, checkpoints: [] });
    for (const event of events) expect(await verifier.push(event)).toBeNull();
    expect(verifier.finish(true)).toBeNull();
    expect(verifier.head).toEqual({ seq: 6, hash: (events[5] as ChainedEvent).hash });
    expect(verifier.checked).toBe(6);
  });
});

/** The tombstone the prune writes for positions `from` to `through` of a chain. */
function tombstone(
  events: ChainedEvent[],
  from: number,
  through: number,
  tenant: string | null = "acme",
): AuditTombstone {
  const first = events[from - 1] as ChainedEvent;
  const last = events[through - 1] as ChainedEvent;
  return {
    format: "pithy-audit-tombstone/1",
    tenant,
    fromSeq: from,
    throughSeq: through,
    count: through - from + 1,
    prior: first.prev,
    first: first.hash,
    last: last.hash,
    prunedAt: "2026-06-10T12:00:00.000Z",
  };
}

describe("a pruned run, bridged by its tombstone", () => {
  test("a chain pruned from its start verifies as intact, and says how many it crossed", async () => {
    const events = await chain(6);
    const result = await verifyChainExport(
      exportOf(events.slice(3), [checkpoint(events[5] as ChainedEvent)], { tombstones: [tombstone(events, 1, 3)] }),
    );
    expect(result).toMatchObject({ intact: true, checked: 3, pruned: 3, break: null });
  });

  test("a gap in the middle is bridged, and so are two runs back to back", async () => {
    const events = await chain(8);
    const kept = [events[0], events[1], events[6], events[7]] as ChainedEvent[];
    const result = await verifyChainExport(
      exportOf(kept, [], { tombstones: [tombstone(events, 3, 4), tombstone(events, 5, 6)] }),
    );
    expect(result).toMatchObject({ intact: true, checked: 4, pruned: 4 });
  });

  test("a gap no tombstone covers is still a missing break", async () => {
    const events = await chain(6);
    const result = await verifyChainExport(exportOf(events.slice(3), [], { tombstones: [tombstone(events, 1, 2)] }));
    expect(result.break).toMatchObject({ reason: "missing", position: 3 });
  });

  test("a tombstone whose link does not match the event before it bridges nothing", async () => {
    const events = await chain(6);
    const forged = { ...tombstone(events, 3, 4), prior: (events[0] as ChainedEvent).hash };
    const result = await verifyChainExport(
      exportOf([events[0], events[1], events[4], events[5]] as ChainedEvent[], [], { tombstones: [forged] }),
    );
    expect(result.break).toMatchObject({ reason: "missing", position: 3 });
  });

  test("a tombstone whose last hash the next event does not name is an unlinked break", async () => {
    const events = await chain(6);
    const forged = { ...tombstone(events, 1, 3), last: (events[0] as ChainedEvent).hash };
    const result = await verifyChainExport(exportOf(events.slice(3), [], { tombstones: [forged] }));
    expect(result.break).toMatchObject({ reason: "unlinked", position: 4 });
  });

  test("a checkpoint at the end of a pruned run is held to the tombstone", async () => {
    const events = await chain(6);
    const other = await chain(6, "beta");
    const wrong = { ...checkpoint(events[2] as ChainedEvent), head: (other[2] as ChainedEvent).hash };
    const result = await verifyChainExport(
      exportOf(events.slice(3), [wrong], { tombstones: [tombstone(events, 1, 3)] }),
    );
    expect(result.break).toMatchObject({ reason: "checkpoint", position: 3, eventId: null });
  });

  test("another tenant's tombstone is ignored", async () => {
    const events = await chain(6);
    const result = await verifyChainExport(
      exportOf(events.slice(3), [], { tombstones: [tombstone(events, 1, 3, "beta")] }),
    );
    expect(result.break).toMatchObject({ reason: "missing" });
  });

  test("an export from before tombstones existed parses, and verifies, with none", async () => {
    const { tombstones: _none, ...older } = exportOf(await chain(2));
    expect((await verifyChainExport(older)).intact).toBe(true);
    expect(AuditChainExport.parse(older).tombstones).toBeUndefined();
  });
});
