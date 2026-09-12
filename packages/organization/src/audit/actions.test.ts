// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AuditAction, type AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { describe, expect, test } from "vitest";
import { ORGANIZATION_AUDIT_DOMAIN, OrganizationAuditActions } from "./actions";
import { correlation, recordOrganizationAction } from "./emit";

/**
 * The register and its one writer.
 *
 * `./emit.ts` is tested here rather than beside itself because the two are one contract: a code nothing
 * emits is a code nobody wrote, and an emitter that could write a code the register does not hold would
 * make the register a suggestion. Splitting them would let each file pass while the pair was wrong.
 *
 * Everything below attacks the emitter rather than reading it. The rules it exists to hold — the tenant
 * is stamped from the resolved actor, an address never lands in a row, a failed write never breaks the
 * act it records — are each a way this capability leaks or breaks if it is wrong, so each one gets a
 * hostile input rather than a happy path.
 */

const ACTOR = { organizationId: "org-1", userId: "user-ada" } as const;
const RESOURCE = { type: "membership", id: "m-1" } as const;

/** An emit seam that keeps what it is handed. */
function collecting(): { emit: AuditEmit; written: AuditEventInput[] } {
  const written: AuditEventInput[] = [];
  return {
    emit: async (event) => {
      written.push(event);
    },
    written,
  };
}

describe("OrganizationAuditActions", () => {
  const codes = Object.values(OrganizationAuditActions);

  test("every code is a valid federated action in this capability's own domain", () => {
    // Core's taxonomy is open and namespace-validated, which is what lets a capability add codes without
    // touching core. The whole of what makes that safe is that nothing here writes outside its namespace.
    for (const code of codes) {
      expect(AuditAction.safeParse(code).success, code).toBe(true);
      expect(code.startsWith(`${ORGANIZATION_AUDIT_DOMAIN}/`), code).toBe(true);
    }
  });

  test("no two acts share a code", () => {
    // Two acts under one code is a trail that answers "was this person removed, or did they leave" with a
    // shrug — which is the question a removal makes somebody want to read.
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("every administrative act this capability can take has a code", () => {
    // Pinned as a list rather than as a count, so adding a route without a code fails here by name. The
    // codes themselves are stable forever once a row holds one: a renamed code orphans every event already
    // written under the old one, and nothing in this package can repair that.
    expect([...codes].sort()).toEqual([
      "organization/created",
      "organization/deleted",
      "organization/invitation_resent",
      "organization/invitation_revoked",
      "organization/logo_changed",
      "organization/member_invited",
      "organization/member_joined",
      "organization/member_left",
      "organization/member_removed",
      "organization/member_role_changed",
      "organization/ownership_accepted",
      "organization/ownership_nominated",
      "organization/ownership_withdrawn",
      "organization/renamed",
    ]);
  });
});

describe("recordOrganizationAction", () => {
  test("the tenant is the actor's organization, and the actor is its user", async () => {
    const { emit, written } = collecting();
    await recordOrganizationAction(emit, {
      action: OrganizationAuditActions.memberRemoved,
      actor: ACTOR,
      resource: RESOURCE,
      sessionId: "sess-9",
    });

    const event = written[0];
    // The tenant is stamped at write time because the tenant of an action is a fact *then*, while
    // membership is a fact *now*. Derived later, a year of history moves between accounts every time
    // somebody joins or leaves.
    expect(event?.tenant).toBe("org-1");
    expect(event?.actorId).toBe("user-ada");
    expect(event?.actorType).toBe("user");
    expect(event?.sessionId).toBe("sess-9");
    expect(event?.resourceType).toBe("membership");
    expect(event?.resourceId).toBe("m-1");
    expect(event?.outcome).toBe("success");
  });

  test("the actor and the tenant arrive as one object, so they cannot be transposed", () => {
    // A type-level assertion with a runtime home: the emitter takes no actor id beside an organization id,
    // so there is no call shape that records one person's action inside another person's account. Two
    // adjacent string arguments are two a hand can transpose, and transposed they typecheck.
    // @ts-expect-error — an actor without an organization is not an actor this emitter accepts.
    const orphan: Parameters<typeof recordOrganizationAction>[1]["actor"] = { userId: "user-ada" };
    expect(orphan).toBeDefined();
  });

  test("a refusal is recorded, because a refusal is what an intrusion looks like from inside the trail", async () => {
    const { emit, written } = collecting();
    await recordOrganizationAction(emit, {
      action: OrganizationAuditActions.memberRemoved,
      actor: ACTOR,
      resource: RESOURCE,
      outcome: "denied",
      severity: "warning",
    });
    expect(written[0]?.outcome).toBe("denied");
    expect(written[0]?.severity).toBe("warning");
  });

  test("an address-shaped fact is dropped by name, and the address reaches no part of the row", async () => {
    const { emit, written } = collecting();
    await recordOrganizationAction(emit, {
      action: OrganizationAuditActions.memberInvited,
      actor: ACTOR,
      resource: { type: "invitation", id: "inv-1" },
      facts: { email: "ada@example.com", role: "member", seats: 4 },
    });

    const event = written[0];
    // The names of what was refused, so a caller's mistake is visible in the row instead of being a silent
    // disclosure — and the facts beside it survive, because one refused field must not drop the ten next to
    // it.
    expect(event?.metadata).toEqual({ role: "member", seats: 4, factsRejected: ["email"] });
    expect(JSON.stringify(event)).not.toContain("ada@example.com");
  });

  test("a container is refused whatever it holds, because a container is how a row reaches the trail", async () => {
    const { emit, written } = collecting();
    await recordOrganizationAction(emit, {
      action: OrganizationAuditActions.memberRoleChanged,
      actor: ACTOR,
      resource: RESOURCE,
      facts: {
        // The realistic way content creeps in: never by somebody deciding to store a person's row, always
        // by a field that carried one.
        person: { email: "bo@example.com", name: "Bo" },
        addresses: ["ada@example.com"],
        note: "x".repeat(201),
        from: "member",
        to: "admin",
      },
    });

    const event = written[0];
    expect(event?.metadata).toEqual({
      from: "member",
      to: "admin",
      factsRejected: ["person", "addresses", "note"],
    });
    const rendered = JSON.stringify(event);
    for (const leaked of ["bo@example.com", "ada@example.com", "xxxxx"]) {
      expect(rendered).not.toContain(leaked);
    }
  });

  test("facts are optional, and no facts means no metadata rather than an empty object", async () => {
    const { emit, written } = collecting();
    await recordOrganizationAction(emit, {
      action: OrganizationAuditActions.deleted,
      actor: ACTOR,
      resource: { type: "organization", id: "org-1" },
    });
    expect(written[0]?.metadata).toBeUndefined();
  });

  test("a recorder that throws does not break the act it was recording", async () => {
    // Non-fatal by contract, and non-fatal again on top of it — because a recorder an adopter composed
    // themselves is not bound by a contract this package wrote. By the time an event is recorded the thing
    // it records has already happened, and retrying a completed removal removes one person twice and a
    // second one not at all.
    const exploding: AuditEmit = async () => {
      throw new Error("the audit database is on fire");
    };
    await expect(
      recordOrganizationAction(exploding, {
        action: OrganizationAuditActions.memberLeft,
        actor: ACTOR,
        resource: RESOURCE,
      }),
    ).resolves.toBeUndefined();
  });

  test("a recorder that rejects asynchronously is swallowed too", async () => {
    const rejecting: AuditEmit = () => Promise.reject(new Error("dropped"));
    await expect(
      recordOrganizationAction(rejecting, {
        action: OrganizationAuditActions.created,
        actor: ACTOR,
        resource: { type: "organization", id: "org-1" },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("correlation", () => {
  test("carries the IP and the user-agent, and nothing else off the request", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.7",
      "user-agent": "Mozilla/5.0",
      cookie: "session=secret-token",
      authorization: "Bearer secret-token",
    });
    const correlated = correlation(headers);
    expect(correlated).toEqual({ ip: "203.0.113.7", userAgent: "Mozilla/5.0" });
    expect(JSON.stringify(correlated)).not.toContain("secret-token");
  });

  test("absent headers are absent fields, never empty strings", () => {
    expect(correlation(undefined)).toEqual({ ip: undefined, userAgent: undefined });
  });
});
