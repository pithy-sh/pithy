// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEventInput, AuditOutcome } from "@pithy-sh/core/src/audit/auditEvent";
import { type AuditEmit, noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { ArgumentClass } from "./argumentClass";

/**
 * The audit row an in-Worker MCP tool call writes (`docs/AGENT-ACCESS.md` §9).
 *
 * **Who acted.** The call ran under the user's authority, so the row is `actorType: "user"` with their id — and
 * `actorKind: "agent"`, the field control-plane rows already carry, so one filter finds every agent row on both
 * paths. The client is in `metadata`: its id, and its name as it reported itself, which nothing has verified.
 *
 * **What it cost.** The route's status, the wall time from receiving the call to answering it, and the size of the
 * route's response. CPU time is not readable per request in a Worker, so the row does not claim it.
 */

/** The action codes the MCP endpoint emits, under the `mcp` domain. */
export const McpAuditActions = {
  /**
   * One `tools/call`. Outcome `success`, `failure` when the route answered an error, or `denied` when the tool was
   * never offered to the caller or the route refused them.
   */
  toolCall: "mcp/tool_call",
} as const;

/** The longest tool name a row records. A name the caller made up is theirs to make as long as they like. */
export const MAX_TOOL_NAME = 128;

/** The longest client name a row records. The client chose its own name at registration. */
export const MAX_CLIENT_NAME = 128;

/** The tool a `tools/call` named, as a row records it: a string, bounded, or null. */
export function requestedToolName(name: unknown): string | null {
  return typeof name === "string" ? name.slice(0, MAX_TOOL_NAME) : null;
}

/** The outcome a route's status records: a refusal is `denied`, any other error `failure`. */
export function toolCallOutcome(status: number): AuditOutcome {
  if (status === 401 || status === 403) return "denied";
  return status >= 400 ? "failure" : "success";
}

/** Who made a call: the user, the session the token was minted under, and the client acting for them. */
export interface ToolCallActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly clientId: string;
  /** The client's name as it registered itself. Self-asserted; never verified. */
  readonly clientReportedName: string | null;
  /** The acting organization, or null where none is in force. */
  readonly tenant: string | null;
}

/** What ties the row to the rest of the request: the route's own rows carry the same `requestId`. */
export interface ToolCallCorrelation {
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** What came of a call: the route answered it, or it was never dispatched. */
export type ToolCallResult =
  | {
      readonly kind: "answered";
      readonly status: number;
      readonly responseBytes: number;
      readonly arguments: ArgumentClass;
    }
  /** `withheld`: a tool this app has that the caller's role was not offered. `unknown`: no such tool. */
  | { readonly kind: "refused"; readonly reason: "withheld" | "unknown" };

/** Everything one row is built from. */
export interface ToolCallRecord {
  readonly actor: ToolCallActor;
  readonly correlation: ToolCallCorrelation;
  /** The tool's name, or null when the call named none. */
  readonly tool: string | null;
  readonly durationMs: number;
  readonly result: ToolCallResult;
}

/** The audit event for one tool call. */
export function toolCallEvent(record: ToolCallRecord): AuditEventInput {
  const { actor, correlation, tool, durationMs, result } = record;
  const outcome = result.kind === "answered" ? toolCallOutcome(result.status) : "denied";
  const client = {
    clientId: actor.clientId,
    clientReportedName: actor.clientReportedName?.slice(0, MAX_CLIENT_NAME) ?? null,
  };
  const metadata =
    result.kind === "answered"
      ? {
          tool,
          ...client,
          status: result.status,
          durationMs,
          responseBytes: result.responseBytes,
          arguments: result.arguments,
        }
      : { tool, ...client, status: null, durationMs, responseBytes: null, refused: result.reason };
  return {
    action: McpAuditActions.toolCall,
    outcome,
    severity: outcome === "denied" ? "warning" : "info",
    actorType: "user",
    actorId: actor.userId,
    actorKind: "agent",
    sessionId: actor.sessionId,
    tenant: actor.tenant,
    resourceType: "mcp_tool",
    resourceId: tool,
    requestId: correlation.requestId,
    ip: correlation.ip,
    userAgent: correlation.userAgent,
    metadata,
  };
}

/**
 * Write one row, and never fail the call it records: the row is evidence of what happened, never part of making it
 * happen. With no audit capability composed the event is not even built, since building it reads the client's row.
 */
export async function recordToolCall(emit: AuditEmit, build: () => Promise<AuditEventInput>): Promise<void> {
  if (emit === noopEmit) return;
  try {
    await emit(await build());
  } catch {
    // The seam's own recorder swallows and logs its failures; this covers an emitter or a lookup that does not.
  }
}
