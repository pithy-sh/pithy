// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { z } from "zod";

/**
 * **Whether this Worker's MCP endpoint is open to every signed-in user (`docs/AGENT-ACCESS.md` §4).**
 *
 * The endpoint is closed by default: composing `mcp()` means choosing a floor — a power, an entitlement, or
 * `"signed-in"`. The last is a legitimate decision, and an endpoint that lets any signed-in user drive an agent
 * against the application is one the adopter should see stated on every run, the way a declined binding is recorded
 * as a decision rather than left as a gap. So `pithy doctor` says which floor is in force. It reports and never
 * fails the exit: an open endpoint is a choice, not a fault.
 */

/** What `doctor` learned about one Worker's MCP endpoint. */
export const AgentEndpointHealth = z
  .object({
    composed: z.boolean().describe("Whether this Worker composes the mcp capability at all."),
    open: z
      .boolean()
      .nullable()
      .describe("True when the endpoint admits every signed-in user. Null when nothing is composed."),
    floor: z.string().nullable().describe("The floor in force, in one line. Null when nothing is composed."),
  })
  .describe("This Worker's MCP endpoint and the floor it admits callers at. Reported; never fails the exit.");
export type AgentEndpointHealth = z.infer<typeof AgentEndpointHealth>;

/** The floor a composed mcp capability reports, read without importing it. */
function floorReportOf(capability: Capability): { open: boolean; line: string } | undefined {
  const report = (capability as { floorReport?: unknown }).floorReport;
  if (typeof report !== "object" || report === null) return undefined;
  const { open, line } = report as { open?: unknown; line?: unknown };
  return typeof open === "boolean" && typeof line === "string" ? { open, line } : undefined;
}

/** Read one Worker's composition for its MCP endpoint. Pure; never throws. */
export function agentEndpointHealth(capabilities: readonly Capability[]): AgentEndpointHealth {
  for (const capability of capabilities) {
    const report = floorReportOf(capability);
    if (report !== undefined) return { composed: true, open: report.open, floor: report.line };
  }
  return { composed: false, open: null, floor: null };
}
