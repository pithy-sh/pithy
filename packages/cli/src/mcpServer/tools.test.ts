// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ControlPlaneManifest } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { kindAnnotations } from "@pithy-sh/core/src/mcp/annotations";
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
            kind: "sends",
            summary: "Answer the customer.",
            operation: "threads.reply",
            input: input({ path: { type: "object" }, body: { type: "object" } }),
          },
          {
            method: "GET",
            path: "/support/threads",
            scope: "support:threads:read",
            kind: "reads",
            summary: "List the inbox.",
            operation: "threads.list",
            input: input({ query: { type: "object" } }),
          },
          {
            method: "GET",
            path: "/support/replies",
            scope: "support:threads:read",
            kind: "reads",
            summary: "Canned replies.",
          },
          {
            method: "GET",
            path: "/support/x",
            scope: "support:threads:read",
            kind: "reads",
            summary: "No input.",
            operation: "x",
          },
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
    expect(reply?.description).toBe("Sends a message to somebody. Answer the customer.");
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

/**
 * A manifest granting one route of every kind, one scoped route from a Worker too old to state its kind, and two
 * scopeless routes that take no input: a `GET` and a `POST`.
 */
function kindsManifest() {
  const route = (operation: string, scope: string | null, kind?: string, method = "POST") => ({
    method,
    path: `/acme/${operation}`,
    scope,
    ...(kind === undefined ? {} : { kind }),
    summary: `Do ${operation}.`,
    operation,
    input: scope === null ? input() : input({ body: { type: "object" } }),
  });
  const routes = [
    route("ping", null, undefined, "GET"),
    route("flush", null),
    route("reading", "acme:reading", "reads"),
    route("writing", "acme:writing", "writes"),
    route("sending", "acme:sending", "sends"),
    route("charging", "acme:charging", "charges"),
    route("deleting", "acme:deleting", "deletes"),
    route("rotating", "acme:rotating", "credentials"),
    route("older", "acme:older"),
  ];
  return ControlPlaneManifest.parse({
    environment: "prod",
    connectionId: "5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11",
    version: null,
    grantedScopes: ["manifest:read", ...routes.flatMap((entry) => (entry.scope === null ? [] : [entry.scope]))],
    capabilities: [{ name: "acme", version: "1.0.0", adminRoutes: routes }],
  });
}

describe("a tool's kind", () => {
  const tools = new Map(offeredTools(kindsManifest()).map((tool) => [tool.name, tool]));

  test.each([
    ["acme_reading", "reads", { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
    ["acme_writing", "writes", { readOnlyHint: false, destructiveHint: false }],
    ["acme_sending", "sends", { readOnlyHint: false, destructiveHint: false }],
    ["acme_charging", "charges", { readOnlyHint: false, destructiveHint: true }],
    ["acme_deleting", "deletes", { readOnlyHint: false, destructiveHint: true }],
    ["acme_rotating", "credentials", { readOnlyHint: false, destructiveHint: true }],
  ] as const)("%s is %s, and its annotations say so", (name, kind, hints) => {
    const tool = tools.get(name);
    expect(tool?.kind).toBe(kind);
    expect(tool?.annotations).toMatchObject(hints);
    expect(tool?.annotations).toEqual(kindAnnotations(kind));
  });

  test("only a read claims to be idempotent", () => {
    const idempotent = [...tools.values()].filter((tool) => tool.annotations.idempotentHint === true);
    expect(idempotent.map((tool) => tool.name).sort()).toEqual(["acme_ping", "acme_reading"]);
  });

  test("the description leads with the kind in plain words, then the route's summary", () => {
    expect(tools.get("acme_charging")?.description).toBe("Charges money. Do charging.");
    expect(tools.get("acme_rotating")?.description).toBe("Mints, rotates or revokes a credential. Do rotating.");
    expect(tools.get("acme_reading")?.description).toBe("Reads data and changes nothing. Do reading.");
  });

  test("a scopeless GET is a read", () => {
    expect(tools.get("acme_ping")?.kind).toBe("reads");
    expect(tools.get("acme_ping")?.annotations.readOnlyHint).toBe(true);
  });

  test("a scopeless route that is not a GET is treated as the most restrictive", () => {
    const flush = tools.get("acme_flush");
    expect(flush?.kind).toBe("credentials");
    expect(flush?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(flush?.annotations.idempotentHint).not.toBe(true);
    expect(flush?.description).toBe("Mints, rotates or revokes a credential. Do flush.");
  });

  test("a scoped route that states no kind is treated as the most restrictive", () => {
    expect(tools.get("acme_older")?.kind).toBe("credentials");
    expect(tools.get("acme_older")?.annotations.destructiveHint).toBe(true);
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
