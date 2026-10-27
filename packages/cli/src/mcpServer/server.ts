// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ControlPlaneManifest } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { MANIFEST_READ_SCOPE } from "@pithy-sh/core/src/controlPlane/scope/scope";
import type { ControlPlaneCaller } from "./caller";
import { type ControlPlaneTool, callArguments, offeredTools } from "./tools";

/**
 * The control-plane MCP server (#723, `docs/AGENT-ACCESS.md` §3): one connection's Worker, as MCP tools.
 *
 * **Tools come from the live manifest, every time they are listed.** Environments run different versions, so this
 * server serves exactly what its one Worker declares now — a deploy that adds a route adds a tool at the next
 * `tools/list`, and one that removes it removes the tool. Nothing is cached across a list but the last answer,
 * which a call reads to find its route.
 *
 * **A call is a control-plane call and nothing else.** It names the route's one scope and presents the
 * connection's own credential; the Worker verifies it, refuses what the grant does not cover, and audits it as it
 * audits every call, with the connection's actor kind. A refusal comes back as a tool error carrying the Worker's
 * own message, so an agent reads why rather than guessing.
 */

/** Options for {@link controlPlaneMcpServer}. */
export interface ControlPlaneMcpServerOptions {
  /** The connection's Worker, behind its credential. */
  readonly caller: ControlPlaneCaller;
  /** Where the Worker mounts the seam — the manifest is `<basePath>/manifest`. */
  readonly basePath: string;
  /** The server's name, as a client lists it: the connection's alias. */
  readonly name: string;
  /** The CLI's version. */
  readonly version: string;
}

/** The Worker's `message` from a refusal body, or a sentence naming the status. */
function refusalMessage(status: number, body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : `The Worker answered ${status}.`;
}

/** Read the manifest and derive this connection's tools. */
export async function readTools(caller: ControlPlaneCaller, basePath: string): Promise<ControlPlaneTool[]> {
  const result = await caller.call({ method: "GET", path: `${basePath}/manifest`, scope: MANIFEST_READ_SCOPE });
  if (result.status !== 200) {
    throw new McpError(
      ErrorCode.InternalError,
      `The manifest could not be read: ${refusalMessage(result.status, result.body)}`,
    );
  }
  const manifest = ControlPlaneManifest.safeParse(result.body);
  if (!manifest.success) {
    throw new McpError(ErrorCode.InternalError, "The Worker's manifest did not parse, so no tool can be offered.");
  }
  return offeredTools(manifest.data);
}

/** Build the server. Connect it to a transport to serve. */
export function controlPlaneMcpServer(options: ControlPlaneMcpServerOptions): McpServer {
  const mcp = new McpServer({ name: options.name, version: options.version }, { capabilities: { tools: {} } });
  let listed = new Map<string, ControlPlaneTool>();

  const list = async () => {
    const tools = await readTools(options.caller, options.basePath);
    listed = new Map(tools.map((tool) => [tool.name, tool]));
    return tools;
  };

  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await list()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: "object" },
    })),
  }));

  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // A call before any list, or for a tool a deploy has since added, reads the manifest once more.
    const tool = listed.get(request.params.name) ?? (await list()).find((entry) => entry.name === request.params.name);
    if (tool === undefined) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `No tool called ${request.params.name} is offered on this connection.` },
        ],
      };
    }
    const result = await options.caller.call(tool.route, callArguments(request.params.arguments));
    const failed = result.status >= 400;
    return {
      isError: failed,
      content: [
        {
          type: "text" as const,
          text: failed ? refusalMessage(result.status, result.body) : JSON.stringify(result.body, null, 2),
        },
      ],
    };
  });

  return mcp;
}
