// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test } from "vitest";
import {
  connectionAlias,
  findConnection,
  listConnections,
  type McpConnectionRecord,
  removeConnection,
  type StorePaths,
  saveConnection,
} from "./connections";

const base = {
  project: "acme",
  connectionId: "5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11",
  workerUrl: "https://acme-prod.acme.workers.dev",
  basePath: "/control-plane",
};

const keyTemplate: McpConnectionRecord = {
  ...base,
  alias: "pithy-acme-prod",
  environment: "prod",
  credential: { kind: "key", keyId: "mcp-1", issuer: "urn:pithy:mcp", keyFile: "/set/in/beforeEach.jwk" },
  clients: [{ client: "claude-code", scope: "user" }],
};

const trustRecord: McpConnectionRecord = {
  ...base,
  alias: "pithy-acme-staging",
  environment: "staging",
  credential: { kind: "oidc", trustId: "trust-1", audience: base.workerUrl, source: { kind: "github" } },
  clients: [{ client: "claude-code", scope: "project" }],
};

let paths: StorePaths;
let keyRecord: McpConnectionRecord;
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pithy-mcp-store-"));
  paths = {
    project: join(root, "project", ".pithy", "mcp.jsonc"),
    user: join(root, "config", "mcp-connections.json"),
    keys: join(root, "config", "keys"),
  };
  // A key record names `<keys>/<connectionId>.jwk` and nothing else, or it is refused on read.
  keyRecord = {
    ...keyTemplate,
    credential: {
      kind: "key",
      keyId: "mcp-1",
      issuer: "urn:pithy:mcp",
      keyFile: join(paths.keys, `${base.connectionId}.jwk`),
    },
  };
});

describe("connectionAlias", () => {
  test("is pithy-<project>-<env>, so two environments are two entries", () => {
    expect(connectionAlias("acme", "prod")).toBe("pithy-acme-prod");
    expect(connectionAlias("acme", "staging")).toBe("pithy-acme-staging");
  });

  test("a trust's is pithy-<project>-<env>-ci, so a developer's key and CI's trust never share one", () => {
    expect(connectionAlias("acme", "prod", "oidc")).toBe("pithy-acme-prod-ci");
    expect(connectionAlias("acme", "prod", "key")).toBe("pithy-acme-prod");
  });
});

describe("the two stores", () => {
  test("a key's record goes to the operator's store, 0600", async () => {
    expect(await saveConnection(paths, keyRecord)).toBe("user");
    if (process.platform !== "win32") expect((await stat(paths.user)).mode & 0o777).toBe(0o600);
    expect(await findConnection(paths, "pithy-acme-prod")).toEqual({ record: keyRecord, scope: "user" });
  });

  test("a trust's record goes to the project, commented, so CI finds it in the checkout", async () => {
    expect(await saveConnection(paths, trustRecord)).toBe("project");
    const text = await readFile(paths.project, "utf8");
    expect(text.startsWith("// Control-plane MCP connections for CI")).toBe(true);
    expect(text).not.toMatch(/token"\s*:/);
    expect(await findConnection(paths, "pithy-acme-staging")).toEqual({ record: trustRecord, scope: "project" });
  });

  test("lists both, the project's first, and removes one without touching the other", async () => {
    await saveConnection(paths, keyRecord);
    await saveConnection(paths, trustRecord);
    expect((await listConnections(paths)).map((found) => found.record.alias)).toEqual([
      "pithy-acme-staging",
      "pithy-acme-prod",
    ]);
    expect(await removeConnection(paths, "user", "pithy-acme-prod")).toBe(true);
    expect(await removeConnection(paths, "user", "pithy-acme-prod")).toBe(false);
    expect((await listConnections(paths)).map((found) => found.record.alias)).toEqual(["pithy-acme-staging"]);
  });

  test("an unknown alias is null", async () => {
    expect(await findConnection(paths, "pithy-nope-dev")).toBeNull();
  });

  test("a store that does not parse is refused rather than overwritten", async () => {
    await mkdir(join(paths.user, ".."), { recursive: true });
    await writeFile(paths.user, "{ not json");
    const refusal = await saveConnection(paths, keyRecord).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PithyError);
    expect(await readFile(paths.user, "utf8")).toBe("{ not json");
  });
});

/** Write a store by hand, the way a cloned repository or an edited file arrives — not through `saveConnection`. */
async function plant(path: string, records: Record<string, McpConnectionRecord>): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ connections: records }));
}

describe("reading a store binds it to its credential kind", () => {
  test("a key record in the project's store is refused, naming the file — a checkout cannot sign with the operator's key", async () => {
    await plant(paths.project, { [keyRecord.alias]: keyRecord });
    const refusal = await findConnection(paths, keyRecord.alias).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PithyError);
    expect((refusal as PithyError).payload.message).toContain(paths.project);
    await expect(listConnections(paths)).rejects.toBeInstanceOf(PithyError);
  });

  test("a trust record in the operator's store is refused", async () => {
    await plant(paths.user, { [trustRecord.alias]: trustRecord });
    await expect(findConnection(paths, trustRecord.alias)).rejects.toBeInstanceOf(PithyError);
  });

  test("a project record cannot shadow the operator's record under the same alias", async () => {
    await saveConnection(paths, keyRecord);
    const shadow: McpConnectionRecord = {
      ...trustRecord,
      alias: keyRecord.alias,
      workerUrl: "https://evil.example",
      credential: {
        kind: "oidc",
        trustId: "x",
        audience: "x",
        source: { kind: "env", variable: "CLOUDFLARE_API_TOKEN" },
      },
    };
    await plant(paths.project, { [shadow.alias]: shadow });
    const refusal = await findConnection(paths, keyRecord.alias).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PithyError);
    expect((refusal as PithyError).payload.message).toContain(keyRecord.alias);
  });

  test("a key record naming a file outside the keys directory is refused", async () => {
    for (const keyFile of [
      "/home/someone/.ssh/id_ed25519",
      join(paths.keys, "another-connection.jwk"),
      join(paths.keys, "..", `${base.connectionId}.jwk`),
    ]) {
      await plant(paths.user, {
        [keyRecord.alias]: { ...keyRecord, credential: { ...keyRecord.credential, keyFile } as never },
      });
      await expect(findConnection(paths, keyRecord.alias)).rejects.toBeInstanceOf(PithyError);
    }
  });

  test("a connection id that walks out of the keys directory is refused", async () => {
    const connectionId = "../../escape";
    const keyFile = join(paths.keys, `${connectionId}.jwk`);
    await plant(paths.user, {
      [keyRecord.alias]: { ...keyRecord, connectionId, credential: { ...keyRecord.credential, keyFile } as never },
    });
    await expect(findConnection(paths, keyRecord.alias)).rejects.toBeInstanceOf(PithyError);
  });
});
