// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { asyncApiDocument, socketGroupsOf, undescribedAsyncFields } from "../../asyncapi/document";
import { defineCapability, type PithyHonoEnv } from "../../capability/capability";
import { uncoveredParamRoutes } from "../../http/routeContract";
import { openApiDocument, undescribedFields, undescribedRoutes } from "../../openapi/document";
import type { PresenceDeclaration } from "../declaration";
import { registerPresenceRoutes } from "./routes";

/**
 * Presence's half of the route request contract: every route validates its params, says what it is and what
 * it returns, and every field it carries is described — and so does the room socket, for AsyncAPI. Built from
 * a real `defineCapability` declaration, mounted the way `createBackend` mounts it. No request is made.
 */
const presence: PresenceDeclaration = {
  basePath: "/support",
  ticketKey: "k",
  rooms: [{ kind: "support.thread", scope: "support:threads:read", activities: ["viewing", "replying"] }],
};

function makeApp(): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  registerPresenceRoutes(app, presence);
  return app;
}

describe("presence route contract", () => {
  test("mounts the ticket route and the socket under the declared base path, and nothing else", () => {
    expect(makeApp().routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining(["POST /support/presence/tickets", "GET /support/presence/rooms/:kind/:recordId"]),
    );
    expect(new Set(makeApp().routes.map((route) => route.path)).size).toBe(2);
  });

  test("every path param is validated", async () => {
    expect(await uncoveredParamRoutes(makeApp() as unknown as Hono<never>)).toEqual([]);
  });

  test("every route is described, and every field in the contract carries a description", () => {
    const groups = [{ tag: "support", routes: makeApp().routes }];
    expect(undescribedRoutes(groups)).toEqual([]);
    const document = openApiDocument({ title: "presence", version: "0" }, groups);
    expect(Object.keys(document.paths)).toEqual([
      "/support/presence/tickets",
      "/support/presence/rooms/{kind}/{recordId}",
    ]);
    expect(undescribedFields(document)).toEqual([]);
  });

  test("the room socket is declared on the capability and fully described for AsyncAPI", () => {
    const capability = defineCapability({
      name: "support",
      requiredBindings: [],
      adminRoutes: [
        { method: "GET", path: "/support/threads", scope: "support:threads:read", summary: "List threads." },
      ],
      presence,
    });
    const document = asyncApiDocument({ title: "presence", version: "0" }, socketGroupsOf([capability]));
    expect(document.channels.supportPresenceRooms).toEqual(
      expect.objectContaining({
        address: "/support/presence/rooms/{kind}/{recordId}",
        "x-pithy-subprotocols": { current: "pithy.presence.v1", previous: null },
      }),
    );
    expect(undescribedAsyncFields(document)).toEqual([]);
  });
});
