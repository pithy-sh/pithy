// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AppTool } from "@pithy-sh/core/src/mcp/tools";
import { z } from "zod";

/**
 * The MCP protocol the endpoint speaks: streamable HTTP, stateless, JSON responses.
 *
 * **Four methods and one notification**, because that is the whole of a tools-only server: `initialize`, `ping`,
 * `tools/list`, `tools/call`, and `notifications/initialized`. Each POST carries one JSON-RPC message and is
 * answered in the response body, so there is no session to keep, no stream to hold open, and nothing an isolate
 * has to remember between requests — the caller is re-verified on every one. A notification is answered `202`
 * with no body.
 *
 * **Pure.** The handlers are handed in; this module decides what a message means and what its answer looks like,
 * and nothing about who is asking.
 */

/** The protocol versions this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;

/** One JSON-RPC 2.0 message, as a client sends it. */
export const RpcMessage = z
  .object({
    jsonrpc: z.literal("2.0").describe("Always `2.0`."),
    id: z
      .union([z.string(), z.number()])
      .optional()
      .describe("The request's id. Absent on a notification, which gets no answer."),
    method: z.string().min(1).describe("The method called, e.g. `tools/list`."),
    params: z.record(z.string(), z.unknown()).optional().describe("The method's parameters."),
  })
  .describe("One JSON-RPC 2.0 request or notification.");
export type RpcMessage = z.infer<typeof RpcMessage>;

/** JSON-RPC's own error codes, the ones this server answers with. */
export const RPC_ERRORS = { methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

/** A tool as `tools/list` publishes it. */
export interface ListedTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: AppTool["annotations"] & { readonly title: string };
}

/** What a tool call came back with. */
export interface CallOutcome {
  /** The route's status. */
  readonly status: number;
  /** The route's body, parsed when it was JSON. */
  readonly body: unknown;
}

/** What the endpoint hands the protocol: the caller's tools, and a way to call one. */
export interface RpcHandlers {
  /** The server's name and version, for `initialize`. */
  readonly server: { readonly name: string; readonly version: string };
  /** The tools this caller may call. */
  readonly tools: () => Promise<readonly AppTool[]>;
  /** Call one, as the caller. */
  readonly call: (tool: AppTool, args: Record<string, unknown>) => Promise<CallOutcome>;
}

/** A JSON-RPC answer, or `null` for a notification. */
export type RpcAnswer = { jsonrpc: "2.0"; id: string | number; result?: unknown; error?: unknown } | null;

/** A tool as `tools/list` publishes it. */
export function listedTool(tool: AppTool): ListedTool {
  return {
    name: tool.name,
    title: tool.summary,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.summary, ...tool.annotations },
  };
}

/** The version to answer `initialize` with: the client's, when this server speaks it, or the newest. */
export function negotiatedVersion(requested: unknown): string {
  return typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSIONS[0];
}

/** A call's outcome as an MCP tool result: the body as text, and as structured content when it is an object. */
export function toolResult(outcome: CallOutcome): Record<string, unknown> {
  const text = typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body ?? null);
  const structured =
    outcome.body !== null && typeof outcome.body === "object" && !Array.isArray(outcome.body)
      ? { structuredContent: outcome.body }
      : {};
  return { content: [{ type: "text", text }], ...structured, isError: outcome.status >= 400 };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Answer one message. */
export async function answer(message: RpcMessage, handlers: RpcHandlers): Promise<RpcAnswer> {
  if (message.id === undefined) return null;
  const id = message.id;
  const ok = (result: unknown): RpcAnswer => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string): RpcAnswer => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (message.method) {
    case "initialize":
      return ok({
        protocolVersion: negotiatedVersion(message.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: handlers.server,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: (await handlers.tools()).map(listedTool) });
    case "tools/call": {
      const name = message.params?.name;
      // A tool the caller may not call is answered exactly as one that does not exist: the list it was offered
      // never named it, so saying anything more would disclose it (§4.1).
      const tool = (await handlers.tools()).find((entry) => entry.name === name);
      if (tool === undefined) return fail(RPC_ERRORS.invalidParams, `Unknown tool: ${String(name)}.`);
      return ok(toolResult(await handlers.call(tool, record(message.params?.arguments))));
    }
    default:
      return fail(RPC_ERRORS.methodNotFound, `Method not found: ${message.method}.`);
  }
}
