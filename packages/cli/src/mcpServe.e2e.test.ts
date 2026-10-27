// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseCompactJws, verifyEd25519 } from "@pithy-sh/core/src/controlPlane/token/jws";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { saveConnection } from "./mcpServer/connections";
import { generateAgentKey, keyFilePath, writeAgentKey } from "./mcpServer/keyFile";

/**
 * **An MCP client spawns `pithy mcp serve --connection <alias>` and lists tools from that connection's live
 * manifest (#723) — measured on the real bin, over real stdio, against a Worker that verifies every signature.**
 *
 * The Worker here is a plain HTTP server standing in for the adopter's: it serves a manifest and one admin route,
 * and refuses any call whose `pithy-control-plane` token does not verify against the registered public key or
 * names a scope other than the route's. What it records is what the seam would audit.
 */

const bin = join(import.meta.dirname, "bin.ts");
const CONNECTION = "5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11";
const input = (properties: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  additionalProperties: false,
});

let worker: Server;
let configDir: string;
let projectDir: string;
const seen: { path: string; scope: string }[] = [];

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => resolve(text));
  });
}

beforeEach(async () => {
  seen.length = 0;
  configDir = await mkdtemp(join(tmpdir(), "pithy-mcp-e2e-config-"));
  projectDir = await mkdtemp(join(tmpdir(), "pithy-mcp-e2e-project-"));
  const key = await generateAgentKey("mcp-e2e");
  const publicKey = { kty: "OKP" as const, crv: "Ed25519" as const, x: key.x };

  worker = createServer(async (request, response) => {
    await body(request);
    const token = String(request.headers["pithy-control-plane"] ?? "");
    let scope = "";
    try {
      const parsed = parseCompactJws(token);
      if (!(await verifyEd25519(parsed.signingInput, parsed.signature, publicKey))) throw new Error("bad signature");
      if (parsed.claims.aud !== CONNECTION) throw new Error("wrong connection");
      scope = parsed.claims.scope;
    } catch {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "controlplane/invalid_credential", message: "Invalid credential." }));
      return;
    }
    const path = (request.url ?? "").split("?")[0] as string;
    seen.push({ path, scope });
    response.writeHead(200, { "content-type": "application/json" });
    if (path === "/control-plane/manifest") {
      response.end(
        JSON.stringify({
          environment: "prod",
          connectionId: CONNECTION,
          version: null,
          grantedScopes: ["manifest:read", "support:threads:read"],
          capabilities: [
            {
              name: "support",
              version: "0.9.0",
              adminRoutes: [
                {
                  method: "GET",
                  path: "/support/threads",
                  scope: "support:threads:read",
                  summary: "List the inbox.",
                  operation: "threads.list",
                  input: input({ query: { type: "object" } }),
                },
                {
                  method: "POST",
                  path: "/support/threads/:id/archive",
                  scope: "support:threads:archive",
                  summary: "Archive one.",
                  operation: "threads.archive",
                  input: input({ path: { type: "object" } }),
                },
              ],
            },
          ],
        }),
      );
      return;
    }
    response.end(JSON.stringify({ threads: [{ id: "t1" }] }));
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const { port } = worker.address() as AddressInfo;

  const keyFile = keyFilePath(CONNECTION, join(configDir, "keys"));
  await writeAgentKey(keyFile, key);
  await saveConnection(
    {
      project: join(projectDir, ".pithy", "mcp.jsonc"),
      user: join(configDir, "mcp-connections.json"),
      keys: join(configDir, "keys"),
    },
    {
      alias: "pithy-acme-prod",
      project: "acme",
      environment: "prod",
      connectionId: CONNECTION,
      workerUrl: `http://127.0.0.1:${port}`,
      basePath: "/control-plane",
      credential: { kind: "key", keyId: "mcp-e2e", issuer: "urn:pithy:mcp", keyFile },
      clients: [],
    },
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => worker.close(() => resolve()));
});

describe("pithy mcp serve", () => {
  test("a spawned server lists the live manifest's granted tools, and a call names the route's one scope", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: [bin, "mcp", "serve", "--connection", "pithy-acme-prod"],
      cwd: projectDir,
      env: { ...(process.env as Record<string, string>), PITHY_CONFIG_DIR: configDir },
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      // Granted: offered. `support:threads:archive` is withheld: absent, and nothing called its route to learn so.
      expect(tools.map((tool) => tool.name)).toEqual(["support_threads_list"]);
      expect(seen).toEqual([{ path: "/control-plane/manifest", scope: "manifest:read" }]);

      const result = await client.callTool({ name: "support_threads_list", arguments: { query: {} } });
      expect(result.isError).toBe(false);
      expect(seen.at(-1)).toEqual({ path: "/support/threads", scope: "support:threads:read" });
    } finally {
      await client.close();
    }
  }, 60_000);
});
