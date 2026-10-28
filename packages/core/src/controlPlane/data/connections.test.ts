// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { fixtureConnection, fixtureKey, fixtureTrust, FIXTURE_NOW as NOW } from "../../test-utils/connectionFixtures";
import {
  authorizedByPrincipal,
  connectionCredentialKind,
  connectionLive,
  connectionRevokedAt,
  revokeCredentials,
} from "./connections";

const EARLIER = new Date("2026-10-20T00:00:00.000Z");
const LATER = new Date("2026-10-25T00:00:00.000Z");
const LATER_THAN_NOW = new Date("2026-10-27T12:02:00.000Z");

describe("connectionCredentialKind", () => {
  test("names the kinds held, live or not", () => {
    expect(connectionCredentialKind(fixtureConnection())).toBe("key");
    expect(connectionCredentialKind(fixtureConnection({ keys: [], trusts: [fixtureTrust("t")] }))).toBe("trust");
    expect(connectionCredentialKind(fixtureConnection({ trusts: [fixtureTrust("t", { revokedAt: EARLIER })] }))).toBe(
      "both",
    );
    expect(connectionCredentialKind(fixtureConnection({ keys: [], trusts: undefined }))).toBe("none");
  });
});

describe("connectionLive and connectionRevokedAt", () => {
  test("a connection with a live credential is live and not revoked", () => {
    const connection = fixtureConnection({ keys: [fixtureKey("k1", { revokedAt: EARLIER }), fixtureKey("k2")] });
    expect(connectionLive(connection, NOW)).toBe(true);
    expect(connectionRevokedAt(connection, NOW)).toBeNull();
  });

  test("a connection whose every credential was revoked was revoked at the latest of them", () => {
    const connection = fixtureConnection({
      keys: [fixtureKey("k1", { revokedAt: EARLIER })],
      trusts: [fixtureTrust("t", { revokedAt: LATER })],
    });
    expect(connectionLive(connection, NOW)).toBe(false);
    expect(connectionRevokedAt(connection, NOW)).toEqual(LATER);
  });

  test("a connection whose keys merely expired is not live and was never revoked", () => {
    const connection = fixtureConnection({ keys: [fixtureKey("k1", { validUntil: EARLIER })] });
    expect(connectionLive(connection, NOW)).toBe(false);
    expect(connectionRevokedAt(connection, NOW)).toBeNull();
  });

  test("a connection holding nothing was never revoked", () => {
    expect(connectionRevokedAt(fixtureConnection({ keys: [] }), NOW)).toBeNull();
  });
});

describe("revokeCredentials", () => {
  test("revokes every key and trust not yet revoked, live, expired or not started, and keeps a revoked one's instant", () => {
    const expired = fixtureKey("old", { validUntil: EARLIER });
    const pending = fixtureKey("next", { validFrom: LATER_THAN_NOW });
    const pendingTrust = fixtureTrust("soon", { validFrom: LATER_THAN_NOW });
    const revoked = fixtureTrust("gone", { revokedAt: EARLIER });
    const result = revokeCredentials(
      fixtureConnection({
        keys: [fixtureKey("k1"), expired, pending],
        trusts: [fixtureTrust("t"), pendingTrust, revoked],
      }),
      NOW,
    );
    expect(result.revokedKeyIds).toEqual(["k1", "old", "next"]);
    expect(result.revokedTrustIds).toEqual(["t", "soon"]);
    expect(result.connection.keys).toEqual([
      fixtureKey("k1", { revokedAt: NOW }),
      { ...expired, revokedAt: NOW },
      { ...pending, revokedAt: NOW },
    ]);
    expect(result.connection.trusts).toEqual([
      fixtureTrust("t", { revokedAt: NOW }),
      { ...pendingTrust, revokedAt: NOW },
      revoked,
    ]);
    expect(result.connection.updatedAt).toEqual(NOW);
    expect(connectionLive(result.connection, LATER_THAN_NOW)).toBe(false);
    expect(connectionRevokedAt(result.connection, NOW)).toEqual(NOW);
  });

  test("a key or trust that has not started yet is revoked, so it never verifies once its window opens", () => {
    const connection = fixtureConnection({
      keys: [fixtureKey("next", { validFrom: LATER_THAN_NOW })],
      trusts: [fixtureTrust("soon", { validFrom: LATER_THAN_NOW })],
    });
    expect(connectionLive(connection, NOW)).toBe(false);
    const result = revokeCredentials(connection, NOW);
    expect(result.revokedKeyIds).toEqual(["next"]);
    expect(result.revokedTrustIds).toEqual(["soon"]);
    expect(connectionLive(result.connection, LATER_THAN_NOW)).toBe(false);
  });

  test("changes nothing on a connection whose every credential is already revoked", () => {
    const connection = fixtureConnection({ keys: [fixtureKey("k1", { revokedAt: EARLIER })] });
    const result = revokeCredentials(connection, NOW);
    expect(result.revokedKeyIds).toEqual([]);
    expect(result.connection).toEqual(connection);
  });
});

describe("authorizedByPrincipal", () => {
  test("matches the recorded email without regard to case", () => {
    expect(authorizedByPrincipal(fixtureConnection(), "Ada@Example.com")).toBe(true);
    expect(authorizedByPrincipal(fixtureConnection(), "grace@example.com")).toBe(false);
  });

  test("never matches a connection with no recorded principal", () => {
    expect(authorizedByPrincipal(fixtureConnection({ authorizedBy: null }), "ada@example.com")).toBe(false);
  });
});
