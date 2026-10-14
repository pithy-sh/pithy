// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { asyncApiDocument, undescribedAsyncFields } from "@pithy-sh/core/src/asyncapi/document";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { multiplayer } from "../capability";
import { type GameModel, registerGameModel } from "../game/model";
import { MultiplayerSessionParams } from "../http/schemas";
import { ActionFrame, ErrorFrame, MULTIPLAYER_SOCKET_VERSIONS, StateFrame, StateRequestFrame } from "./frames";

/** An adopter's own game, registered the way an adopter's worker entry does, declaring both schemas. */
const coinFlip: GameModel = {
  kind: "test-coin-flip",
  config: z.object({}).describe("No rules."),
  state: z.object({ calls: z.record(z.string(), z.string()).describe("Each call.") }).describe("The calls."),
  action: z.object({ call: z.enum(["heads", "tails"]).describe("The side called.") }).describe("Call the coin."),
  view: z.object({ called: z.boolean().describe("Whether the viewer has called.") }).describe("A coin-flip view."),
  init: () => ({ calls: {} }),
  apply: (_ctx, state) => ({ state }),
  isComplete: () => false,
  resolve: () => ({ outcome: { scores: {}, winnerUserId: null, draw: true } }),
  redact: () => ({ called: false }),
};
registerGameModel(coinFlip);

const capability = multiplayer({
  games: [
    { key: "tic-tac-toe", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } },
    { key: "table", kind: "craps", mode: "table", players: 6, rules: { currency: "chips" } },
    { key: "coin", kind: "test-coin-flip", rules: {} },
  ],
});

describe("the multiplayer capability declares its socket", () => {
  test("one socket, at the path the routes mounted, verified like them, speaking the frames it parses with", () => {
    expect(capability.sockets).toHaveLength(1);
    const socket = capability.sockets?.[0];
    expect(socket?.path).toBe("/multiplayer/sessions/:id/socket");
    expect(socket?.verification).toEqual(["bearer", "session"]);
    expect(socket?.params).toBe(MultiplayerSessionParams);
    expect(socket?.versions).toEqual(MULTIPLAYER_SOCKET_VERSIONS);
    expect(socket?.send.map((message) => message.schema)).toEqual(expect.arrayContaining([StateFrame, ErrorFrame]));
    expect(socket?.receive.map((message) => message.schema)).toEqual([ActionFrame, StateRequestFrame]);
  });

  test("its path follows a custom base path", () => {
    const moved = multiplayer({
      games: [{ key: "tic-tac-toe", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } }],
      basePath: "/play",
    });
    expect(moved.sockets?.[0]?.path).toBe("/play/sessions/:id/socket");
  });

  test("every configured game's action and view is published — an adopter's own game included", () => {
    const schemas = capability.sockets?.[0]?.schemas ?? {};
    expect(Object.keys(schemas).sort()).toEqual([
      "coin.action",
      "coin.view",
      "table.action",
      "table.view",
      "tic-tac-toe.action",
      "tic-tac-toe.view",
    ]);
    expect(schemas["coin.action"]).toBe(coinFlip.action);
    expect(schemas["coin.view"]).toBe(coinFlip.view);
  });

  test("the AsyncAPI document built from it describes every field", () => {
    const document = asyncApiDocument({ title: "test", version: "0.0.0" }, [
      { tag: "multiplayer", sockets: capability.sockets ?? [] },
    ]);
    expect(Object.keys(document.channels)).toEqual(["multiplayerSession"]);
    expect(document.components.schemas["multiplayerSession.tic-tac-toe.view"]).toBeDefined();
    expect(undescribedAsyncFields(document)).toEqual([]);
  });
});
