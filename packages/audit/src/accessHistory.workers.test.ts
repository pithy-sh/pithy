// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { ACCESS_HISTORY_METADATA_KEYS, accessHistory, accessHistoryStatement } from "./accessHistory";
import { type AuditDatabase, auditDatabase } from "./data/tables";
import { audit_0001_init } from "./migrations/0001_init";
import { audit_0002_actor_kind } from "./migrations/0002_actor_kind";
import { recordAuditEvent } from "./recorder";

/**
 * Who could do what, over time — `#831`, against real D1.
 *
 * Every row is written through the real recorder, in the shapes each emitter writes it — `@pithy-sh/organization`'s
 * `recordOrganizationAction` and `recordOperatorAction`, the CLI's `connectionRegistry`, and the seam's key routes —
 * so the `json_extract` paths here are the ones production rows carry.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const ALL_TIME = { since: new Date(0), until: new Date(10_000_000) };
const IP = "203.0.113.9";
const UA = "Mozilla/5.0 (Leaky)";

function db(d1: D1Database = env.DB as unknown as D1Database): AuditDatabase {
  return auditDatabase(d1);
}

async function seed(event: AuditEventInput, at: number): Promise<void> {
  await recordAuditEvent(db(), { ip: IP, userAgent: UA, ...event, occurredAt: new Date(at) });
}

/** A member's act inside their own account, as `recordOrganizationAction` writes it. */
function memberAct(action: string, membershipId: string, metadata: Record<string, unknown>, actor = "user_ada") {
  return {
    action,
    outcome: "success",
    actorType: "user",
    actorId: actor,
    tenant: ACME,
    resourceType: "membership",
    resourceId: membershipId,
    sessionId: "session_1",
    metadata,
  } satisfies AuditEventInput;
}

/** An operator's act inside an account, as `recordOperatorAction` writes it. */
function operatorAct(action: string, membershipId: string, metadata: Record<string, unknown>) {
  return {
    action,
    outcome: "success",
    actorType: "control-plane",
    actorId: "support@vendor",
    actorKind: "dashboard",
    tenant: ACME,
    resourceType: "membership",
    resourceId: membershipId,
    metadata: { connectionId: CONNECTION, reason: "Ticket 4411, the customer asked.", ...metadata },
  } satisfies AuditEventInput;
}

/** A connection-lifecycle event, as the CLI's `connectionRegistry` writes it. */
function lifecycle(action: string, metadata: Record<string, unknown>) {
  return {
    action,
    outcome: "success",
    severity: "warning",
    actorType: "user",
    actorId: "cf:ada@example.com",
    resourceType: "controlplane_connection",
    resourceId: CONNECTION,
    metadata: { connectionId: CONNECTION, connectionEnvironment: "prod", ...metadata },
  } satisfies AuditEventInput;
}

/** A key event, as the seam's own key routes write it. */
function keyEvent(action: string, metadata: Record<string, unknown>) {
  return {
    action,
    outcome: "success",
    severity: "warning",
    actorType: "control-plane",
    actorId: "usr_dash",
    actorKind: "dashboard",
    resourceType: "controlplane_connection",
    resourceId: CONNECTION,
    metadata: { connectionId: CONNECTION, connectionEnvironment: "prod", ...metadata },
  } satisfies AuditEventInput;
}

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  for (const migration of [audit_0001_init, audit_0002_actor_kind]) {
    await migration.up(db() as unknown as Kysely<unknown>);
  }
});

describe("member changes", () => {
  test("a join, a role change and a removal, oldest first, each with its before and after", async () => {
    await seed(
      memberAct("organization/member_removed", "mem_bob", { role: "member", subjectUserId: "user_bob" }),
      3_000,
    );
    await seed(
      memberAct("organization/member_joined", "mem_bob", { role: "admin", subjectUserId: "user_bob" }, "user_bob"),
      1_000,
    );
    await seed(
      memberAct("organization/member_role_changed", "mem_bob", {
        role: "member",
        previousRole: "admin",
        subjectUserId: "user_bob",
      }),
      2_000,
    );

    const { changes, nextCursor } = await accessHistory(db(), ALL_TIME);

    expect(nextCursor).toBeNull();
    expect(changes.map((change) => [change.action, change.roleBefore, change.roleAfter, change.recorded])).toEqual([
      ["organization/member_joined", null, "admin", true],
      ["organization/member_role_changed", "admin", "member", true],
      ["organization/member_removed", "member", null, true],
    ]);
    expect(changes[1]).toMatchObject({
      subject: "member",
      occurredAt: new Date(2_000),
      actorType: "user",
      actorId: "user_ada",
      organizationId: ACME,
      membershipId: "mem_bob",
      userId: "user_bob",
      connectionId: null,
      scopesBefore: null,
      keyId: null,
    });
  });

  test("every membership code reads its before and after from where its emitter puts them", async () => {
    await seed(
      {
        ...memberAct("organization/created", ACME, {
          slug: "acme",
          role: "admin",
          derived: false,
          membershipId: "mem_founder",
          subjectUserId: "user_ada",
        }),
        resourceType: "organization",
      },
      1,
    );
    await seed(
      operatorAct("organization/admin_member_added", "mem_cai", { role: "member", subjectUserId: "user_cai" }),
      2,
    );
    await seed(
      operatorAct("organization/admin_member_role_changed", "mem_cai", {
        role: "admin",
        previousRole: "member",
        subjectUserId: "user_cai",
      }),
      3,
    );
    await seed(
      memberAct(
        "organization/ownership_accepted",
        "mem_bob",
        { confers: "owner", demoted: 1, role: "owner", previousRole: "admin", subjectUserId: "user_bob" },
        "user_bob",
      ),
      4,
    );
    await seed(
      operatorAct("organization/admin_ownership_forced", "mem_cai", {
        confers: "owner",
        role: "owner",
        previousRole: "admin",
        subjectUserId: "user_cai",
        previousOwner: "remove",
      }),
      5,
    );
    await seed(
      memberAct("organization/member_left", "mem_dan", { role: "member", subjectUserId: "user_dan" }, "user_dan"),
      6,
    );
    await seed(
      operatorAct("organization/admin_member_removed", "mem_bob", {
        role: "owner",
        subjectUserId: "user_bob",
        mailed: "queued",
      }),
      7,
    );

    const { changes } = await accessHistory(db(), ALL_TIME);

    expect(
      changes.map((change) => [
        change.action,
        change.membershipId,
        change.userId,
        change.roleBefore,
        change.roleAfter,
        change.recorded,
      ]),
    ).toEqual([
      ["organization/created", "mem_founder", "user_ada", null, "admin", true],
      ["organization/admin_member_added", "mem_cai", "user_cai", null, "member", true],
      ["organization/admin_member_role_changed", "mem_cai", "user_cai", "member", "admin", true],
      ["organization/ownership_accepted", "mem_bob", "user_bob", "admin", "owner", true],
      ["organization/admin_ownership_forced", "mem_cai", "user_cai", "admin", "owner", true],
      ["organization/member_left", "mem_dan", "user_dan", "member", null, true],
      ["organization/admin_member_removed", "mem_bob", "user_bob", "owner", null, true],
    ]);
    // An operator's act names the kind of client that took it, as the listing does.
    expect(changes[1]).toMatchObject({ actorType: "control-plane", actorKind: "dashboard", organizationId: ACME });
  });

  test("an older event without its before reads as not recorded, never as a guess", async () => {
    // As `member_role_changed` and the ownership acceptance were written before #831.
    await seed(
      memberAct("organization/member_role_changed", "mem_bob", { role: "member", subjectUserId: "user_bob" }),
      1,
    );
    await seed(
      memberAct("organization/ownership_accepted", "mem_bob", { confers: "owner", demoted: 1 }, "user_bob"),
      2,
    );
    // And a join written before the member was named: its actor is the member.
    await seed(memberAct("organization/member_joined", "mem_cai", { role: "member" }, "user_cai"), 3);

    const { changes } = await accessHistory(db(), ALL_TIME);

    expect(changes.map((change) => [change.roleBefore, change.roleAfter, change.userId, change.recorded])).toEqual([
      [null, "member", "user_bob", false],
      [null, "owner", "user_bob", false],
      [null, "member", "user_cai", true],
    ]);
  });

  test("an invitation redeemed by someone already a member changed nothing, so it is no change", async () => {
    // `acceptInvitation` answers `joined: false` and leaves the membership and its role as they were, but the row
    // still names the role the invitation offered. A join at that role never happened.
    await seed(
      memberAct("organization/member_joined", "mem_bob", { role: "member", joined: true, subjectUserId: "user_bob" }),
      1,
    );
    await seed(
      memberAct("organization/member_joined", "mem_bob", { role: "admin", joined: false, subjectUserId: "user_bob" }),
      2,
    );
    // A row written before `joined` was recorded is a join, as it always was.
    await seed(memberAct("organization/member_joined", "mem_cai", { role: "member" }, "user_cai"), 3);

    const { changes } = await accessHistory(db(), ALL_TIME);

    expect(changes.map((change) => [change.membershipId, change.roleBefore, change.roleAfter])).toEqual([
      ["mem_bob", null, "member"],
      ["mem_cai", null, "member"],
    ]);
  });
});

describe("connection changes", () => {
  const REGISTERED = {
    issuer: "https://app.pithy.sh",
    workerUrl: "https://api.example.com",
    basePath: "/control-plane",
    scopes: ["manifest:read", "audit:events:read"],
    registeredKeyIds: ["key_1"],
    authorizedBy: "ada@example.com",
    actorKind: "dashboard",
    purpose: "The hosted dashboard.",
  };

  test("a registration, an update and a removal, with the scopes before and after", async () => {
    await seed(lifecycle("controlplane/connection_registered", REGISTERED), 1);
    await seed(
      lifecycle("controlplane/connection_updated", {
        changed: ["scopes", "purpose"],
        scopesBefore: ["audit:events:read", "manifest:read"],
        scopesAfter: ["manifest:read"],
        authorizedBy: "ada@example.com",
        actorKind: "dashboard",
        scopes: { from: ["audit:events:read", "manifest:read"], to: ["manifest:read"] },
        purpose: { from: "The hosted dashboard.", to: "Read-only dashboard." },
      }),
      2,
    );
    await seed(
      lifecycle("controlplane/connection_removed", {
        issuer: "https://app.pithy.sh",
        workerUrl: "https://api.example.com",
        basePath: "/control-plane",
        scopes: ["manifest:read"],
        removedKeyIds: ["key_1"],
        authorizedBy: "ada@example.com",
        actorKind: "dashboard",
        purpose: "Read-only dashboard.",
      }),
      3,
    );

    const { changes } = await accessHistory(db(), ALL_TIME);

    expect(
      changes.map((change) => [
        change.subject,
        change.action,
        change.scopesBefore,
        change.scopesAfter,
        change.purpose,
        change.recorded,
      ]),
    ).toEqual([
      [
        "connection",
        "controlplane/connection_registered",
        null,
        ["manifest:read", "audit:events:read"],
        "The hosted dashboard.",
        true,
      ],
      [
        "connection",
        "controlplane/connection_updated",
        ["audit:events:read", "manifest:read"],
        ["manifest:read"],
        "Read-only dashboard.",
        true,
      ],
      ["connection", "controlplane/connection_removed", ["manifest:read"], null, "Read-only dashboard.", true],
    ]);
    expect(changes[0]).toMatchObject({
      connectionId: CONNECTION,
      connectionKind: "dashboard",
      principal: "ada@example.com",
      organizationId: null,
      membershipId: null,
      keyId: null,
    });
  });

  test("an older update reads its grant from the change set, and one that moved no scope is not recorded", async () => {
    // Before #831 an update said only what moved, so the scopes are known only where they moved.
    await seed(
      lifecycle("controlplane/connection_updated", {
        changed: ["scopes"],
        scopes: { from: ["a:b:read"], to: ["a:b:read", "c:d:read"] },
      }),
      1,
    );
    await seed(
      lifecycle("controlplane/connection_updated", {
        changed: ["purpose"],
        purpose: { from: null, to: "The hosted dashboard." },
      }),
      2,
    );

    const { changes } = await accessHistory(db(), ALL_TIME);

    expect(changes.map((change) => [change.scopesBefore, change.scopesAfter, change.purpose, change.recorded])).toEqual(
      [
        [["a:b:read"], ["a:b:read", "c:d:read"], null, true],
        [null, null, "The hosted dashboard.", false],
      ],
    );
  });
});

describe("a connection started over", () => {
  const REPLACEMENT = "9a0b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d";
  const REGISTRATION = {
    issuer: "https://app.pithy.sh",
    workerUrl: "https://api.example.com",
    basePath: "/control-plane",
    scopes: ["audit:events:read"],
    registeredKeyIds: ["key_9"],
    authorizedBy: "ada@example.com",
    actorKind: "dashboard",
    purpose: "The hosted dashboard.",
  };

  test("the replaced connection ends, with what it held, and the registration names it", async () => {
    // As `connectionRegistry.save` writes a start-over from #831 on: the old connection's removal, then the new one.
    await seed(
      lifecycle("controlplane/connection_removed", {
        ...REGISTRATION,
        scopes: ["organization:members:write"],
        removedKeyIds: ["key_1"],
        replacedByConnectionId: REPLACEMENT,
      }),
      1,
    );
    await seed(
      {
        ...lifecycle("controlplane/connection_registered", { ...REGISTRATION, replacedConnectionId: CONNECTION }),
        resourceId: REPLACEMENT,
        metadata: { connectionId: REPLACEMENT, ...REGISTRATION, replacedConnectionId: CONNECTION },
      },
      2,
    );

    const { changes } = await accessHistory(db(), ALL_TIME);

    expect(
      changes.map((change) => [
        change.action,
        change.connectionId,
        change.scopesBefore,
        change.scopesAfter,
        change.replacedConnectionId,
      ]),
    ).toEqual([
      ["controlplane/connection_removed", CONNECTION, ["organization:members:write"], null, null],
      ["controlplane/connection_registered", REPLACEMENT, null, ["audit:events:read"], CONNECTION],
    ]);
  });

  test("an older start-over, recorded as the registration alone, still names the connection it ended", async () => {
    await seed(
      {
        ...lifecycle("controlplane/connection_registered", REGISTRATION),
        resourceId: REPLACEMENT,
        metadata: { connectionId: REPLACEMENT, ...REGISTRATION, replacedConnectionId: CONNECTION },
      },
      1,
    );

    const { changes } = await accessHistory(db(), ALL_TIME);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      subject: "connection",
      connectionId: REPLACEMENT,
      replacedConnectionId: CONNECTION,
      recorded: true,
    });
  });

  test("only a registration names a connection it replaced", async () => {
    await seed(lifecycle("controlplane/connection_registered", REGISTRATION), 1);
    await seed(memberAct("organization/member_joined", "mem_a", { role: "member" }), 2);
    await seed(keyEvent("controlplane/key_registered", { registeredKeyId: "key_2" }), 3);

    const { changes } = await accessHistory(db(), ALL_TIME);

    expect(changes.map((change) => change.replacedConnectionId)).toEqual([null, null, null]);
  });
});

describe("key changes", () => {
  test("a key registered and expired at the seam, and one registered and revoked from the CLI", async () => {
    await seed(keyEvent("controlplane/key_registered", { registeredKeyId: "key_2", signedWithKeyId: "key_1" }), 1);
    await seed(keyEvent("controlplane/key_expired", { expiredKeyId: "key_1", provenKeyId: "key_2" }), 2);
    await seed(
      lifecycle("controlplane/connection_updated", { changed: ["keys"], registeredKeyId: "key_3", keyIds: ["key_3"] }),
      3,
    );
    await seed(
      lifecycle("controlplane/connection_updated", { changed: ["keys"], revokedKeyId: "key_2", liveKeyIdsAfter: [] }),
      4,
    );

    const { changes } = await accessHistory(db(), ALL_TIME);

    expect(changes.map((change) => [change.subject, change.keyId, change.keyChange, change.recorded])).toEqual([
      ["key", "key_2", "registered", true],
      ["key", "key_1", "expired", true],
      ["key", "key_3", "registered", true],
      ["key", "key_2", "revoked", true],
    ]);
    expect(changes.every((change) => change.connectionId === CONNECTION)).toBe(true);
    expect(changes[0]).toMatchObject({ actorType: "control-plane", actorKind: "dashboard", scopesBefore: null });
  });
});

describe("what is read, and what is not", () => {
  test("the window is inclusive, and only successful access changes are in it", async () => {
    await seed(memberAct("organization/member_joined", "mem_a", { role: "member" }), 999);
    await seed(memberAct("organization/member_joined", "mem_b", { role: "member" }), 1_000);
    await seed(memberAct("organization/member_joined", "mem_c", { role: "member" }), 2_000);
    await seed(memberAct("organization/member_joined", "mem_d", { role: "member" }), 2_001);
    // Not access changes: an invitation, a refusal, a call the gate allowed, and a renamed account.
    await seed(memberAct("organization/member_invited", "inv_1", { role: "admin" }), 1_500);
    await seed(
      { ...memberAct("organization/member_role_changed", "mem_b", { role: "admin" }), outcome: "denied" },
      1_500,
    );
    await seed(keyEvent("controlplane/call_allowed", { scope: "manifest:read", keyId: "key_1" }), 1_500);
    await seed(memberAct("organization/renamed", ACME, { name: "Acme" }), 1_500);

    const { changes } = await accessHistory(db(), { since: new Date(1_000), until: new Date(2_000) });

    expect(changes.map((change) => change.membershipId)).toEqual(["mem_b", "mem_c"]);
  });

  test("no row carries an IP, a user-agent, or a metadata key beyond those named", async () => {
    await seed(
      operatorAct("organization/admin_member_removed", "mem_bob", {
        role: "owner",
        subjectUserId: "user_bob",
        mailed: "queued",
        factsRejected: ["email"],
      }),
      1,
    );
    await seed(
      lifecycle("controlplane/connection_registered", {
        issuer: "https://issuer.example",
        workerUrl: "https://secret-worker.example",
        basePath: "/control-plane",
        scopes: ["manifest:read"],
        registeredKeyIds: ["key_hidden"],
        authorizedBy: "ada@example.com",
        actorKind: "agent",
        purpose: "Triage.",
      }),
      2,
    );
    await seed(keyEvent("controlplane/key_registered", { registeredKeyId: "key_2", signedWithKeyId: "key_signer" }), 3);

    const { changes } = await accessHistory(db(), ALL_TIME);
    const wire = JSON.stringify(changes);

    expect(changes).toHaveLength(3);
    for (const leaked of [
      IP,
      UA,
      "Ticket 4411",
      "queued",
      "factsRejected",
      "https://issuer.example",
      "https://secret-worker.example",
      "key_hidden",
      "key_signer",
      "session_1",
      "prod",
    ]) {
      expect(wire, leaked).not.toContain(leaked);
    }
  });

  test("the statement lifts only the named metadata keys, and never the network columns", () => {
    const { sql } = accessHistoryStatement(db(), ALL_TIME, { limit: 10 }).compile();
    const paths = new Set([...sql.matchAll(/'\$\.([A-Za-z.]+)'/g)].map((match) => match[1]?.split(".")[0]));

    expect([...paths].sort()).toEqual([...ACCESS_HISTORY_METADATA_KEYS].sort());
    expect(sql).not.toMatch(/"ip"|"user_agent"|"session_id"|"request_id"/);
  });
});

describe("paging", () => {
  /** Ten thousand rows, three in four of them role changes. Seeded in SQL: recorder calls would test the recorder. */
  async function tenThousandEvents(): Promise<void> {
    await env.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 10000)
       insert into pithy_audit_events
         (event_id, occurred_at, action, outcome, severity, actor_type, actor_id, tenant, resource_type, resource_id, metadata)
       select 'evt-' || i, i, case i % 4 when 0 then 'controlplane/call_allowed' else 'organization/member_role_changed' end,
         'success', 'info', 'user', 'user_ada', ?, 'membership', 'mem_' || i, ?
       from n`,
    )
      .bind(ACME, JSON.stringify({ role: "member", previousRole: "admin", subjectUserId: "user_bob" }))
      .run();
  }
  test("pages oldest first, resuming exactly where the last page ended, ties broken by id", async () => {
    for (const [index, at] of [1_000, 1_000, 1_000, 2_000, 3_000].entries()) {
      await seed(memberAct("organization/member_joined", `mem_${index}`, { role: "member" }), at);
    }

    const first = await accessHistory(db(), { ...ALL_TIME, limit: 2 });
    const second = await accessHistory(db(), { ...ALL_TIME, limit: 2, cursor: first.nextCursor ?? undefined });
    const third = await accessHistory(db(), { ...ALL_TIME, limit: 2, cursor: second.nextCursor ?? undefined });

    expect([...first.changes, ...second.changes, ...third.changes].map((change) => change.membershipId)).toEqual([
      "mem_0",
      "mem_1",
      "mem_2",
      "mem_3",
      "mem_4",
    ]);
    expect(third.nextCursor).toBeNull();
  });

  test("a malformed cursor is a first page", async () => {
    await seed(memberAct("organization/member_joined", "mem_a", { role: "member" }), 1);
    const { changes } = await accessHistory(db(), { ...ALL_TIME, cursor: "not-a-cursor" });
    expect(changes.map((change) => change.membershipId)).toEqual(["mem_a"]);
  });

  test("the query plan reads an index, not the whole table", async () => {
    await tenThousandEvents();
    // Fresh statistics, as a long-lived trail has, so the planner chooses on the real distribution.
    await env.DB.prepare("analyze").run();
    const { sql, parameters } = accessHistoryStatement(db(), ALL_TIME, { limit: 100 }).compile();
    const plan = await env.DB.prepare(`explain query plan ${sql}`)
      .bind(...parameters)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);

    expect(
      details.some((detail) => /^SCAN pithy_audit_events\b/.test(detail)),
      details.join("\n"),
    ).toBe(false);
  });

  test("ten thousand events answer a page in one statement", async () => {
    await tenThousandEvents();
    const statements: string[] = [];
    const counted = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            statements.push(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const { changes, nextCursor } = await accessHistory(db(counted as unknown as D1Database), {
      ...ALL_TIME,
      limit: 100,
    });

    expect(statements).toHaveLength(1);
    expect(changes).toHaveLength(100);
    expect(changes[0]).toMatchObject({ occurredAt: new Date(1), roleBefore: "admin", roleAfter: "member" });
    expect(nextCursor).not.toBeNull();
  });
});
