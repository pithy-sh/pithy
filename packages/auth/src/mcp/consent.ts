// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type AppTool, mayCall, type ToolCaller } from "@pithy-sh/core/src/mcp/tools";
import type { ConsentCapability, ConsentScope, ConsentView } from "./http/responses";
import { MCP_SCOPES } from "./provider";

/**
 * What the consent screen shows, built from the tools and the signer (`docs/AGENT-ACCESS.md` §4.3).
 *
 * **The unit of consent is a capability, not a tool.** One row per composed capability the user can reach, each
 * listing what the client will then be able to do, in the capability's own words — each route's own summary —
 * counted: *3 of 5 operations*. Per-tool consent cannot work, because a tool list changes without a deploy; a
 * capability changes when a Worker deploys, which is a cadence a grant can survive.
 *
 * **Never a permission the user does not hold.** A row lists only the operations the signer's role reaches, and a
 * capability with none is not listed at all. What the role withholds is a count, never a name — the screen says
 * *two need a role you do not hold*, which discloses nothing a list would not.
 *
 * **Informational.** Nothing on it is selectable: one decision, *let this client act as you in this application*,
 * with these rows as its consequence. The role is the ceiling either way, and the screen says so.
 *
 * **Codes, never sentences.** Everything here is data the screen words in the reader's language; a sentence built
 * on the server would reach a Spanish screen in English.
 */

/** Why a scope the client asked for is not granted: the role does not reach it, or no such permission exists. */
export type NotGrantedReason = ConsentScope["reason"];

/** The client, as the screen presents it. */
export interface ConsentClient {
  readonly id: string;
  readonly reportedName: string | null;
  readonly reportedUri: string | null;
  readonly redirectUri: string;
}

/** The capability rows: only what the caller reaches, grouped, counted. */
export function consentCapabilities(tools: readonly AppTool[], caller: ToolCaller): ConsentCapability[] {
  const rows = new Map<string, { reachable: AppTool[]; total: number }>();
  for (const tool of tools) {
    const row = rows.get(tool.capability) ?? { reachable: [], total: 0 };
    row.total += 1;
    if (mayCall(tool, caller)) row.reachable.push(tool);
    rows.set(tool.capability, row);
  }
  return [...rows.entries()]
    .filter(([, row]) => row.reachable.length > 0)
    .map(([capability, row]) => ({
      capability,
      operations: row.reachable.map((tool) => ({ tool: tool.name, summary: tool.summary, effect: tool.effect })),
      reachable: row.reachable.length,
      total: row.total,
      effects: {
        writes: row.reachable.filter((tool) => tool.effect === "writes").length,
        sends: row.reachable.filter((tool) => tool.effect === "sends").length,
        charges: row.reachable.filter((tool) => tool.effect === "charges").length,
        deletes: row.reachable.filter((tool) => tool.effect === "deletes").length,
      },
    }));
}

/**
 * Each scope the client asked for, and what approving does with it. **A request the user cannot give is explained,
 * not hidden**: the client named it, so saying it is not granted discloses nothing, and leaving it off would let the
 * user believe they had granted it.
 */
export function consentScopes(
  requested: readonly string[],
  tools: readonly AppTool[],
  caller: ToolCaller,
): ConsentScope[] {
  return requested.map((scope) => {
    if ((MCP_SCOPES as readonly string[]).includes(scope)) return { scope, granted: true, reason: null };
    const tool = tools.find((entry) => entry.name === scope);
    if (tool !== undefined && !mayCall(tool, caller)) return { scope, granted: false, reason: "role" };
    return { scope, granted: false, reason: "unknown" };
  });
}

/** Everything the consent screen shows. */
export function consentView(input: {
  readonly client: ConsentClient;
  readonly tools: readonly AppTool[];
  readonly caller: ToolCaller;
  readonly requestedScopes: readonly string[];
}): ConsentView {
  return {
    client: input.client,
    capabilities: consentCapabilities(input.tools, input.caller),
    requested: consentScopes(input.requestedScopes, input.tools, input.caller),
  };
}
