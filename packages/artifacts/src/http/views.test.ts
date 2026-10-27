// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { ArtifactsRepoMetadata, ArtifactsTokenMetadata } from "../binding/artifacts";
import { type ArtifactsRepoRecord, type ArtifactsTokenRecord, TOKEN_RECORD_RETENTION_MS } from "../data/records";
import { AdminRepoDetail, AdminRepoView, AdminRevocation, AdminTokenView } from "./responses";
import { adminRepoDetailView, adminRepoView, adminTokenView, revocationView } from "./views";

const NOW = new Date("2026-10-26T12:00:00.000Z");
/** When this database began recording tokens: migration 0002, a day before NOW. */
const BEGAN = new Date("2026-10-25T12:00:00.000Z");

const repo = (overrides: Partial<ArtifactsRepoRecord> = {}): ArtifactsRepoRecord => ({
  name: "r1",
  displayName: "docs",
  ownerKind: "user",
  ownerId: "alice",
  remoteAccess: true,
  createdAt: new Date("2026-10-20T00:00:00.000Z"),
  updatedAt: new Date("2026-10-21T00:00:00.000Z"),
  ...overrides,
});

const info: ArtifactsRepoMetadata = {
  id: "id-r1",
  name: "r1",
  description: "Docs.",
  defaultBranch: "main",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  lastPushAt: "2026-10-22T00:00:00.000Z",
  source: null,
  readOnly: false,
  remote: "https://acct.artifacts.cloudflare.net/git/acme-prod/r1.git",
};

describe("adminRepoView", () => {
  test("carries the last push Cloudflare answered", () => {
    const view = adminRepoView(repo(), info);
    expect(AdminRepoView.parse(view)).toEqual(view);
    expect(view).toEqual({
      name: "r1",
      displayName: "docs",
      owner: { kind: "user", id: "alice" },
      remoteAccess: true,
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
      lastPushAt: "2026-10-22T00:00:00.000Z",
    });
  });

  test("leaves the last push out, rather than inventing one, when Cloudflare could not answer", () => {
    const view = adminRepoView(repo(), undefined);
    expect(AdminRepoView.parse(view)).toEqual(view);
    expect(view).not.toHaveProperty("lastPushAt");
  });

  test("never carries the clone URL", () => {
    expect(adminRepoView(repo(), info)).not.toHaveProperty("remote");
  });
});

describe("adminRepoDetailView", () => {
  test("projects the clone URL where remote access is on", () => {
    const view = adminRepoDetailView(repo(), info);
    expect(AdminRepoDetail.shape.repo.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      description: "Docs.",
      defaultBranch: "main",
      lastPushAt: "2026-10-22T00:00:00.000Z",
      readOnly: false,
      remote: info.remote,
    });
  });

  test("never projects the clone URL of a repository with remote access off", () => {
    const view = adminRepoDetailView(repo({ remoteAccess: false }), info);
    expect(AdminRepoDetail.shape.repo.parse(view)).toEqual(view);
    expect(view.remoteAccess).toBe(false);
    expect(view).not.toHaveProperty("remote");
    expect(JSON.stringify(view)).not.toContain(info.remote);
  });
});

const listed = (overrides: Partial<ArtifactsTokenMetadata> = {}): ArtifactsTokenMetadata => ({
  id: "tok_1",
  scope: "write",
  state: "active",
  createdAt: "2026-10-26T11:50:00.000Z",
  expiresAt: "2026-10-26T12:05:00.000Z",
  ...overrides,
});

const record: ArtifactsTokenRecord = {
  id: "tok_1",
  repo: "r1",
  userId: "bob",
  scope: "write",
  source: "credential",
  createdAt: new Date("2026-10-26T11:50:00.000Z"),
  expiresAt: new Date("2026-10-26T12:05:00.000Z"),
};

describe("adminTokenView", () => {
  test("a token the kit recorded is the kit's, and names its holder", () => {
    const view = adminTokenView(listed(), record, NOW, BEGAN);
    expect(AdminTokenView.parse(view)).toEqual(view);
    expect(view).toEqual({
      id: "tok_1",
      scope: "write",
      state: "active",
      createdAt: "2026-10-26T11:50:00.000Z",
      expiresAt: "2026-10-26T12:05:00.000Z",
      minted: "pithy",
      holderId: "bob",
      source: "credential",
    });
  });

  test("a token with no record is minted outside Pithy, and never given a holder", () => {
    expect(adminTokenView(listed(), undefined, NOW, BEGAN)).toMatchObject({
      minted: "outside",
      holderId: null,
      source: null,
    });
  });

  test("an unrecorded token that expired before records were kept is unknown, at the boundary exactly", () => {
    const cutoff = NOW.getTime() - TOKEN_RECORD_RETENTION_MS;
    const at = (ms: number) => listed({ state: "expired", expiresAt: new Date(ms).toISOString() });
    // Recording began long before, so only the retention window can make a missing record unknown.
    const longAgo = new Date(cutoff - 86_400_000);
    expect(adminTokenView(at(cutoff - 1), undefined, NOW, longAgo).minted).toBe("unknown");
    expect(adminTokenView(at(cutoff), undefined, NOW, longAgo).minted).toBe("outside");
  });

  test("a record for another token never lends its holder", () => {
    expect(adminTokenView(listed({ id: "tok_2" }), record, NOW, BEGAN)).toMatchObject({
      minted: "outside",
      holderId: null,
    });
  });

  test("an unrecorded token created before the kit began recording is unknown, never outside", () => {
    // The kit minted tokens before 0002_tokens and wrote no record of them: the create token of every existing
    // repository among them. Claiming those were minted outside Pithy is the false alarm.
    const before = listed({ createdAt: new Date(BEGAN.getTime() - 1).toISOString(), state: "revoked" });
    expect(adminTokenView(before, undefined, NOW, BEGAN)).toMatchObject({
      minted: "unknown",
      holderId: null,
      source: null,
    });
    const at = listed({ createdAt: BEGAN.toISOString() });
    expect(adminTokenView(at, undefined, NOW, BEGAN).minted).toBe("outside");
  });

  test("with no record of when recording began, an unrecorded token is unknown", () => {
    expect(adminTokenView(listed(), undefined, NOW, undefined).minted).toBe("unknown");
  });
});

describe("revocationView", () => {
  test("projects the record, and says whether this call replayed it", () => {
    const view = revocationView(
      {
        connectionId: "c1",
        idempotencyKey: "k1",
        kind: "token",
        repo: "r1",
        tokenId: "tok_1",
        reason: "Left.",
        revoked: 1,
        createdAt: NOW,
      },
      true,
    );
    expect(AdminRevocation.parse(view)).toEqual(view);
    expect(view).toEqual({
      repo: "r1",
      tokenId: "tok_1",
      revoked: 1,
      reason: "Left.",
      revokedAt: NOW.toISOString(),
      replayed: true,
    });
  });
});
