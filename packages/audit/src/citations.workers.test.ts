// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import { composedAuditCitations } from "@pithy-sh/core/src/audit/citations";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { audit } from "./capability";
import { auditCitationReader } from "./citations";
import { auditDatabase } from "./data/tables";
import { audit_0001_init } from "./migrations/0001_init";
import { audit_0002_actor_kind } from "./migrations/0002_actor_kind";
import { audit_0003_call_index } from "./migrations/0003_call_index";
import { audit_0004_request_index } from "./migrations/0004_request_index";
import { audit_0005_chain } from "./migrations/0005_chain";
import { recordAuditEvent } from "./recorder";

/** Citing the trail (#823): which events name a resource, and where each sits in its chain. */

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

const step = (resourceId: string, name: string, tenant: string | null = null) =>
  recordAuditEvent(db(), {
    action: "auth/admin_user_purge_step",
    outcome: "success",
    actorType: "system",
    resourceType: "user",
    resourceId,
    tenant,
    ip: "203.0.113.9",
    metadata: { step: name, disposition: "erased" },
  });

describe("auditCitationReader", () => {
  beforeEach(() => migrate());

  test("cites each matching event by id and chain position, oldest first, with the step it names", async () => {
    await step("u1", "media");
    await recordAuditEvent(db(), {
      action: "auth/login",
      outcome: "success",
      actorType: "user",
      resourceType: "user",
      resourceId: "u1",
    });
    await step("u2", "media");
    await step("u1", "auth");
    const cited = await auditCitationReader(db())({
      resourceType: "user",
      resourceIds: ["u1"],
      actions: ["auth/admin_user_purge_step"],
    });
    expect(cited.map((each) => [each.resourceId, each.step, each.seq, each.tenant])).toEqual([
      ["u1", "media", 1, null],
      ["u1", "auth", 4, null],
    ]);
    for (const each of cited) {
      expect(each.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(each.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Where it is, never what it holds.
    expect(JSON.stringify(cited)).not.toContain("203.0.113.9");
  });

  test("an event recorded before the chain began is cited with no position, never a guessed one", async () => {
    await migrate(4);
    await step("u1", "media");
    await audit_0005_chain.up(db() as unknown as Kysely<unknown>);
    const [cited] = await auditCitationReader(db())({
      resourceType: "user",
      resourceIds: ["u1"],
      actions: ["auth/admin_user_purge_step"],
    });
    expect(cited).toMatchObject({ step: "media", seq: null, hash: null });
  });

  test("asks nothing of the database for an empty query", async () => {
    expect(await auditCitationReader(db())({ resourceType: "user", resourceIds: [], actions: ["x/y"] })).toEqual([]);
  });

  test("the composed audit capability provides it, over the binding its config names", async () => {
    await step("u1", "media");
    const reader = composedAuditCitations([audit()], { DB: env.DB });
    expect(reader).not.toBeNull();
    const cited = await reader?.({
      resourceType: "user",
      resourceIds: ["u1"],
      actions: ["auth/admin_user_purge_step"],
    });
    expect(cited?.map((each) => each.seq)).toEqual([1]);
    expect(composedAuditCitations([], { DB: env.DB })).toBeNull();
  });
});
