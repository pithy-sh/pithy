// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { AUDIT_CHAIN_FORMAT, commitment } from "@pithy-sh/core/src/audit/chain";
import { describe, expect, test } from "vitest";
import type { ChainRow } from "../chain/rows";
import { AUDIT_SHIP_FORMAT, ShippedAuditEvent, shippedEventOf } from "./event";

/** One stored row as a sink receives it (#824): chained, and from before the chain. */

const HASH = "a".repeat(64);
const PREV = "b".repeat(64);

const base: ChainRow = {
  id: 7,
  eventId: "evt-1",
  occurredAt: 1_761_600_000_000,
  action: "auth/sign_in",
  outcome: "success",
  severity: "info",
  actorType: "user",
  actorId: "u-1",
  actorKind: null,
  sessionId: null,
  resourceType: null,
  resourceId: null,
  requestId: "req-1",
  tenant: null,
  project: "acme",
  environment: "prod",
  worker: "api",
  version: null,
  ip: "203.0.113.9",
  userAgent: "curl/8",
  metadata: '{"k":"v"}',
  chainSeq: 4,
  chainPrev: PREV,
  chainHash: HASH,
  chainSalt: "salt-1",
};

const unchained: ChainRow = { ...base, chainSeq: null, chainPrev: null, chainHash: null, chainSalt: null };

describe("shippedEventOf", () => {
  test("a chained row ships its position, its link, its hash and its commitments under its salt", async () => {
    const event = await shippedEventOf(base, { detail: false });
    expect(ShippedAuditEvent.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      format: AUDIT_SHIP_FORMAT,
      chain: AUDIT_CHAIN_FORMAT,
      eventId: "evt-1",
      seq: 4,
      prev: PREV,
      hash: HASH,
      ipCommitment: await commitment("salt-1", "203.0.113.9"),
      userAgentCommitment: await commitment("salt-1", "curl/8"),
      metadataCommitment: await commitment("salt-1", '{"k":"v"}'),
    });
  });

  test("a chained row without detail carries no value and no salt", async () => {
    const event = await shippedEventOf(base, { detail: false });
    for (const key of ["salt", "ip", "userAgent", "metadata"]) expect(event).not.toHaveProperty(key);
  });

  test("a chained row with detail carries the values and the salt they were committed under", async () => {
    const event = await shippedEventOf(base, { detail: true });
    expect(event).toMatchObject({ salt: "salt-1", ip: "203.0.113.9", userAgent: "curl/8", metadata: '{"k":"v"}' });
  });

  test.each([false, true])(
    "an unchained row ships no position, no hash and no commitments (detail: %s)",
    async (detail) => {
      const event = await shippedEventOf(unchained, { detail });
      expect(ShippedAuditEvent.parse(event)).toEqual(event);
      expect(event).toMatchObject({
        seq: null,
        prev: null,
        hash: null,
        ipCommitment: null,
        userAgentCommitment: null,
        metadataCommitment: null,
      });
      // An unsalted hash of an IP address is reversible. The salt is never invented, not even for a detail sink.
      expect(event).not.toHaveProperty("salt");
    },
  );

  test("an unchained row with detail still carries the values", async () => {
    const event = await shippedEventOf(unchained, { detail: true });
    expect(event).toMatchObject({ ip: "203.0.113.9", userAgent: "curl/8", metadata: '{"k":"v"}' });
  });

  test("a row with a position but no salt is outside the chain, not chained under an empty salt", async () => {
    const event = await shippedEventOf({ ...base, chainSalt: null }, { detail: false });
    expect(event).toMatchObject({ seq: null, hash: null, ipCommitment: null });
  });

  test.each([false, true])(
    "a row read before audit_0005_chain, its columns SQLite's string literals, ships unchained (detail: %s)",
    async (detail) => {
      // SQLite reads an unknown double-quoted identifier as a string literal, so a database the app reached before
      // `pithy migrate` hands back the column names as the values. That is no position, no hash and no salt.
      const unmigrated = {
        ...base,
        chainSeq: "chain_seq",
        chainPrev: "chain_prev",
        chainHash: "chain_hash",
        chainSalt: "chain_salt",
      } as unknown as ChainRow;
      const event = await shippedEventOf(unmigrated, { detail });
      expect(ShippedAuditEvent.parse(event)).toEqual(event);
      expect(event).toMatchObject({
        seq: null,
        prev: null,
        hash: null,
        ipCommitment: null,
        userAgentCommitment: null,
        metadataCommitment: null,
      });
      expect(event).not.toHaveProperty("salt");
    },
  );

  test("a row whose chain columns did not come back at all ships unchained", async () => {
    const { chainSeq: _s, chainPrev: _p, chainHash: _h, chainSalt: _t, ...rest } = base;
    const event = await shippedEventOf(rest as unknown as ChainRow, { detail: true });
    expect(ShippedAuditEvent.parse(event)).toEqual(event);
    expect(event).toMatchObject({ seq: null, prev: null, hash: null, ipCommitment: null });
    expect(event).not.toHaveProperty("salt");
  });
});
