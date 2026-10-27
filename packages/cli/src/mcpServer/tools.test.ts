// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ControlPlaneManifest } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { describe, expect, test } from "vitest";
import { callArguments, offeredTools } from "./tools";

const input = (properties: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  additionalProperties: false,
});

/** A manifest as a current Worker sends it, with one route of each kind a tool filter must tell apart. */
function manifest(granted: string[]) {
  return ControlPlaneManifest.parse({
    environment: "prod",
    connectionId: "5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11",
    version: null,
    grantedScopes: granted,
    capabilities: [
      {
        name: "controlplane",
        version: "0.13.0",
        adminRoutes: [
          {
            method: "GET",
            path: "/control-plane/ping",
            scope: null,
            summary: "Ping.",
            operation: "ping",
            input: input(),
          },
          {
            method: "POST",
            path: "/control-plane/presence/tickets",
            scope: null,
            summary: "Mint a ticket.",
            operation: "presence.tickets.mint",
            input: input({ body: { type: "object" } }),
          },
        ],
      },
      {
        name: "support",
        version: "0.9.0",
        adminRoutes: [
          {
            method: "POST",
            path: "/support/threads/:id/reply",
            scope: "support:threads:reply",
            summary: "Answer the customer.",
            operation: "threads.reply",
            input: input({ path: { type: "object" }, body: { type: "object" } }),
          },
          {
            method: "GET",
            path: "/support/threads",
            scope: "support:threads:read",
            summary: "List the inbox.",
            operation: "threads.list",
            input: input({ query: { type: "object" } }),
          },
          // From a Worker that predates #723: no operation, no input.
          { method: "GET", path: "/support/replies", scope: "support:threads:read", summary: "Canned replies." },
          { method: "GET", path: "/support/x", scope: "support:threads:read", summary: "No input.", operation: "x" },
        ],
      },
    ],
  });
}

describe("offeredTools", () => {
  test("a tool is offered when its scope is granted, named <capability>_<operation>, described by its summary", () => {
    const tools = offeredTools(manifest(["manifest:read", "support:threads:read", "support:threads:reply"]));
    expect(tools.map((tool) => tool.name)).toEqual([
      "controlplane_ping",
      "support_threads_reply",
      "support_threads_list",
    ]);
    const reply = tools.find((tool) => tool.name === "support_threads_reply");
    expect(reply?.description).toBe("Answer the customer.");
    expect(reply?.inputSchema).toEqual(input({ path: { type: "object" }, body: { type: "object" } }));
    expect(reply?.route).toEqual({
      method: "POST",
      path: "/support/threads/:id/reply",
      scope: "support:threads:reply",
    });
  });

  test("a withheld scope is absent, not offered and refused", () => {
    const names = offeredTools(manifest(["manifest:read", "support:threads:read"])).map((tool) => tool.name);
    expect(names).not.toContain("support_threads_reply");
    expect(names).toContain("support_threads_list");
  });

  test("a route with no operation or no input is not offered under a guessed name", () => {
    const names = offeredTools(manifest(["manifest:read", "support:threads:read"])).map((tool) => tool.name);
    expect(names.some((name) => name.includes("replies"))).toBe(false);
    expect(names).not.toContain("support_x");
  });

  test("a scopeless route is offered only when it takes nothing, and signs as the manifest read", () => {
    const tools = offeredTools(manifest(["manifest:read"]));
    expect(tools.map((tool) => tool.name)).toEqual(["controlplane_ping"]);
    expect(tools[0]?.route.scope).toBe("manifest:read");
  });
});

describe("callArguments", () => {
  test("splits the tool's one object into path, query and body", () => {
    expect(callArguments({ path: { id: "t1" }, query: { q: "x" }, body: { text: "hi" } })).toEqual({
      path: { id: "t1" },
      query: { q: "x" },
      body: { text: "hi" },
    });
  });

  test("drops parts that are absent or not objects", () => {
    expect(callArguments(undefined)).toEqual({});
    expect(callArguments({ path: "nope", query: [1] })).toEqual({});
  });
});
