// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AppTool } from "@pithy-sh/core/src/mcp/tools";
import { describe, expect, test } from "vitest";
import { answer, listedTool, negotiatedVersion, RPC_ERRORS, type RpcHandlers, toolResult } from "./rpc";

const tool: AppTool = {
  name: "notes_notes_read",
  capability: "notes",
  operation: "notes.read",
  method: "GET",
  path: "/notes/:id",
  summary: "Read a note.",
  description: "Read a note.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  effect: null,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  power: undefined,
  scopes: [],
};

const calls: { name: string; args: Record<string, unknown> }[] = [];
const handlers: RpcHandlers = {
  server: { name: "pithy", version: "1.0.0" },
  tools: async () => [tool],
  call: async (called, args) => {
    calls.push({ name: called.name, args });
    return { status: 200, body: { text: "hello" } };
  },
};

describe("answer", () => {
  test("initialize names the version, the server and a tools capability", async () => {
    const reply = await answer(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      handlers,
    );
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pithy", version: "1.0.0" },
      },
    });
  });

  test("a notification gets no answer", async () => {
    expect(await answer({ jsonrpc: "2.0", method: "notifications/initialized" }, handlers)).toBeNull();
  });

  test("tools/list publishes the caller's tools", async () => {
    const reply = await answer({ jsonrpc: "2.0", id: "a", method: "tools/list" }, handlers);
    expect(reply?.result).toEqual({ tools: [listedTool(tool)] });
  });

  test("tools/call calls the tool with its arguments", async () => {
    const reply = await answer(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool.name, arguments: { path: { id: "n1" } } } },
      handlers,
    );
    expect(calls.at(-1)).toEqual({ name: tool.name, args: { path: { id: "n1" } } });
    expect(reply?.result).toMatchObject({ isError: false, structuredContent: { text: "hello" } });
  });

  test("a tool the caller was not offered is answered as one that does not exist", async () => {
    const reply = await answer(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "notes_notes_delete" } },
      handlers,
    );
    expect(reply?.error).toEqual({ code: RPC_ERRORS.invalidParams, message: "Unknown tool: notes_notes_delete." });
  });

  test("an unknown method is method-not-found", async () => {
    const reply = await answer({ jsonrpc: "2.0", id: 4, method: "resources/list" }, handlers);
    expect(reply?.error).toMatchObject({ code: RPC_ERRORS.methodNotFound });
  });

  test("ping answers an empty result", async () => {
    expect((await answer({ jsonrpc: "2.0", id: 5, method: "ping" }, handlers))?.result).toEqual({});
  });
});

describe("negotiatedVersion", () => {
  test("echoes a version this server speaks, and answers the newest otherwise", () => {
    expect(negotiatedVersion("2025-03-26")).toBe("2025-03-26");
    expect(negotiatedVersion("1999-01-01")).toBe("2025-06-18");
    expect(negotiatedVersion(undefined)).toBe("2025-06-18");
  });
});

describe("toolResult", () => {
  test("a refusal is an error result carrying the route's own body", () => {
    expect(toolResult({ status: 403, body: { error: { message: "No." } } })).toEqual({
      content: [{ type: "text", text: '{"error":{"message":"No."}}' }],
      structuredContent: { error: { message: "No." } },
      isError: true,
    });
  });

  test("a list is text only, because structured content is an object", () => {
    expect(toolResult({ status: 200, body: [1, 2] })).toEqual({
      content: [{ type: "text", text: "[1,2]" }],
      isError: false,
    });
  });
});

describe("listedTool", () => {
  test("titles the tool with its summary and carries the effect's annotations", () => {
    expect(listedTool(tool).annotations).toEqual({
      title: "Read a note.",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});
