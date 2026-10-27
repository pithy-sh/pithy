// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test } from "vitest";
import { type McpConnectionRecord, type StorePaths, saveConnection } from "./connections";
import { generateAgentKey, keyFilePath, writeAgentKey } from "./keyFile";
import { credentialFor, serveConnection } from "./serve";

const CONNECTION = "5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11";

let stores: StorePaths;
let keyFile: string;
let record: McpConnectionRecord;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pithy-mcp-serve-"));
  stores = {
    project: join(root, "repo", ".pithy", "mcp.jsonc"),
    user: join(root, "config", "mcp-connections.json"),
    keys: join(root, "config", "keys"),
  };
  keyFile = keyFilePath(CONNECTION, stores.keys);
  await writeAgentKey(keyFile, await generateAgentKey("mcp-1"));
  record = {
    alias: "pithy-acme-prod",
    project: "acme",
    environment: "prod",
    connectionId: CONNECTION,
    workerUrl: "https://acme-prod.acme.workers.dev",
    basePath: "/control-plane",
    credential: { kind: "key", keyId: "mcp-1", issuer: "urn:pithy:mcp", keyFile },
    clients: [],
  };
});

describe("serveConnection", () => {
  test("an alias neither store holds is refused, naming connect and status", async () => {
    const refusal = await serveConnection({ alias: "pithy-nope-dev", stores, version: "0" }).catch(
      (error: unknown) => error as PithyError,
    );
    expect((refusal as PithyError).payload.action).toContain("pithy mcp connect");
    expect((refusal as PithyError).payload.action).toContain("pithy mcp status");
  });

  test.runIf(process.platform !== "win32")("a key others can read is refused before the server starts", async () => {
    await saveConnection(stores, record);
    await chmod(keyFile, 0o640);
    const refusal = await serveConnection({ alias: record.alias, stores, version: "0" }).catch(
      (error: unknown) => error as PithyError,
    );
    expect((refusal as PithyError).payload.action).toBe(`Run chmod 600 ${keyFile}, then start the server again.`);
  });
});

describe("credentialFor", () => {
  test("a trust fetches its token at spawn, so a job without id-token: write fails there", async () => {
    const trust: McpConnectionRecord = {
      ...record,
      credential: { kind: "oidc", trustId: "trust-1", audience: record.workerUrl, source: { kind: "github" } },
    };
    const refusal = await credentialFor(trust, { workload: { env: {} } }).catch(
      (error: unknown) => error as PithyError,
    );
    expect((refusal as PithyError).payload.action).toContain("id-token: write");
  });

  test("a key signs as the connection's alias, under the key id and issuer the connection stores", async () => {
    const headers = await (await credentialFor(record)).headers("manifest:read", new Uint8Array(0));
    const claims = JSON.parse(
      Buffer.from((headers["pithy-control-plane"] as string).split(".")[1] as string, "base64url").toString(),
    );
    expect(claims).toMatchObject({
      sub: "pithy-acme-prod",
      iss: "urn:pithy:mcp",
      aud: CONNECTION,
      scope: "manifest:read",
    });
  });
});
