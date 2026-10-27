// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { describe, expect, test } from "vitest";
import { ArtifactsAuditActions, recordArtifactsAction } from "./actions";

describe("recordArtifactsAction", () => {
  test("records the act against the repository, its tenant and its actor", async () => {
    const events: AuditEventInput[] = [];
    await recordArtifactsAction(async (event) => void events.push(event), {
      action: ArtifactsAuditActions.grantSet,
      actorId: "alice",
      repo: "r1",
      tenant: "acme",
      facts: { userId: "bob", grant: "write" },
    });
    expect(events).toEqual([
      {
        action: "artifacts/grant_set",
        outcome: "success",
        severity: "info",
        actorType: "user",
        actorId: "alice",
        resourceType: "artifacts_repo",
        resourceId: "r1",
        tenant: "acme",
        metadata: { userId: "bob", grant: "write" },
      },
    ]);
  });

  test("never writes a token, even one handed to it as a fact", async () => {
    const events: AuditEventInput[] = [];
    await recordArtifactsAction(async (event) => void events.push(event), {
      action: ArtifactsAuditActions.tokenMinted,
      actorId: "alice",
      repo: "r1",
      tenant: null,
      facts: { tokenId: "tok_1", leaked: `art_v1_${"a".repeat(40)}?expires=1`, scope: "read" },
    });
    expect(JSON.stringify(events)).not.toContain("art_v1_");
    expect(events[0]?.metadata).toEqual({ tokenId: "tok_1", scope: "read" });
  });

  test("records a management client's act as the control plane's, at warning", async () => {
    const events: AuditEventInput[] = [];
    await recordArtifactsAction(async (event) => void events.push(event), {
      action: ArtifactsAuditActions.tokenRevoked,
      actorType: "control-plane",
      actorId: "operator-1",
      repo: "r1",
      tenant: null,
      facts: { reason: "Left.", tokenId: "tok_1" },
    });
    expect(events[0]).toMatchObject({ actorType: "control-plane", actorId: "operator-1", severity: "warning" });
  });

  test("every code sits in the artifacts domain", () => {
    for (const code of Object.values(ArtifactsAuditActions)) expect(code.startsWith("artifacts/")).toBe(true);
  });
});
