// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { PithyError, PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { clientById, type McpClient } from "../mcp/clients";
import type { McpOptions } from "../mcp/connect";
import { fakeConnectionRegistry } from "../test-utils/connectionRegistry";
import { findConnection, listConnections, removeConnection, type StorePaths } from "./connections";
import { readAgentKey } from "./keyFile";
import { connectMcp, disconnectMcp, MCP_ISSUER, updateMcpGrant } from "./lifecycle";

const WORKER = "https://acme-prod.acme.workers.dev";
const claudeCode = clientById("claude-code") as McpClient;

let root: string;
let stores: StorePaths;
let mcp: McpOptions;
let keys: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pithy-mcp-lifecycle-"));
  keys = join(root, "config", "keys");
  stores = {
    project: join(root, "repo", ".pithy", "mcp.jsonc"),
    user: join(root, "config", "mcp-connections.json"),
    keys,
  };
  mcp = { projectDir: join(root, "repo"), home: { platform: "linux", env: {}, homedir: join(root, "home") } };
});

/** No session: `requireRegisteringPrincipal`'s refusal, which names `pithy cloudflare connect`. */
const noSession = async (): Promise<string> => {
  throw new PreconditionFailedError({
    message: "Sign in to register a connection.",
    action: "Run pithy cloudflare connect.",
  });
};

/** The dashboard's connection to prod, as `pithy dashboard connect` leaves it. */
function dashboardRow(overrides: Partial<ControlPlaneConnection> = {}): ControlPlaneConnection {
  const now = new Date("2026-10-01T00:00:00Z");
  return {
    id: "5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11",
    environment: "prod",
    issuer: "https://dashboard.pithy.sh",
    workerUrl: WORKER,
    basePath: "/control-plane",
    managementOrigin: null,
    scopes: ["manifest:read"],
    keys: [],
    authorizedBy: "ops@acme.example",
    actorKind: "dashboard",
    purpose: "The Pithy dashboard.",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function keyConnect(registry: ReturnType<typeof fakeConnectionRegistry>, overrides: object = {}) {
  return connectMcp({
    registry,
    project: "acme",
    environment: "prod",
    workerUrl: WORKER,
    basePath: "/control-plane",
    capabilities: [],
    scopes: ["manifest:read", "support:threads:read"],
    purpose: "Support triage, reading threads.",
    principal: async () => "ops@acme.example",
    connect: async () => "pithy dashboard connect --env prod",
    credential: { kind: "key" },
    clients: [claudeCode],
    mcp,
    stores,
    ...overrides,
  });
}

describe("pithy mcp connect with a key", () => {
  test("generates a keypair, registers the public half as kind agent with the purpose and the session's principal", async () => {
    const registry = fakeConnectionRegistry();
    const report = await keyConnect(registry);
    const row = registry.current();
    expect(row?.actorKind).toBe("agent");
    expect(row?.purpose).toBe("Support triage, reading threads.");
    expect(row?.authorizedBy).toBe("ops@acme.example");
    expect(row?.issuer).toBe(MCP_ISSUER);
    expect(row?.scopes).toEqual(["manifest:read", "support:threads:read"]);

    // The private half is the one the registered public half belongs to.
    expect(report.keyFile).toBe(join(keys, `${report.connectionId}.jwk`));
    const key = await readAgentKey(report.keyFile as string);
    expect(row?.keys).toEqual([
      expect.objectContaining({ keyId: key.kid, publicKey: { kty: "OKP", crv: "Ed25519", x: key.x } }),
    ]);
    expect(report.status).toBe("registered");
    expect(report.store).toBe("user");
  });

  test.runIf(process.platform !== "win32")("writes the private key 0600 in a 0700 directory", async () => {
    const report = await keyConnect(fakeConnectionRegistry());
    expect((await stat(report.keyFile as string)).mode & 0o777).toBe(0o600);
    expect((await stat(keys)).mode & 0o777).toBe(0o700);
  });

  test("refuses without a session, and writes nothing — no key, no record, no entry", async () => {
    const registry = fakeConnectionRegistry();
    const refusal = await keyConnect(registry, { principal: noSession }).catch((error: unknown) => error);
    expect((refusal as PithyError).payload.action).toContain("pithy cloudflare connect");
    expect(registry.current()).toBeNull();
    expect(await findConnection(stores, "pithy-acme-prod")).toBeNull();
    await expect(stat(keys)).rejects.toThrow();
  });

  test("refuses without a purpose, naming the flag", async () => {
    const refusal = await keyConnect(fakeConnectionRegistry(), { purpose: undefined }).catch((error: unknown) => error);
    expect((refusal as PithyError).payload.code).toBe("input/required");
  });

  test("writes a user-scope client entry naming the connection, never the credential", async () => {
    const report = await keyConnect(fakeConnectionRegistry());
    expect(report.clients).toEqual([expect.objectContaining({ client: "claude-code", scope: "user", state: "added" })]);
    const written = await readFile(report.clients[0]?.path as string, "utf8");
    expect(JSON.parse(written).mcpServers["pithy-acme-prod"]).toEqual({
      type: "stdio",
      command: "pithy",
      args: ["mcp", "serve", "--connection", "pithy-acme-prod"],
    });
    const key = await readAgentKey(report.keyFile as string);
    expect(written).not.toContain(key.d);
    expect(written).not.toContain(key.x);
    expect(written).not.toContain(".jwk");
  });

  test("a second connect for the same environment is refused, naming --update and disconnect", async () => {
    const registry = fakeConnectionRegistry();
    await keyConnect(registry);
    const refusal = await keyConnect(registry).catch((error: unknown) => error);
    expect((refusal as PithyError).payload.action).toContain("--update");
    expect((refusal as PithyError).payload.action).toContain("pithy mcp disconnect");
  });

  test("on an environment whose connection is not an agent's, it is refused and the connection is left as it was", async () => {
    // A connection with no key — a CI script's trust — would otherwise take the agent key and be relabelled agent.
    const script = dashboardRow({ actorKind: "script", purpose: "Nightly export.", issuer: "https://gitlab.com" });
    const registry = fakeConnectionRegistry(script);
    const decideScopes = vi.fn(async () => ["manifest:read" as const]);
    const refusal = await keyConnect(registry, { scopes: undefined, decideScopes }).catch((error: unknown) => error);
    expect((refusal as PithyError).payload.code).toBe("core/conflict");
    expect((refusal as PithyError).payload.message).toContain("script");
    expect(registry.current()).toEqual(script);
    expect(decideScopes).not.toHaveBeenCalled();
    expect(await findConnection(stores, "pithy-acme-prod")).toBeNull();
    await expect(stat(keys)).rejects.toThrow();
  });

  test("joining an agent's connection asks for no grant, and a --scope named is refused rather than dropped", async () => {
    const trust = {
      kind: "oidc" as const,
      issuer: "https://token.actions.githubusercontent.com",
      claims: { repository_id: "1262274726", environment: "prod" },
      source: { kind: "github" as const },
    };
    const registry = fakeConnectionRegistry();
    await keyConnect(registry, { credential: trust, resolveIssuer: async () => "https://jwks.example" });

    const named = await keyConnect(registry, { scopes: ["manifest:read"] }).catch((error: unknown) => error);
    expect((named as PithyError).payload.code).toBe("core/conflict");
    expect((named as PithyError).payload.action).toContain("--update");
    expect(registry.current()?.keys).toEqual([]);
    expect(registry.current()?.scopes).toEqual(["manifest:read", "support:threads:read"]);

    const decideScopes = vi.fn(async () => ["manifest:read" as const]);
    const report = await keyConnect(registry, { scopes: undefined, decideScopes });
    expect(decideScopes).not.toHaveBeenCalled();
    expect(report.scopes).toEqual(["manifest:read", "support:threads:read"]);
    expect(registry.current()?.actorKind).toBe("agent");
    expect(registry.current()?.keys).toHaveLength(1);
  });
});

describe("pithy mcp connect with an OIDC trust", () => {
  const trust = {
    kind: "oidc" as const,
    issuer: "https://token.actions.githubusercontent.com",
    claims: { repository_id: "1262274726", environment: "prod" },
    source: { kind: "github" as const },
  };

  test("registers a trust through #722's path, writes no key, and records where the token comes from", async () => {
    const registry = fakeConnectionRegistry();
    const report = await keyConnect(registry, {
      credential: trust,
      resolveIssuer: async () => "https://token.actions.githubusercontent.com/.well-known/jwks",
    });
    const row = registry.current();
    expect(row?.keys).toEqual([]);
    expect(row?.actorKind).toBe("agent");
    expect(row?.trusts).toEqual([
      expect.objectContaining({
        issuer: trust.issuer,
        claims: trust.claims,
        audience: WORKER,
        authorizedBy: "ops@acme.example",
      }),
    ]);
    expect(report.keyFile).toBeNull();
    expect(report.status).toBe("awaiting_first_call");
    await expect(stat(keys)).rejects.toThrow();

    // Committed with the project, so CI finds it in the checkout; no token anywhere in it.
    expect(report.store).toBe("project");
    expect(report.alias).toBe("pithy-acme-prod-ci");
    const found = await findConnection(stores, "pithy-acme-prod-ci");
    expect(found?.record.credential).toEqual({
      kind: "oidc",
      trustId: report.trustId,
      audience: WORKER,
      source: { kind: "github" },
    });
    expect(report.clients[0]).toMatchObject({ client: "claude-code", scope: "project", state: "added" });
    expect(report.clients[0]?.path).toBe(join(mcp.projectDir, ".mcp.json"));
  });

  test("a developer's key and CI's trust on one environment are two aliases, so neither store shadows the other", async () => {
    const registry = fakeConnectionRegistry();
    const key = await keyConnect(registry);
    // CI's trust joins the agent's connection — on another machine, so no local record stands in its way.
    const ci = await keyConnect(registry, {
      credential: trust,
      scopes: undefined,
      resolveIssuer: async () => "https://jwks.example",
    });
    expect(ci.connectionId).toBe(key.connectionId);
    expect(ci.alias).not.toBe(key.alias);
    expect((await findConnection(stores, key.alias))?.scope).toBe("user");
    expect((await findConnection(stores, ci.alias))?.scope).toBe("project");
    expect((await listConnections(stores)).map(({ record }) => record.alias).sort()).toEqual([
      "pithy-acme-prod",
      "pithy-acme-prod-ci",
    ]);
  });

  test("refuses without a session, naming pithy cloudflare connect", async () => {
    const refusal = await keyConnect(fakeConnectionRegistry(), { credential: trust, principal: noSession }).catch(
      (error: unknown) => error,
    );
    expect((refusal as PithyError).payload.action).toContain("pithy cloudflare connect");
  });

  test("joining a connection that is not an agent's is refused, so its calls are never audited as the dashboard", async () => {
    const dashboard = dashboardRow();
    const registry = fakeConnectionRegistry(dashboard);
    const refusal = await keyConnect(registry, {
      credential: trust,
      scopes: undefined,
      resolveIssuer: async () => "https://jwks.example",
    }).catch((error: unknown) => error);
    expect((refusal as PithyError).payload.code).toBe("core/conflict");
    expect((refusal as PithyError).payload.message).toContain("dashboard");
    expect(registry.current()).toEqual(dashboard);
    expect(await findConnection(stores, "pithy-acme-prod-ci")).toBeNull();
  });

  test("joining an agent's connection asks for no grant, since it takes the connection's", async () => {
    const registry = fakeConnectionRegistry();
    await keyConnect(registry, { credential: trust, resolveIssuer: async () => "https://jwks.example" });
    await removeConnection(stores, "project", "pithy-acme-prod-ci");
    const decideScopes = vi.fn(async () => ["manifest:read" as const]);
    const report = await keyConnect(registry, {
      credential: { ...trust, claims: { repository_id: "1262274726", environment: "staging" } },
      scopes: undefined,
      decideScopes,
      resolveIssuer: async () => "https://jwks.example",
    });
    expect(decideScopes).not.toHaveBeenCalled();
    expect(report.scopes).toEqual(["manifest:read", "support:threads:read"]);
    expect(registry.current()?.trusts).toHaveLength(2);
  });

  test("creating the connection decides the grant then", async () => {
    const registry = fakeConnectionRegistry();
    const decideScopes = vi.fn(async () => ["manifest:read" as const]);
    await keyConnect(registry, {
      credential: trust,
      scopes: undefined,
      decideScopes,
      resolveIssuer: async () => "https://jwks.example",
    });
    expect(decideScopes).toHaveBeenCalledOnce();
    expect(registry.current()?.scopes).toEqual(["manifest:read"]);
  });

  test("a client with no project configuration is refused for a trust, and said so", async () => {
    const report = await keyConnect(fakeConnectionRegistry(), {
      credential: trust,
      clients: [clientById("claude-desktop") as McpClient],
      resolveIssuer: async () => "https://jwks.example",
    });
    expect(report.clients[0]).toMatchObject({ state: "refused" });
    expect(report.clients[0]?.reason).toContain("no project configuration");
  });
});

describe("pithy mcp connect --update", () => {
  test("replaces the grant with exactly the scopes given", async () => {
    const registry = fakeConnectionRegistry();
    await keyConnect(registry);
    const report = await updateMcpGrant({
      registry,
      project: "acme",
      environment: "prod",
      scopes: ["manifest:read"],
      principal: async () => "ops@acme.example",
      stores,
    });
    expect(report.scopesBefore).toEqual(["manifest:read", "support:threads:read"]);
    expect(registry.current()?.scopes).toEqual(["manifest:read"]);
  });

  test("is refused without a session like a registration, and changes nothing", async () => {
    const registry = fakeConnectionRegistry();
    await keyConnect(registry);
    const refusal = await updateMcpGrant({
      registry,
      project: "acme",
      environment: "prod",
      scopes: ["manifest:read"],
      principal: noSession,
      stores,
    }).catch((error: unknown) => error);
    expect((refusal as PithyError).payload.action).toContain("pithy cloudflare connect");
    expect(registry.current()?.scopes).toEqual(["manifest:read", "support:threads:read"]);
  });

  test("on a connection that is no longer this agent's, it is refused and that connection's grant is unchanged", async () => {
    const registry = fakeConnectionRegistry();
    await keyConnect(registry);
    // `pithy dashboard disconnect`, then `pithy dashboard connect`: the local record outlives the agent's connection.
    await registry.remove();
    const dashboard = dashboardRow();
    await registry.save(dashboard);
    const refusal = await updateMcpGrant({
      registry,
      project: "acme",
      environment: "prod",
      scopes: ["manifest:read", "support:threads:read"],
      principal: async () => "ops@acme.example",
      stores,
    }).catch((error: unknown) => error);
    expect((refusal as PithyError).payload.code).toBe("core/conflict");
    expect((refusal as PithyError).payload.action).toContain("pithy mcp disconnect");
    expect(registry.current()).toEqual(dashboard);
  });

  test("updates a trust-only connection through its record", async () => {
    const registry = fakeConnectionRegistry();
    await keyConnect(registry, {
      credential: {
        kind: "oidc",
        issuer: "https://gitlab.com",
        claims: { project_id: "42" },
        source: { kind: "gitlab", variable: "MCP_ID_TOKEN" },
      },
      resolveIssuer: async () => "https://jwks.example",
    });
    const report = await updateMcpGrant({
      registry,
      project: "acme",
      environment: "prod",
      scopes: ["manifest:read"],
      principal: async () => "ops@acme.example",
      stores,
    });
    expect(report.alias).toBe("pithy-acme-prod-ci");
    expect(registry.current()?.scopes).toEqual(["manifest:read"]);
  });

  test("on an environment with no connection here, names connect", async () => {
    const refusal = await updateMcpGrant({
      registry: fakeConnectionRegistry(),
      project: "acme",
      environment: "prod",
      scopes: [],
      principal: async () => "ops@acme.example",
      stores,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PithyError);
    expect((refusal as PithyError).payload.action).toContain("pithy mcp connect");
  });
});

describe("pithy mcp disconnect", () => {
  test("revokes the key, removes the key file, the client entry and the record", async () => {
    const registry = fakeConnectionRegistry();
    const connected = await keyConnect(registry);
    const found = await findConnection(stores, "pithy-acme-prod");
    const report = await disconnectMcp({
      registry,
      project: "acme",
      record: found?.record as never,
      scope: "user",
      mcp,
      stores,
    });
    expect(report.revoked).toBe(true);
    expect(registry.current()?.keys[0]?.revokedAt).not.toBeNull();
    expect(report.keyFileRemoved).toBe(true);
    await expect(stat(connected.keyFile as string)).rejects.toThrow();
    expect(report.clients).toEqual([expect.objectContaining({ client: "claude-code", state: "removed" })]);
    const config = JSON.parse(await readFile(connected.clients[0]?.path as string, "utf8"));
    expect(config.mcpServers).toEqual({});
    expect(await findConnection(stores, "pithy-acme-prod")).toBeNull();
  });

  test("revokes a trust and says a minted token stays live until it expires", async () => {
    const registry = fakeConnectionRegistry();
    await keyConnect(registry, {
      credential: {
        kind: "oidc",
        issuer: "https://gitlab.com",
        claims: { project_id: "42" },
        source: { kind: "gitlab", variable: "MCP_ID_TOKEN" },
      },
      resolveIssuer: async () => "https://gitlab.com/oauth/discovery/keys",
    });
    const found = await findConnection(stores, "pithy-acme-prod-ci");
    const revoke = vi.spyOn(registry, "revokeTrust");
    const report = await disconnectMcp({
      registry,
      project: "acme",
      record: found?.record as never,
      scope: "project",
      mcp,
      stores,
    });
    expect(revoke).toHaveBeenCalledOnce();
    expect(registry.current()?.trusts?.[0]?.revokedAt).not.toBeNull();
    expect(report.latency).toBeDefined();
    expect(report.keyFileRemoved).toBe(false);
  });

  test("with the connection gone from the Worker, there is nothing to revoke, and the rest is still cleaned up", async () => {
    const registry = fakeConnectionRegistry();
    const connected = await keyConnect(registry);
    await registry.remove();
    const found = await findConnection(stores, "pithy-acme-prod");
    const report = await disconnectMcp({
      registry,
      project: "acme",
      record: found?.record as never,
      scope: "user",
      mcp,
      stores,
    });
    expect(report.revoked).toBe(false);
    expect(report.keyFileRemoved).toBe(true);
    await expect(stat(connected.keyFile as string)).rejects.toThrow();
    expect(await findConnection(stores, "pithy-acme-prod")).toBeNull();
  });

  test("on a connection that is no longer this agent's, revokes nothing there and still cleans up", async () => {
    const registry = fakeConnectionRegistry();
    await keyConnect(registry);
    const found = await findConnection(stores, "pithy-acme-prod");
    await registry.remove();
    await registry.save(dashboardRow());
    const revokeKey = vi.spyOn(registry, "revokeKey");
    const report = await disconnectMcp({
      registry,
      project: "acme",
      record: found?.record as never,
      scope: "user",
      mcp,
      stores,
    });
    expect(revokeKey).not.toHaveBeenCalled();
    expect(report.revoked).toBe(false);
    expect(await findConnection(stores, "pithy-acme-prod")).toBeNull();
  });

  test("run from another project, it is refused and leaves the key file and the record", async () => {
    const registry = fakeConnectionRegistry();
    const connected = await keyConnect(registry);
    const found = await findConnection(stores, "pithy-acme-prod");
    const refusal = await disconnectMcp({
      registry: fakeConnectionRegistry(),
      project: "globex",
      record: found?.record as never,
      scope: "user",
      mcp,
      stores,
    }).catch((error: unknown) => error);
    expect((refusal as PithyError).payload.code).toBe("core/precondition_failed");
    expect((refusal as PithyError).payload.message).toContain("acme");
    expect((await stat(connected.keyFile as string)).isFile()).toBe(true);
    expect(await findConnection(stores, "pithy-acme-prod")).not.toBeNull();
    expect(registry.current()?.keys[0]?.revokedAt).toBeNull();
  });
});
