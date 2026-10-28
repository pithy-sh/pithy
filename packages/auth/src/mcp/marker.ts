// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { McpWiring } from "./host";

/**
 * How auth recognizes the MCP capability composed beside it, without importing it — the capability imports
 * auth's guard, so the reverse import would be a cycle. A name and the one field auth reads.
 */

/** The MCP capability's name. */
export const MCP_CAPABILITY_NAME = "mcp";

/** Is this the MCP capability? */
export function isMcpCapability(capability: Capability): capability is Capability & { readonly mcpWiring: McpWiring } {
  return capability.name === MCP_CAPABILITY_NAME && "mcpWiring" in capability;
}
