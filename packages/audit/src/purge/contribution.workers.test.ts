// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import { credentialFields, isRetained } from "@pithy-sh/core/src/capability/purge";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { audit } from "../capability";
import { auditDatabase } from "../data/tables";
import { audit_0001_init } from "../migrations/0001_init";
import { audit_0002_actor_kind } from "../migrations/0002_actor_kind";
import { recordAuditEvent } from "../recorder";
import { AUDIT_PURGE_SUMMARY, AUDIT_RETENTION_BASIS, auditUserPurge } from "./contribution";

/**
 * Audit's part of a person's purge and export (#814), over real D1: it retains with a basis, and the export answers
 * for every event where the person is the actor, and no one else's.
 */

const T0 = 1_700_000_000_000;
const purge = auditUserPurge();

async function exportOf(id: string): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export({ subject: { type: "user", id }, env: { DB: env.DB } });
}

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  const db = auditDatabase(env.DB);
  await audit_0001_init.up(db as unknown as Kysely<unknown>);
  await audit_0002_actor_kind.up(db as unknown as Kysely<unknown>);
  for (const [actorId, at] of [
    ["ada", T0],
    ["bob", T0 + 1],
    ["ada", T0 + 2],
  ] as const) {
    await recordAuditEvent(db, {
      action: "auth/login",
      outcome: "success",
      severity: "info",
      actorType: "user",
      actorId,
      ip: "203.0.113.7",
      occurredAt: new Date(at),
    });
  }
});

describe("the audit user purge", () => {
  test("audit() declares it for the user subject: retained, with a basis and an export, and no erase", () => {
    const declared = audit().purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    const [contribution] = declared;
    expect(contribution?.summary).toBe(AUDIT_PURGE_SUMMARY);
    expect(contribution && isRetained(contribution)).toBe(true);
    expect(contribution?.retain?.basis).toBe(AUDIT_RETENTION_BASIS);
    expect(contribution?.erase).toBeUndefined();
  });

  test("exports every event where the person is the actor, and no one else's, and no credential", async () => {
    const data = await exportOf("ada");
    expect(data.events).toEqual([
      expect.objectContaining({ actorId: "ada", action: "auth/login", occurredAt: new Date(T0).toISOString() }),
      expect.objectContaining({ actorId: "ada", occurredAt: new Date(T0 + 2).toISOString() }),
    ]);
    expect(JSON.stringify(data)).not.toContain("bob");
    expect(credentialFields(data)).toEqual([]);
  });
});
