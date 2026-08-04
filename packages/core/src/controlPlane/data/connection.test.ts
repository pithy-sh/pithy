// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { ControlPlaneConnection, Ed25519PublicJwk, type RegisteredKey } from "./connection";

/**
 * The connection row is the seam's trust anchor, and two of its columns are JSON. SQLite cannot
 * `CHECK` inside a JSON string, so Zod is the only gate standing between a hand-edited row and the
 * verification path — these tests are that gate's proof, not a formality.
 */

const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");
const UPDATED_AT = new Date("2026-02-01T09:30:00.000Z");
const VALID_FROM = new Date("2026-01-01T00:00:00.000Z");

const key: RegisteredKey = {
  keyId: "cpk_01HQ",
  publicKey: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
  validFrom: VALID_FROM,
  validUntil: null,
  revokedAt: null,
};

const connection: ControlPlaneConnection = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  environment: "production",
  issuer: "https://app.pithy.sh",
  workerUrl: "https://api.example.com",
  basePath: "/control-plane",
  scopes: ["manifest:read", "keys:rotate"],
  keys: [key],
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

describe("ControlPlaneConnection codec round-trip", () => {
  it("encodes to the row SQLite actually stores — ms-epoch dates, JSON strings for scopes and keys", () => {
    const row = ControlPlaneConnection.encode(connection);

    expect(row.createdAt).toBe(CREATED_AT.getTime());
    expect(row.updatedAt).toBe(UPDATED_AT.getTime());
    expect(row.scopes).toBe('["manifest:read","keys:rotate"]');
    expect(typeof row.keys).toBe("string");
    expect(row.id).toBe(connection.id);
  });

  it("writes nested dates as ISO strings inside the keys JSON, since JSON has no date type", () => {
    const row = ControlPlaneConnection.encode(connection);
    expect(JSON.parse(String(row.keys))).toEqual([
      {
        keyId: "cpk_01HQ",
        publicKey: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
        validFrom: VALID_FROM.toISOString(),
        validUntil: null,
        revokedAt: null,
      },
    ]);
  });

  it("decodes a stored row back to Dates and arrays", () => {
    expect(ControlPlaneConnection.parse(ControlPlaneConnection.encode(connection))).toEqual(connection);
  });

  it("round-trips a connection mid-rotation — an expired key, a revoked one, and a live one", () => {
    const rotating: ControlPlaneConnection = {
      ...connection,
      keys: [
        { ...key, keyId: "cpk_old", validUntil: new Date("2026-01-15T00:00:00.000Z") },
        { ...key, keyId: "cpk_burned", revokedAt: new Date("2026-01-20T00:00:00.000Z") },
        { ...key, keyId: "cpk_new", validFrom: new Date("2026-01-14T00:00:00.000Z") },
      ],
    };
    expect(ControlPlaneConnection.parse(ControlPlaneConnection.encode(rotating))).toEqual(rotating);
  });

  it("round-trips a connection granted nothing — an empty scope array is a real state, not a missing one", () => {
    const unscoped: ControlPlaneConnection = { ...connection, scopes: [] };
    const row = ControlPlaneConnection.encode(unscoped);
    expect(row.scopes).toBe("[]");
    expect(ControlPlaneConnection.parse(row)).toEqual(unscoped);
  });
});

describe("the JSON columns are gated by Zod, because SQLite cannot CHECK inside a string", () => {
  const row = ControlPlaneConnection.encode(connection);

  it("rejects a malformed scope smuggled into the scopes JSON", () => {
    expect(ControlPlaneConnection.safeParse({ ...row, scopes: '["Manifest:Read"]' }).success).toBe(false);
    expect(ControlPlaneConnection.safeParse({ ...row, scopes: '["*"]' }).success).toBe(false);
    expect(ControlPlaneConnection.safeParse({ ...row, scopes: '["manifest:"]' }).success).toBe(false);
  });

  it("stores no single-segment scope, so a non-grantable requirement cannot masquerade as a grant", () => {
    // Every scope names an operation as `resource:action`. `ping` is not one of them — it is a
    // requirement no adopter grants (see ANY_VERIFIED_CALLER), and a row claiming it does not parse.
    expect(ControlPlaneConnection.safeParse({ ...row, scopes: '["ping"]' }).success).toBe(false);
  });

  it("rejects a key on a weaker curve, so a downgrade cannot be stored and later honoured", () => {
    const downgraded = [{ ...key, publicKey: { kty: "EC", crv: "P-256", x: key.publicKey.x } }];
    expect(ControlPlaneConnection.safeParse({ ...row, keys: JSON.stringify(downgraded) }).success).toBe(false);
    expect(Ed25519PublicJwk.safeParse({ kty: "OKP", crv: "P-256", x: "abc" }).success).toBe(false);
    expect(Ed25519PublicJwk.safeParse({ kty: "OKP", crv: "Ed25519", x: "" }).success).toBe(false);
  });

  it("rejects a key with no id and a connection with a non-UUID id", () => {
    expect(ControlPlaneConnection.safeParse({ ...row, keys: JSON.stringify([{ ...key, keyId: "" }]) }).success).toBe(
      false,
    );
    expect(ControlPlaneConnection.safeParse({ ...row, id: "connection-1" }).success).toBe(false);
  });

  it("rejects a non-URL issuer or workerUrl — both are verified, not merely recorded", () => {
    expect(ControlPlaneConnection.safeParse({ ...row, issuer: "app.pithy.sh" }).success).toBe(false);
    expect(ControlPlaneConnection.safeParse({ ...row, workerUrl: "not a url" }).success).toBe(false);
  });
});
