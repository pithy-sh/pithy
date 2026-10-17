// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  ConnectionPrincipal,
  ConnectionPurpose,
  ControlPlaneActorKind,
  ControlPlaneConnection,
  Ed25519PublicJwk,
  MAX_CONNECTION_PURPOSE,
  type RegisteredKey,
} from "./connection";

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
  managementOrigin: null,
  authorizedBy: "ada@example.com",
  actorKind: "dashboard",
  purpose: "Support triage, reading threads and replying.",
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

  it("rejects a key on a weaker curve, so a downgrade cannot be stored and later honored", () => {
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

/**
 * Who sanctioned a connection, what kind of client it is, and what it is for (#721).
 *
 * The three are on the connection rather than on a key, so they hold for a registered key and for a
 * trust alike. Each is nullable because a row registered before them carries none.
 */
describe("the authorizing principal, the actor kind and the purpose", () => {
  const row = ControlPlaneConnection.encode(connection);

  it("round-trips all three as plain columns", () => {
    expect(row.authorizedBy).toBe("ada@example.com");
    expect(row.actorKind).toBe("dashboard");
    expect(row.purpose).toBe("Support triage, reading threads and replying.");
    expect(ControlPlaneConnection.parse(row)).toEqual(connection);
  });

  it("reads a row registered before them as null, never as a guess", () => {
    const { authorizedBy: _a, actorKind: _k, purpose: _p, ...legacy } = row;
    const parsed = ControlPlaneConnection.parse(legacy);
    expect(parsed.authorizedBy).toBeNull();
    expect(parsed.actorKind).toBeNull();
    expect(parsed.purpose).toBeNull();
  });

  it("names exactly three kinds of client", () => {
    expect(ControlPlaneActorKind.options).toEqual(["agent", "dashboard", "script"]);
    expect(ControlPlaneConnection.safeParse({ ...row, actorKind: "control-plane" }).success).toBe(false);
  });

  it("takes the principal as an email address, the string a signed-in session yields", () => {
    expect(ConnectionPrincipal.safeParse("ada@example.com").success).toBe(true);
    expect(ConnectionPrincipal.safeParse("cfat_token-name").success).toBe(false);
    expect(ConnectionPrincipal.safeParse("").success).toBe(false);
  });
});

/**
 * The purpose is written by a customer and rendered somewhere else — a terminal, a review screen. So it
 * is validated where it comes in, and what cannot be rendered safely does not come in at all.
 */
describe("a purpose is validated at the boundary", () => {
  it("accepts a sentence, and trims it", () => {
    expect(ConnectionPurpose.parse("  Support triage bot, thread reads & replies.  ")).toBe(
      "Support triage bot, thread reads & replies.",
    );
  });

  it("keeps the joiners a script needs to be written at all", () => {
    expect(ConnectionPurpose.safeParse("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645").success).toBe(true);
    expect(ConnectionPurpose.safeParse("\u0915\u094d\u200d\u0937").success).toBe(true);
  });

  it("refuses an empty one, since an empty purpose is a missing one", () => {
    expect(ConnectionPurpose.safeParse("").success).toBe(false);
    expect(ConnectionPurpose.safeParse("   ").success).toBe(false);
  });

  it("refuses one longer than a review line can hold", () => {
    expect(ConnectionPurpose.safeParse("x".repeat(MAX_CONNECTION_PURPOSE)).success).toBe(true);
    expect(ConnectionPurpose.safeParse("x".repeat(MAX_CONNECTION_PURPOSE + 1)).success).toBe(false);
  });

  it.each([
    ["a terminal escape that clears the screen", "triage\u001b[2J"],
    ["an OSC 8 hyperlink", "\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007"],
    ["a newline that forges a second line", "triage\nScopes  everything"],
    ["a carriage return that overwrites the line", "harmless\rkeys:rotate"],
    ["a bidi override that reorders what is read", "triage \u202eetator:syek"],
    ["a bidi isolate", "triage \u2066x\u2069"],
    ["a right-to-left mark", "triage \u200fsyek"],
    ["a left-to-right mark", "triage \u200esyek"],
    ["an Arabic letter mark", "triage \u061csyek"],
    ["a zero-width space that hides a break in a word", "keys\u200b:rotate"],
    ["a byte-order mark inside the text", "keys\ufeff:rotate"],
    ["a word joiner", "keys\u2060:rotate"],
    ["a line separator", "triage\u2028more"],
    ["a NUL", "triage\u0000"],
  ])("refuses %s", (_name, hostile) => {
    expect(ConnectionPurpose.safeParse(hostile).success).toBe(false);
    expect(
      ControlPlaneConnection.safeParse({ ...ControlPlaneConnection.encode(connection), purpose: hostile }).success,
    ).toBe(false);
  });
});
