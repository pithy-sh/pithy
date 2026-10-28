// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "./capability";

describe("defineCapability", () => {
  test("normalizes bindings — optional defaults to false", () => {
    const cap = defineCapability({
      name: "turnstile",
      requiredBindings: [{ type: "secret", name: "TURNSTILE_SECRET" }],
      middleware: [],
    });
    expect(cap.name).toBe("turnstile");
    expect(cap.requiredBindings[0]?.name).toBe("TURNSTILE_SECRET");
    expect(cap.requiredBindings[0]?.optional).toBe(false);
  });

  test("validates bindings at define time", () => {
    expect(() => defineCapability({ name: "bad", requiredBindings: [{ type: "secret", name: "" }] })).toThrow();
  });

  test("supports a config-only capability", () => {
    const cap = defineCapability({
      name: "example",
      config: z.object({ enabled: z.boolean() }),
      requiredBindings: [],
    });
    expect(cap.config?.parse({ enabled: true })).toEqual({ enabled: true });
  });
});

describe("defineCapability with presence rooms (#815)", () => {
  const presence = {
    basePath: "/support",
    ticketKey: "k",
    rooms: [{ kind: "support.thread", scope: "support:threads:read", activities: ["viewing"] as [string] }],
  };
  // The read its room kind joins with: a room's scope is one the capability already gates a GET with.
  const adminRoutes = [
    {
      method: "GET" as const,
      path: "/support/threads",
      scope: "support:threads:read",
      kind: "reads" as const,
      summary: "List threads.",
    },
  ];

  test("a capability that declares room kinds requires the room's binding and serves the room's socket", () => {
    const cap = defineCapability({
      name: "support",
      requiredBindings: [{ type: "d1", name: "DB" }],
      adminRoutes,
      presence,
    });
    expect(cap.requiredBindings).toContainEqual({
      type: "durable_object",
      name: "PRESENCE_ROOMS",
      className: "PresenceRoom",
      classModule: "@pithy-sh/core/src/presence/durableObject",
      optional: false,
    });
    expect(cap.sockets?.map((socket) => [socket.name, socket.path])).toEqual([
      ["supportPresenceRooms", "/support/presence/rooms/:kind/:recordId"],
    ]);
  });

  test("declares the binding once, however it is already spelled", () => {
    const cap = defineCapability({
      name: "support",
      requiredBindings: [
        {
          type: "durable_object",
          name: "PRESENCE_ROOMS",
          className: "PresenceRoom",
          classModule: "@pithy-sh/core/src/presence/durableObject",
        },
      ],
      adminRoutes,
      presence,
    });
    expect(cap.requiredBindings.filter((binding) => binding.name === "PRESENCE_ROOMS")).toHaveLength(1);
  });

  test("a capability that declares none, or an empty list, gains nothing", () => {
    for (const cap of [
      defineCapability({ name: "support", requiredBindings: [] }),
      defineCapability({ name: "support", requiredBindings: [], presence: { ...presence, rooms: [] } }),
    ]) {
      expect(cap.requiredBindings).toEqual([]);
      expect(cap.sockets).toBeUndefined();
    }
  });

  test("a room kind behind a scope none of its admin routes requires is refused where it is written", () => {
    expect(() => defineCapability({ name: "support", requiredBindings: [], presence })).toThrow(
      /declares presence rooms/,
    );
  });

  test("a room kind under another capability's name is refused where it is written", () => {
    expect(() => defineCapability({ name: "ledger", requiredBindings: [], presence })).toThrow(
      /declares presence rooms/,
    );
  });
});
