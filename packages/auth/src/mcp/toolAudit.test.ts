// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AuditAction, AuditEvent, type AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import { describe, expect, test, vi } from "vitest";
import {
  MAX_CLIENT_NAME,
  MAX_TOOL_NAME,
  McpAuditActions,
  recordToolCall,
  requestedToolName,
  type ToolCallRecord,
  toolCallEvent,
  toolCallOutcome,
} from "./toolAudit";

const actor = {
  userId: "u1",
  sessionId: "s1",
  clientId: "c1",
  clientReportedName: "POWERPLAY Official Sync",
  tenant: "org-1",
};
const correlation = { requestId: "ray-1", ip: "203.0.113.9", userAgent: "agent/1.0" };

function answered(status: number): ToolCallRecord {
  return {
    actor,
    correlation,
    tool: "notes_notes_write",
    durationMs: 12,
    result: { kind: "answered", status, responseBytes: 34, arguments: { body: { type: "object", keys: [] } } },
  };
}

describe("McpAuditActions", () => {
  test("the tool call is mcp/tool_call, a valid domain/reason action", () => {
    expect(McpAuditActions.toolCall).toBe("mcp/tool_call");
    expect(AuditAction.parse(McpAuditActions.toolCall)).toBe("mcp/tool_call");
  });
});

describe("requestedToolName", () => {
  test("keeps a string name, bounded, and drops anything else", () => {
    expect(requestedToolName("notes_notes_read")).toBe("notes_notes_read");
    expect(requestedToolName("x".repeat(MAX_TOOL_NAME + 50))).toHaveLength(MAX_TOOL_NAME);
    expect(requestedToolName(42)).toBeNull();
    expect(requestedToolName(undefined)).toBeNull();
  });
});

describe("toolCallOutcome", () => {
  test("a route's success is success, its refusal denied, and any other error failure", () => {
    expect([200, 201, 204, 302].map(toolCallOutcome)).toEqual(["success", "success", "success", "success"]);
    expect([401, 403].map(toolCallOutcome)).toEqual(["denied", "denied"]);
    expect([400, 404, 409, 500, 502].map(toolCallOutcome)).toEqual([
      "failure",
      "failure",
      "failure",
      "failure",
      "failure",
    ]);
  });
});

describe("toolCallEvent", () => {
  test("bounds the client's reported name, which the client chose and may make as long as it likes", () => {
    const long = { ...answered(200), actor: { ...actor, clientReportedName: "n".repeat(40_000) } };
    expect(toolCallEvent(long).metadata?.clientReportedName).toHaveLength(MAX_CLIENT_NAME);
    const none = { ...answered(200), actor: { ...actor, clientReportedName: null } };
    expect(toolCallEvent(none).metadata?.clientReportedName).toBeNull();
  });

  test("names the user as the actor, the agent as its kind, and the client as reported", () => {
    const event = AuditEvent.parse(toolCallEvent(answered(200)));
    expect(event).toMatchObject({
      action: "mcp/tool_call",
      outcome: "success",
      severity: "info",
      actorType: "user",
      actorId: "u1",
      actorKind: "agent",
      sessionId: "s1",
      tenant: "org-1",
      requestId: "ray-1",
      ip: "203.0.113.9",
      userAgent: "agent/1.0",
      resourceType: "mcp_tool",
      resourceId: "notes_notes_write",
    });
    expect(event.metadata).toEqual({
      tool: "notes_notes_write",
      clientId: "c1",
      clientReportedName: "POWERPLAY Official Sync",
      status: 200,
      durationMs: 12,
      responseBytes: 34,
      arguments: { body: { type: "object", keys: [] } },
    });
  });

  test("a route's refusal is denied, at warning", () => {
    expect(toolCallEvent(answered(403))).toMatchObject({ outcome: "denied", severity: "warning" });
  });

  test("a route's error is failure", () => {
    expect(toolCallEvent(answered(500))).toMatchObject({ outcome: "failure", severity: "info" });
  });

  test("a tool the caller was never offered is denied with why, and no route status", () => {
    const event = toolCallEvent({
      actor,
      correlation,
      tool: "notes_notes_write",
      durationMs: 3,
      result: { kind: "refused", reason: "withheld" },
    });
    expect(event).toMatchObject({ outcome: "denied", severity: "warning", resourceId: "notes_notes_write" });
    expect(event.metadata).toEqual({
      tool: "notes_notes_write",
      clientId: "c1",
      clientReportedName: "POWERPLAY Official Sync",
      status: null,
      durationMs: 3,
      responseBytes: null,
      refused: "withheld",
    });
  });

  test("a call naming no tool at all is denied, with the tool null", () => {
    const event = toolCallEvent({
      actor: { ...actor, tenant: null, clientReportedName: null },
      correlation,
      tool: null,
      durationMs: 1,
      result: { kind: "refused", reason: "unknown" },
    });
    expect(AuditEvent.parse(event)).toMatchObject({ outcome: "denied", tenant: null, resourceId: null });
    expect(event.metadata).toMatchObject({ tool: null, clientReportedName: null, refused: "unknown" });
  });
});

describe("recordToolCall", () => {
  test("hands the built event to the emitter", async () => {
    const seen: AuditEventInput[] = [];
    await recordToolCall(
      async (event) => void seen.push(event),
      async () => toolCallEvent(answered(200)),
    );
    expect(seen).toHaveLength(1);
  });

  test("an emitter that throws, or an event that cannot be built, does not reach the caller", async () => {
    await expect(
      recordToolCall(
        async () => {
          throw new Error("D1 down");
        },
        async () => toolCallEvent(answered(200)),
      ),
    ).resolves.toBeUndefined();
    await expect(
      recordToolCall(
        async () => {},
        async () => {
          throw new Error("lookup failed");
        },
      ),
    ).resolves.toBeUndefined();
  });

  test("with no audit capability composed, nothing is built and nothing is written", async () => {
    const build = vi.fn(async () => toolCallEvent(answered(200)));
    await recordToolCall(noopEmit, build);
    expect(build).not.toHaveBeenCalled();
  });
});
