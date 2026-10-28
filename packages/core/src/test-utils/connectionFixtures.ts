// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneConnection, RegisteredKey } from "../controlPlane/data/connection";
import type { OidcTrust } from "../controlPlane/data/oidcTrust";

/** The instant the connection fixtures are read at. */
export const FIXTURE_NOW = new Date("2026-10-27T12:00:00.000Z");
const REGISTERED = new Date("2026-10-01T00:00:00.000Z");

/** A registered key, live at {@link FIXTURE_NOW} unless overridden. */
export function fixtureKey(keyId: string, overrides: Partial<RegisteredKey> = {}): RegisteredKey {
  return {
    keyId,
    publicKey: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
    validFrom: REGISTERED,
    validUntil: null,
    revokedAt: null,
    ...overrides,
  };
}

/** An OIDC trust, live at {@link FIXTURE_NOW} unless overridden. */
export function fixtureTrust(trustId: string, overrides: Partial<OidcTrust> = {}): OidcTrust {
  return {
    trustId,
    issuer: "https://token.actions.githubusercontent.com",
    jwksUrl: "https://token.actions.githubusercontent.com/.well-known/jwks",
    audience: "https://api.example.com",
    claims: { repository_id: "1262274726" },
    authorizedBy: "ada@example.com",
    validFrom: REGISTERED,
    revokedAt: null,
    firstCallAt: null,
    ...overrides,
  };
}

/** A connection authorized by ada@example.com, holding one live key, unless overridden. */
export function fixtureConnection(overrides: Partial<ControlPlaneConnection> = {}): ControlPlaneConnection {
  return {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    environment: "prod",
    issuer: "https://app.pithy.sh",
    workerUrl: "https://api.example.com",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "agent",
    purpose: "Nightly audit summarizer.",
    scopes: ["manifest:read"],
    keys: [fixtureKey("k1")],
    trusts: [],
    createdAt: REGISTERED,
    updatedAt: REGISTERED,
    ...overrides,
  };
}
