// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { describe, expect, test } from "vitest";
import { httpDashboardClient, ManagementClientUnreachableError } from "./api";
import { dashboardStatus } from "./connect";
import type { ConnectionRegistry } from "./registry";

/**
 * Nothing answered, so the connection's health is unknown — `#614`.
 *
 * `status --verify` turned every throw into `needs_reconnect`, so a CLI that could not reach a
 * dashboard reported that the operator's *connection* needed rebuilding. It is a verdict about a thing
 * nothing looked at, and an operator who believes it runs `connect` and meets a unique index.
 */

const CONNECTION = {
  id: "9e4402e5-fe17-4a9f-9358-e90ab82409e0",
  environment: "staging",
  issuer: "https://staging.app.pithy.sh",
  workerUrl: "https://staging.app.pithy.sh",
  basePath: "/control-plane",
  managementOrigin: "https://staging.app.pithy.sh",
  scopes: [],
  keys: [
    {
      keyId: "7e1e49ae",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
      validFrom: new Date("2026-09-16T00:00:00.000Z"),
      validUntil: null,
      revokedAt: null,
    },
  ],
  createdAt: new Date("2026-09-16T00:00:00.000Z"),
  updatedAt: new Date("2026-09-16T00:00:00.000Z"),
} as unknown as ControlPlaneConnection;

/** A registry over one connection, which is all `status` reads. */
function registryOf(connection: ControlPlaneConnection | null): ConnectionRegistry {
  return {
    read: async () => connection,
    save: async () => {},
    appendKey: async () => connection as ControlPlaneConnection,
    revokeKey: async () => connection,
    remove: async () => true,
    dispose: async () => {},
  };
}

describe("a management client that cannot be reached", () => {
  test("is reported as unreachable, not as a connection needing to be rebuilt", async () => {
    const report = await dashboardStatus({
      registry: registryOf(CONNECTION),
      environment: "staging",
      verify: () => {
        throw new ManagementClientUnreachableError("https://app.pithy.sh", {
          message: "Couldn't reach the management client at https://app.pithy.sh.",
          action: "Nothing is listening at https://app.pithy.sh. Start it, or point --origin somewhere that is.",
          detail: "POST /api/cli/connections/x/verify did not complete",
        });
      },
    });

    // The connection was not examined, so nothing is claimed about it.
    expect(report.status).toBe("unreachable");
    // And the address is in the report, which is the line Jim's run never printed.
    expect(report.detail).toContain("https://app.pithy.sh");
  });

  test("a client that answers and refuses still needs reconnecting", async () => {
    // The distinction this exists to draw: something answered, and what it said was that this
    // registration does not work.
    const report = await dashboardStatus({
      registry: registryOf(CONNECTION),
      environment: "staging",
      verify: async () => ({ status: "needs_reconnect" as const, keyId: null, detail: "no key answered" }),
    });

    expect(report.status).toBe("needs_reconnect");
  });

  test("the transport error names the origin it tried", async () => {
    const client = httpDashboardClient({
      origin: "https://nothing.example",
      fetch: () => Promise.reject(Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" })),
    });

    await expect(client.startDeviceAuthorization()).rejects.toThrow(/nothing\.example/);
    await expect(client.startDeviceAuthorization()).rejects.toBeInstanceOf(ManagementClientUnreachableError);
  });
});
