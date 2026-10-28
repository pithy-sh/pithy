// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ToolEffect } from "@pithy-sh/core/src/http/routeSpec";
import type { AppTool } from "@pithy-sh/core/src/mcp/tools";
import { toolAnnotations } from "@pithy-sh/core/src/mcp/tools";
import { describe, expect, test } from "vitest";
import { consentCapabilities, consentScopes, consentView } from "./consent";
import { ConsentView } from "./http/responses";

function tool(capability: string, operation: string, power?: string, effect: ToolEffect | null = null): AppTool {
  return {
    name: `${capability}_${operation}`,
    capability,
    operation,
    method: effect === null ? "GET" : "POST",
    path: `/${capability}/${operation}`,
    summary: `Do ${operation}.`,
    description: `Do ${operation}.`,
    inputSchema: {},
    effect,
    annotations: toolAnnotations(effect),
    power,
    scopes: [],
  };
}

const tools = [
  tool("support", "reply", "support:reply", "sends"),
  tool("support", "archive", "support:triage", "writes"),
  tool("support", "reclassify", "support:triage", "writes"),
  tool("support", "purge", "support:admin", "deletes"),
  tool("support", "export", "support:admin"),
  tool("billing", "refund", "billing:manage", "charges"),
];
const agent = { roleAllows: (power: string) => ["support:reply", "support:triage"].includes(power), scopes: [] };

describe("consentCapabilities", () => {
  test("one row per capability the user reaches, listing only what their role allows, counted", () => {
    expect(consentCapabilities(tools, agent)).toEqual([
      {
        capability: "support",
        operations: [
          { tool: "support_reply", summary: "Do reply.", effect: "sends" },
          { tool: "support_archive", summary: "Do archive.", effect: "writes" },
          { tool: "support_reclassify", summary: "Do reclassify.", effect: "writes" },
        ],
        reachable: 3,
        total: 5,
        effects: { writes: 2, sends: 1, charges: 0, deletes: 0 },
      },
    ]);
  });

  test("never lists a permission the user does not hold, by name", () => {
    const listed = JSON.stringify(consentCapabilities(tools, agent));
    expect(listed).not.toContain("purge");
    expect(listed).not.toContain("export");
    expect(listed).not.toContain("billing");
  });

  test("with no organization in force, only tools behind no power are offered", () => {
    expect(consentCapabilities([...tools, tool("notes", "read")], { roleAllows: null, scopes: [] })).toEqual([
      expect.objectContaining({ capability: "notes", reachable: 1, total: 1 }),
    ]);
  });
});

describe("consentScopes", () => {
  test("grants the one scope, and explains a requested one the role cannot carry rather than hiding it", () => {
    expect(consentScopes(["mcp", "offline_access", "billing_refund", "everything"], tools, agent)).toEqual([
      { scope: "mcp", granted: true, reason: null },
      { scope: "offline_access", granted: true, reason: null },
      { scope: "billing_refund", granted: false, reason: "role" },
      { scope: "everything", granted: false, reason: "unknown" },
    ]);
  });
});

describe("consentView", () => {
  test("is one decision: nothing in it is a selection, and nothing in it is a sentence", () => {
    const view = consentView({
      client: {
        id: "c1",
        verifiedHost: null,
        reportedName: "POWERPLAY Official Sync",
        reportedUri: null,
        redirectUri: "http://127.0.0.1:9/cb",
      },
      tools,
      caller: agent,
      requestedScopes: ["mcp"],
    });
    expect(ConsentView.parse(view)).toEqual(view);
    expect(view.client.redirectUri).toBe("http://127.0.0.1:9/cb");
    // The name is carried as reported, under a key that says so; the one verified key holds a host, and a
    // dynamically registered client has none.
    expect(Object.keys(view.client)).toEqual(["id", "verifiedHost", "reportedName", "reportedUri", "redirectUri"]);
    expect(view.client.verifiedHost).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/selected|checked/i);
    // The screen words every part of it in the reader's language, so the server sends no prose of its own.
    expect(Object.keys(view)).toEqual(["client", "capabilities", "requested"]);
  });

  test("a metadata-document client carries its verified host beside its reported name, never in place of it", () => {
    const view = consentView({
      client: {
        id: "https://client.example.com/oauth/client.json",
        verifiedHost: "client.example.com",
        reportedName: "POWERPLAY Official Sync",
        reportedUri: null,
        redirectUri: "http://127.0.0.1:9/cb",
      },
      tools,
      caller: agent,
      requestedScopes: ["mcp"],
    });
    expect(ConsentView.parse(view)).toEqual(view);
    expect(view.client.verifiedHost).toBe("client.example.com");
    expect(view.client.reportedName).toBe("POWERPLAY Official Sync");
  });
});
