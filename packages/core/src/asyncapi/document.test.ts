// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import type { SocketChannel } from "../http/socket";
import { asyncApiDocument, socketGroupsOf, undescribedAsyncFields } from "./document";

const Room = z.object({ id: z.string().describe("The room's id.") }).describe("Which room.");
const State = z
  .object({ type: z.literal("state").describe("Always `state`."), turn: z.number().describe("Whose turn.") })
  .describe("The room's state.");
const Act = z
  .object({ type: z.literal("action").describe("Always `action`."), payload: z.unknown().describe("The move.") })
  .describe("A move.");
const Move = z.object({ col: z.number().describe("The column.") }).describe("A connect-n move.");

const ROOM: SocketChannel = {
  name: "gameRoom",
  path: "/game/rooms/:id/socket",
  summary: "Play in a room.",
  verification: ["bearer", "session"],
  params: Room,
  versions: { current: "pithy.game.v1", previous: null },
  send: [{ name: "state", summary: "The room, after any change.", schema: State }],
  receive: [
    { name: "action", summary: "Make a move.", schema: Act },
    { name: "ping", summary: "Keep the socket open.", text: "ping" },
  ],
  schemas: { "connect-n.action": Move },
};

const INFO = { title: "Test", version: "1.0.0" };

describe("asyncApiDocument", () => {
  const document = asyncApiDocument(INFO, [{ tag: "game", sockets: [ROOM] }]);

  test("is AsyncAPI 3.0 with one channel per socket, at its path as a template", () => {
    expect(document.asyncapi).toBe("3.0.0");
    expect(document.info).toEqual(INFO);
    expect(document.channels.gameRoom).toEqual(
      expect.objectContaining({
        address: "/game/rooms/{id}/socket",
        summary: "Play in a room.",
        parameters: { id: { description: "The room's id." } },
        tags: [{ name: "game" }],
        "x-pithy-verification": ["bearer", "session"],
        "x-pithy-subprotocols": { current: "pithy.game.v1", previous: null },
      }),
    );
  });

  test("one operation per direction, named from the Worker's side", () => {
    expect(document.operations["gameRoom.send"]).toEqual(
      expect.objectContaining({
        action: "send",
        channel: { $ref: "#/channels/gameRoom" },
        messages: [{ $ref: "#/channels/gameRoom/messages/gameRoom.send.state" }],
      }),
    );
    expect(document.operations["gameRoom.receive"]).toEqual(
      expect.objectContaining({ action: "receive", messages: [expect.anything(), expect.anything()] }),
    );
  });

  test("a JSON frame carries its schema, and a text frame its exact text", () => {
    expect(document.components.messages["gameRoom.send.state"]).toEqual(
      expect.objectContaining({
        contentType: "application/json",
        payload: expect.objectContaining({ type: "object" }),
      }),
    );
    expect(document.components.messages["gameRoom.receive.ping"]).toEqual(
      expect.objectContaining({ contentType: "text/plain", payload: expect.objectContaining({ const: "ping" }) }),
    );
  });

  test("the further schemas sit under the socket's name, beside the shared error", () => {
    expect(Object.keys(document.components.schemas).sort()).toEqual(["Error", "gameRoom.connect-n.action"]);
  });

  test("is fully described", () => {
    expect(undescribedAsyncFields(document)).toEqual([]);
  });
});

describe("undescribedAsyncFields", () => {
  test("names a frame field and a channel parameter that carry no description", () => {
    const loose: SocketChannel = {
      ...ROOM,
      params: z.object({ id: z.string() }).describe("Which room."),
      send: [{ name: "state", summary: "State.", schema: z.object({ turn: z.number() }).describe("State.") }],
      receive: [],
      schemas: {},
    };
    expect(undescribedAsyncFields(asyncApiDocument(INFO, [{ tag: "game", sockets: [loose] }]))).toEqual([
      { pointer: "/channels/gameRoom/parameters/id" },
      { pointer: "/components/messages/gameRoom.send.state/payload/properties/turn" },
    ]);
  });
});

describe("socketGroupsOf", () => {
  test("groups each capability's sockets under its name, and leaves out a capability with none", () => {
    const withSocket = defineCapability({ name: "game", requiredBindings: [], sockets: [ROOM] });
    const without = defineCapability({ name: "quiet", requiredBindings: [] });
    expect(socketGroupsOf([without, withSocket])).toEqual([{ tag: "game", sockets: [ROOM] }]);
  });
});
