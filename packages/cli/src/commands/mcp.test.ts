// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fakeConnectionRegistry } from "../test-utils/connectionRegistry";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";

/**
 * `pithy mcp`'s command bodies, end to end below the registry (#723). The orchestration is held in
 * `mcpServer/lifecycle.test.ts`; this holds what each subcommand writes under `--json` to its published payload,
 * and the argument rules it settles before a project is read.
 */

const registry = fakeConnectionRegistry();

vi.mock("./dashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dashboard")>()),
  withRegistry: async (_options: unknown, work: (r: typeof registry) => Promise<unknown>) => work(registry),
}));
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: "acme" }),
  projectCloudflareAccount: async () => null,
}));
vi.mock("../dashboard/principal", () => ({ requireRegisteringPrincipal: async () => "ops@acme.example" }));
vi.mock("../dashboard/resolveTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard/resolveTarget")>()),
  resolveConnectTarget: async () => ({
    worker: { capabilities: [] },
    workerUrl: "https://acme-prod.acme.workers.dev",
    basePath: "/control-plane",
    source: "test",
  }),
  composedForGrant: async () => [],
  connectSentence: async () => "pithy dashboard connect --env prod",
}));

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-mcp-command-"));
  vi.spyOn(process, "cwd").mockReturnValue(projectDir);
  process.env.PITHY_CONFIG_DIR = await mkdtemp(join(tmpdir(), "pithy-mcp-config-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await registry.remove();
});

const connectArgs = ["--env", "prod", "--purpose", "Support triage.", "--scope", "manifest:read", "--json"];

describe("pithy mcp connect --json", () => {
  test("registers a key and writes one line its payload describes", async () => {
    const written = await runCaptured("mcp connect", connectArgs);
    await expectConforms("mcp connect", written);
    const line = JSON.parse(written.join(""));
    expect(line).toMatchObject({
      command: "mcp.connect",
      alias: "pithy-acme-prod",
      credential: "key",
      status: "registered",
    });
    expect(registry.current()?.actorKind).toBe("agent");
  });

  test("--update replaces the grant with exactly the scopes given", async () => {
    await runCaptured("mcp connect", connectArgs);
    const written = await runCaptured("mcp connect", ["--env", "prod", "--update", "--scope", "keys:rotate", "--json"]);
    await expectConforms("mcp connect", written);
    expect(registry.current()?.scopes).toEqual(["keys:rotate"]);
  });
});

describe("pithy mcp status --json", () => {
  test("lists each connection with its key file and mode", async () => {
    await runCaptured("mcp connect", connectArgs);
    const written = await runCaptured("mcp status", ["--json"]);
    await expectConforms("mcp status", written);
    const [connection] = JSON.parse(written.join("")).connections;
    expect(connection).toMatchObject({ alias: "pithy-acme-prod", credential: "key", keyProblem: null });
    if (process.platform !== "win32") expect(connection.keyMode).toBe("0600");
  });
});

describe("pithy mcp disconnect --json", () => {
  test("revokes the key and says so; a second run finds nothing, which is not an error", async () => {
    await runCaptured("mcp connect", connectArgs);
    const written = await runCaptured("mcp disconnect", ["--connection", "pithy-acme-prod", "--json"]);
    await expectConforms("mcp disconnect", written);
    expect(JSON.parse(written.join(""))).toMatchObject({ connected: true, revoked: true, keyFileRemoved: true });
    const again = await runCaptured("mcp disconnect", ["--connection", "pithy-acme-prod", "--json"]);
    expect(JSON.parse(again.join(""))).toMatchObject({ connected: false });
  });
});
