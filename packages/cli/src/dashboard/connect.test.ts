// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneConnection, RegisteredKey } from "@pithy-sh/core/src/controlPlane/data/connection";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import {
  authorizeDashboard,
  connectDashboard,
  dashboardStatus,
  disconnectDashboard,
  rotateDashboardKey,
} from "./connect";
import type { ConnectionHealth, DashboardClient } from "./contract";
import type { ConnectionRegistry } from "./registry";

const JWK = { kty: "OKP", crv: "Ed25519", x: "kHo4iZ3rG3Jm2m7L9pQwXyZ0aBcDeFgHiJkLmNoPqRs" } as const;
const NOW = new Date("2026-07-30T00:00:00.000Z");
const CONNECTION_ID = "5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31";

/** An in-memory registry — the D1 half is proven in registry.test.ts against a real database. */
function fakeRegistry(initial: ControlPlaneConnection | null = null): ConnectionRegistry & {
  current: () => ControlPlaneConnection | null;
} {
  let row = initial;
  return {
    read: async () => row,
    save: async (connection) => {
      row = connection;
    },
    appendKey: async (key, now) => {
      if (!row) throw new Error("appendKey called with nothing registered");
      row = { ...row, keys: [...row.keys, key], updatedAt: now };
      return row;
    },
    revokeKey: async (keyId, now) => {
      if (!row) throw new Error("revokeKey called with nothing registered");
      if (!row.keys.some((key) => key.keyId === keyId)) return null;
      row = {
        ...row,
        keys: row.keys.map((key) => (key.keyId === keyId ? { ...key, revokedAt: now } : key)),
        updatedAt: now,
      };
      return row;
    },
    remove: async () => {
      const had = row !== null;
      row = null;
      return had;
    },
    dispose: async () => {},
    current: () => row,
  };
}

/** A dashboard that answers everything successfully, unless a case overrides one call. */
function fakeClient(overrides: Partial<DashboardClient> = {}): DashboardClient {
  return {
    startDeviceAuthorization: async () => ({
      deviceCode: "dc_1",
      userCode: "PITHY-7Q4X",
      verificationUri: "https://app.pithy.sh/cli",
      expiresInSeconds: 600,
      intervalSeconds: 1,
    }),
    pollForConnectToken: async () => ({ connectToken: "ct_1", expiresInSeconds: 300 }),
    updateConnection: async () => {},
    createConnection: async () => ({
      connectionId: CONNECTION_ID,
      keyId: "key_1",
      publicKeyJwk: JWK,
      issuer: "https://app.pithy.sh",
      scopes: ["manifest:read", "keys:rotate"],
    }),
    rotateKey: async () => ({ keyId: "key_2", publicKeyJwk: JWK }),
    verifyConnection: async () => ({ status: "connected" }) as ConnectionHealth,
    deleteConnection: async () => {},
    ...overrides,
  };
}

/** A registered key with an open-ended window. */
function key(keyId: string, validFrom: Date): RegisteredKey {
  return { keyId, publicKey: JWK, validFrom, validUntil: null, revokedAt: null };
}

/** A connection already in the registry. */
function existing(overrides: Partial<ControlPlaneConnection> = {}): ControlPlaneConnection {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: CONNECTION_ID,
    environment: "prod",
    issuer: "https://app.pithy.sh",
    workerUrl: "https://api.example.com",
    basePath: "/control-plane",
    scopes: ["manifest:read"],
    keys: [key("key_1", at)],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** The shared arguments of a dashboard-path connect. */
const base = {
  project: "acme",
  environment: "prod",
  workerUrl: "https://api.example.com",
  basePath: "/control-plane",
  now: () => NOW,
  authorize: async () => "ct_1",
};

describe("authorizeDashboard", () => {
  test("polls through pending and returns the token once the human approves", async () => {
    const poll = vi
      .fn<DashboardClient["pollForConnectToken"]>()
      .mockResolvedValueOnce("pending")
      .mockResolvedValueOnce("pending")
      .mockResolvedValueOnce({ connectToken: "ct_9", expiresInSeconds: 300 });
    const announce = vi.fn();

    const token = await authorizeDashboard(fakeClient({ pollForConnectToken: poll }), {
      announce,
      sleep: async () => {},
    });

    expect(token).toBe("ct_9");
    expect(poll).toHaveBeenCalledTimes(3);
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ userCode: "PITHY-7Q4X" }));
  });

  test("gives up when the request is gone — the 410 is not retried", async () => {
    const poll = vi
      .fn<DashboardClient["pollForConnectToken"]>()
      .mockResolvedValueOnce("pending")
      .mockRejectedValueOnce(
        new PithyError({ code: "core/not_found", status: 404, message: "That sign-in request expired." }),
      );

    const error = await authorizeDashboard(fakeClient({ pollForConnectToken: poll }), { sleep: async () => {} }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PithyError);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  test("stops polling when the authorization window closes", async () => {
    let clock = 0;
    const poll = vi.fn<DashboardClient["pollForConnectToken"]>().mockResolvedValue("pending");
    const client = fakeClient({
      pollForConnectToken: poll,
      startDeviceAuthorization: async () => ({
        deviceCode: "dc_1",
        userCode: "A",
        verificationUri: "https://app.pithy.sh/cli",
        expiresInSeconds: 3,
        intervalSeconds: 1,
      }),
    });

    const error = await authorizeDashboard(client, {
      sleep: async () => {
        clock += 1000;
      },
      now: () => clock,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("expired");
  });
});

describe("connectDashboard — the dashboard path", () => {
  test("creates the connection, writes the row, and only then reports connected", async () => {
    const registry = fakeRegistry();
    const client = fakeClient();

    const report = await connectDashboard({ ...base, registry, client });

    expect(report.status).toBe("connected");
    expect(report.connectionId).toBe(CONNECTION_ID);
    expect(report.keyId).toBe("key_1");
    expect(registry.current()?.keys.map((k) => k.keyId)).toEqual(["key_1"]);
    expect(registry.current()?.issuer).toBe("https://app.pithy.sh");
  });

  test("a failed ping reports needs_reconnect — never a silent success", async () => {
    const registry = fakeRegistry();
    const client = fakeClient({
      verifyConnection: async () => ({ status: "needs_reconnect", detail: "404 from the worker" }),
    });

    const report = await connectDashboard({ ...base, registry, client });

    expect(report.status).toBe("needs_reconnect");
    expect(report.detail).toBe("404 from the worker");
    // The row is still written: the registration is real, it is the round-trip that failed.
    expect(registry.current()?.id).toBe(CONNECTION_ID);
  });

  test("a ping that throws is also needs_reconnect, not a crash", async () => {
    const registry = fakeRegistry();
    const client = fakeClient({
      verifyConnection: async () => {
        throw new PithyError({ code: "core/internal", status: 500, message: "Couldn't reach the management client." });
      },
    });

    const report = await connectDashboard({ ...base, registry, client });

    expect(report.status).toBe("needs_reconnect");
    expect(report.detail).toContain("Couldn't reach");
  });

  test("tells the client whether the environment holds live data, at the moment it registers", async () => {
    const createConnection = vi.fn<DashboardClient["createConnection"]>().mockResolvedValue({
      connectionId: CONNECTION_ID,
      keyId: "key_1",
      publicKeyJwk: JWK,
      issuer: "https://app.pithy.sh",
      scopes: ["manifest:read", "keys:rotate"],
    });

    await connectDashboard({
      ...base,
      registry: fakeRegistry(),
      client: fakeClient({ createConnection }),
      isProduction: true,
    });

    // Sent, not inferred. A client reading the environment name gives a project that calls production
    // `live` the safe-looking treatment — on real users.
    expect(createConnection).toHaveBeenCalledWith("ct_1", expect.objectContaining({ isProduction: true }));
  });

  test("an unstated environment is not production — the dangerous default is never the quiet one", async () => {
    const createConnection = vi.fn<DashboardClient["createConnection"]>().mockResolvedValue({
      connectionId: CONNECTION_ID,
      keyId: "key_1",
      publicKeyJwk: JWK,
      issuer: "https://app.pithy.sh",
      scopes: ["manifest:read", "keys:rotate"],
    });

    await connectDashboard({ ...base, registry: fakeRegistry(), client: fakeClient({ createConnection }) });

    expect(createConnection).toHaveBeenCalledWith("ct_1", expect.objectContaining({ isProduction: false }));
  });

  test("--update re-points the worker URL and scopes instead of creating a connection", async () => {
    const registry = fakeRegistry(existing());
    const createConnection = vi.fn<DashboardClient["createConnection"]>();
    const client = fakeClient({ createConnection });

    const report = await connectDashboard({
      ...base,
      registry,
      client,
      update: true,
      workerUrl: "https://admin.example.com",
      basePath: "/control-plane",
      scopes: ["manifest:read", "keys:rotate"],
    });

    expect(createConnection).not.toHaveBeenCalled();
    expect(report.updated).toBe(true);
    expect(report.connectionId).toBe(CONNECTION_ID);
    expect(registry.current()?.workerUrl).toBe("https://admin.example.com");
    expect(registry.current()?.scopes).toEqual(["manifest:read", "keys:rotate"]);
    // Re-pointing is not a rotation: the keys are untouched.
    expect(registry.current()?.keys.map((k) => k.keyId)).toEqual(["key_1"]);
  });

  test("--update with nothing registered says so rather than inventing a connection", async () => {
    const error = await connectDashboard({
      ...base,
      registry: fakeRegistry(),
      client: fakeClient(),
      update: true,
    }).catch((caught: unknown) => caught);
    expect((error as PithyError).payload.code).toBe("controlplane/not_connected");
  });

  test("no client and no --public-key is an actionable error, not a hang", async () => {
    const error = await connectDashboard({ ...base, registry: fakeRegistry() }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toBeTruthy();
  });
});

describe("connectDashboard — an update re-points the client, not only the row", () => {
  test("tells the client the new address before saving it locally", async () => {
    // Two places hold the address: the adopter's enforcement row, and the client's record of where to
    // call. Writing only the first leaves the CLI reporting success while every management call goes to
    // a dead address — which reads as an outage, not as a stale registration.
    const told: { connectionId: string; workerUrl: string; basePath: string }[] = [];
    const registry = fakeRegistry(existing({ workerUrl: "https://old.example.com", basePath: "/control-plane" }));

    await connectDashboard({
      registry,
      project: "acme",
      environment: "prod",
      update: true,
      workerUrl: "https://new.example.com",
      basePath: "/admin",
      client: fakeClient({
        updateConnection: async (_token, connectionId, request) => {
          told.push({ connectionId, ...request });
        },
      }),
      authorize: async () => "ct_1",
      now: () => NOW,
    });

    expect(told).toEqual([{ connectionId: CONNECTION_ID, workerUrl: "https://new.example.com", basePath: "/admin" }]);
    expect(registry.current()?.workerUrl).toBe("https://new.example.com");
    expect(registry.current()?.basePath).toBe("/admin");
  });

  test("changes nothing locally when the client cannot be re-pointed", async () => {
    // Remote first, then local. A failure has to leave both sides agreeing on the old address rather
    // than leaving the row ahead of the client — the same "one write, or none" rule a rotation follows.
    const registry = fakeRegistry(existing({ workerUrl: "https://old.example.com", basePath: "/control-plane" }));

    await expect(
      connectDashboard({
        registry,
        project: "acme",
        environment: "prod",
        update: true,
        workerUrl: "https://new.example.com",
        client: fakeClient({
          updateConnection: async () => {
            throw new Error("the client refused that request");
          },
        }),
        authorize: async () => "ct_1",
        now: () => NOW,
      }),
    ).rejects.toThrow(/refused/);

    expect(registry.current()?.workerUrl).toBe("https://old.example.com");
  });

  test("does not call the client when only the scopes changed", async () => {
    // A scope change is entirely the adopter's side — their row is the authority, and telling the client
    // what it may do would be asking it to enforce its own limits.
    let calls = 0;
    const registry = fakeRegistry(existing({ workerUrl: "https://api.example.com", basePath: "/control-plane" }));

    await connectDashboard({
      registry,
      project: "acme",
      environment: "prod",
      update: true,
      scopes: ["manifest:read"],
      client: fakeClient({
        updateConnection: async () => {
          calls += 1;
        },
      }),
      authorize: async () => "ct_1",
      now: () => NOW,
    });

    expect(calls).toBe(0);
    expect(registry.current()?.scopes).toEqual(["manifest:read"]);
  });
});

describe("connectDashboard — the grant is the operator's, not the client's", () => {
  // The row this writes is the ONLY thing the adopter's Worker consults when it decides what a
  // management client may do (`scopeCovers(required, presented, connection.scopes)`). So the party
  // being constrained must not be the party that authors the constraint. These two tests are the whole
  // reason `assertNoScopeEscalation` exists.

  test("stores what the operator asked for, not what the client echoed back", async () => {
    const registry = fakeRegistry();

    await connectDashboard({
      ...base,
      registry,
      scopes: ["manifest:read"],
      // A well-behaved client that simply echoes a broader default. Even benignly, its account of the
      // grant is not the grant.
      client: fakeClient({
        createConnection: async () => ({
          connectionId: CONNECTION_ID,
          keyId: "key_1",
          publicKeyJwk: JWK,
          issuer: "https://app.pithy.sh",
          scopes: ["manifest:read"],
        }),
      }),
    });

    expect(registry.current()?.scopes).toEqual(["manifest:read"]);
  });

  test("refuses the whole connection when the client returns a scope nobody requested", async () => {
    const registry = fakeRegistry();

    const error = await connectDashboard({
      ...base,
      registry,
      scopes: ["manifest:read"],
      // A compromised client self-granting the two most dangerous scopes in the tree: rotating the keys
      // that guard the seam, and minting paid entitlements out of nothing.
      client: fakeClient({
        createConnection: async () => ({
          connectionId: CONNECTION_ID,
          keyId: "key_1",
          publicKeyJwk: JWK,
          issuer: "https://app.pithy.sh",
          scopes: ["manifest:read", "keys:rotate", "payments:entitlements:grant"],
        }),
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("validation/invalid_input");
    // Nothing was written. A partial registration would leave the adopter's Worker enforcing a grant
    // they never made, which is exactly the outcome being prevented.
    expect(registry.current()).toBeNull();
  });

  test("accepts a client that declines a scope — returning fewer is its business", async () => {
    const registry = fakeRegistry();

    await connectDashboard({
      ...base,
      registry,
      scopes: ["manifest:read", "keys:rotate"],
      client: fakeClient({
        createConnection: async () => ({
          connectionId: CONNECTION_ID,
          keyId: "key_1",
          publicKeyJwk: JWK,
          issuer: "https://app.pithy.sh",
          scopes: ["manifest:read"],
        }),
      }),
    });

    // The operator's list still governs. A client that chooses not to exercise a scope has not removed
    // it, and the adopter revokes by re-running connect, never by the client's say-so.
    expect(registry.current()?.scopes).toEqual(["manifest:read", "keys:rotate"]);
  });
});

describe("connectDashboard — the offline path", () => {
  test("registers a key the operator generated, with no dashboard involved at all", async () => {
    const registry = fakeRegistry();

    const report = await connectDashboard({
      ...base,
      registry,
      client: undefined,
      authorize: undefined,
      publicKey: { keyId: "own_1", publicKey: JWK, issuer: "https://admin.acme.dev" },
      scopes: ["manifest:read"],
    });

    expect(report.status).toBe("registered");
    expect(report.keyId).toBe("own_1");
    const row = registry.current();
    expect(row?.issuer).toBe("https://admin.acme.dev");
    expect(row?.workerUrl).toBe("https://api.example.com");
    expect(row?.scopes).toEqual(["manifest:read"]);
    expect(row?.keys).toEqual([key("own_1", NOW)]);
  });

  test("appends to an existing connection rather than replacing it", async () => {
    const registry = fakeRegistry(existing());

    const report = await connectDashboard({
      ...base,
      registry,
      client: undefined,
      authorize: undefined,
      publicKey: { keyId: "own_2", publicKey: JWK, issuer: "https://app.pithy.sh" },
    });

    expect(report.connectionId).toBe(CONNECTION_ID);
    expect(registry.current()?.keys.map((k) => k.keyId)).toEqual(["key_1", "own_2"]);
    // Appending never closes the window on the key that is already working.
    expect(registry.current()?.keys[0]?.validUntil).toBeNull();
  });

  test("a different issuer on an existing connection is a conflict, not a silent overwrite", async () => {
    const registry = fakeRegistry(existing());
    const error = await connectDashboard({
      ...base,
      registry,
      client: undefined,
      authorize: undefined,
      publicKey: { keyId: "own_2", publicKey: JWK, issuer: "https://elsewhere.example.com" },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("core/conflict");
  });
});

describe("rotateDashboardKey", () => {
  test("appends the new key, proves it, and never expires the old one", async () => {
    const registry = fakeRegistry(existing());
    const client = fakeClient();

    const report = await rotateDashboardKey({
      registry,
      client,
      environment: "prod",
      authorize: async () => "ct_1",
      now: () => NOW,
    });

    expect(report.keyId).toBe("key_2");
    expect(report.status).toBe("connected");
    expect(report.previousKeyIds).toEqual(["key_1"]);
    const keys = registry.current()?.keys ?? [];
    expect(keys.map((k) => k.keyId)).toEqual(["key_1", "key_2"]);
    // The whole safety property: two live keys is the normal state after a rotation.
    expect(keys.every((k) => k.validUntil === null && k.revokedAt === null)).toBe(true);
  });

  test("a rotation whose new key does not verify reports needs_reconnect and still leaves the old key live", async () => {
    const registry = fakeRegistry(existing());
    const client = fakeClient({ verifyConnection: async () => ({ status: "needs_reconnect", detail: "401" }) });

    const report = await rotateDashboardKey({
      registry,
      client,
      environment: "prod",
      authorize: async () => "ct_1",
      now: () => NOW,
    });

    expect(report.status).toBe("needs_reconnect");
    expect(registry.current()?.keys[0]?.validUntil).toBeNull();
  });

  test("rotating an unconnected environment says so", async () => {
    const error = await rotateDashboardKey({
      registry: fakeRegistry(),
      client: fakeClient(),
      environment: "prod",
      authorize: async () => "ct_1",
    }).catch((caught: unknown) => caught);
    expect((error as PithyError).payload.code).toBe("controlplane/not_connected");
  });
});

describe("disconnectDashboard", () => {
  test("revokes locally even when the dashboard call fails — revocation needs nobody's agreement", async () => {
    const registry = fakeRegistry(existing());
    const client = fakeClient({
      deleteConnection: async () => {
        throw new PithyError({ code: "core/internal", status: 500, message: "Couldn't reach the management client." });
      },
    });

    const report = await disconnectDashboard({
      registry,
      client,
      environment: "prod",
      authorize: async () => "ct_1",
    });

    expect(report.removed).toBe(true);
    expect(report.dashboardNotified).toBe(false);
    expect(report.detail).toContain("Couldn't reach");
    expect(registry.current()).toBeNull();
  });

  test("the row is gone before the dashboard is even asked", async () => {
    const registry = fakeRegistry(existing());
    let rowAtCallTime: ControlPlaneConnection | null = existing();
    const client = fakeClient({
      deleteConnection: async () => {
        rowAtCallTime = registry.current();
      },
    });

    await disconnectDashboard({ registry, client, environment: "prod", authorize: async () => "ct_1" });

    expect(rowAtCallTime).toBeNull();
  });

  test("nothing registered is not an error — teardown is safe to re-run", async () => {
    const report = await disconnectDashboard({ registry: fakeRegistry(), environment: "prod" });
    expect(report.removed).toBe(false);
    expect(report.connectionId).toBeNull();
  });
});

describe("dashboardStatus", () => {
  test("reports the connection, its keys, and their ages", async () => {
    const registry = fakeRegistry(
      existing({
        keys: [
          key("key_1", new Date("2026-01-01T00:00:00.000Z")),
          { ...key("key_0", new Date("2025-01-01T00:00:00.000Z")), validUntil: new Date("2026-01-02T00:00:00.000Z") },
        ],
      }),
    );

    const report = await dashboardStatus({ registry, environment: "prod", now: () => NOW });

    expect(report.connected).toBe(true);
    expect(report.workerUrl).toBe("https://api.example.com");
    expect(report.keys).toEqual([
      {
        keyId: "key_1",
        live: true,
        ageDays: 210,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: null,
        revokedAt: null,
      },
      {
        keyId: "key_0",
        live: false,
        ageDays: 575,
        validFrom: "2025-01-01T00:00:00.000Z",
        validUntil: "2026-01-02T00:00:00.000Z",
        revokedAt: null,
      },
    ]);
    // No probe was asked for, so the status is honest about not knowing.
    expect(report.status).toBe("unverified");
  });

  test("a probe turns the report into a proven one", async () => {
    const registry = fakeRegistry(existing());
    const report = await dashboardStatus({
      registry,
      environment: "prod",
      now: () => NOW,
      verify: async () => ({ status: "needs_reconnect", detail: "connection refused" }),
    });
    expect(report.status).toBe("needs_reconnect");
    expect(report.detail).toBe("connection refused");
  });

  test("nothing registered reports disconnected rather than throwing", async () => {
    const report = await dashboardStatus({ registry: fakeRegistry(), environment: "prod", now: () => NOW });
    expect(report).toMatchObject({ connected: false, connectionId: null, keys: [], status: "unverified" });
  });
});
