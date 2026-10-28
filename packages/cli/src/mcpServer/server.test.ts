// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import type { CallArguments, CallableRoute, CallResult, ControlPlaneCaller } from "./caller";
import { controlPlaneMcpServer } from "./server";

const input = (properties: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  additionalProperties: false,
});

const MANIFEST = {
  environment: "prod",
  connectionId: "5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11",
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
          kind: "reads",
          summary: "List the inbox.",
          operation: "threads.list",
          input: input({ query: { type: "object", properties: { q: { type: "string" } } } }),
        },
        {
          method: "POST",
          path: "/support/threads/:id/reply",
          scope: "support:threads:reply",
          kind: "sends",
          summary: "Answer the customer.",
          operation: "threads.reply",
          input: input({ path: { type: "object" }, body: { type: "object" } }),
        },
      ],
    },
  ],
};

/** A Worker that answers the manifest and one read, and records every call it was asked to make. */
function fakeWorker(answers: Record<string, CallResult> = {}) {
  const calls: { route: CallableRoute; args: CallArguments | undefined }[] = [];
  const caller: ControlPlaneCaller = {
    async call(route, args) {
      calls.push({ route, args });
      if (route.path === "/control-plane/manifest") return { status: 200, body: MANIFEST };
      return answers[`${route.method} ${route.path}`] ?? { status: 200, body: { threads: [] } };
    },
  };
  return { caller, calls };
}

async function connected(caller: ControlPlaneCaller) {
  const server = controlPlaneMcpServer({
    caller,
    basePath: "/control-plane",
    name: "pithy-acme-prod",
    version: "0.17.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("the control-plane MCP server", () => {
  test("a client lists the tools the live manifest offers this connection, each with its input", async () => {
    const worker = fakeWorker();
    const client = await connected(worker.caller);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["support_threads_list"]);
    expect(tools[0]?.description).toBe("Reads data and changes nothing. List the inbox.");
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object", properties: { query: { type: "object" } } });
  });

  test("a client reads each tool's kind from its annotations", async () => {
    const worker = fakeWorker();
    const client = await connected(worker.caller);
    const { tools } = await client.listTools();
    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("learning a tool is withheld costs one manifest read and no call to its route", async () => {
    const worker = fakeWorker();
    const client = await connected(worker.caller);
    await client.listTools();
    expect(worker.calls.map((call) => `${call.route.scope} ${call.route.path}`)).toEqual([
      "manifest:read /control-plane/manifest",
    ]);
  });

  test("a call names the route's one scope, with the arguments split by part", async () => {
    const worker = fakeWorker();
    const client = await connected(worker.caller);
    await client.listTools();
    const result = await client.callTool({ name: "support_threads_list", arguments: { query: { q: "refund" } } });
    expect(result.isError).toBe(false);
    expect(worker.calls.at(-1)).toEqual({
      route: { method: "GET", path: "/support/threads", scope: "support:threads:read" },
      args: { query: { q: "refund" } },
    });
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "")).toEqual({ threads: [] });
  });

  test("a withheld tool cannot be called by name either", async () => {
    const worker = fakeWorker();
    const client = await connected(worker.caller);
    const result = await client.callTool({ name: "support_threads_reply", arguments: {} });
    expect(result.isError).toBe(true);
    expect(worker.calls.some((call) => call.route.path.includes("reply"))).toBe(false);
  });

  test("a Worker's refusal comes back as a tool error carrying its own message", async () => {
    const worker = fakeWorker({
      "GET /support/threads": {
        status: 403,
        body: { code: "controlplane/insufficient_scope", message: "Not granted." },
      },
    });
    const client = await connected(worker.caller);
    const result = await client.callTool({ name: "support_threads_list", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toBe("Not granted.");
  });
});
