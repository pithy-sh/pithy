// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { controlPlaneToolName } from "@pithy-sh/core/src/controlPlane/discovery/toolName";
import { appTools } from "@pithy-sh/core/src/mcp/tools";
import { describe, expect, test } from "vitest";
import { kitComposition } from "../openapi/kitDocument";

/**
 * **Every kit route that opts in as an app MCP tool, as published (`docs/AGENT-ACCESS.md` §4.1, §5).**
 *
 * A route is a tool only when its `describeRoute` says `tool`, and its name is `<capability>_<operation>` — the
 * same normalizer the control-plane server's tools go through. An agent references a tool by name, so once
 * published an operation is permanent, and the property is only true as a set: this table is every kit tool,
 * composed the way the kit's own contract is, and it fails when an operation is renamed, dropped, moved to another
 * route, given a different effect, or added without a row.
 *
 * **Adding a tool is adding a row.** Renaming one is not something this table permits.
 */
const PUBLISHED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  leaderboard: {
    "boards.list": "GET /leaderboard read",
    "top.read": "GET /leaderboard/:board/top read",
    "rank.read": "GET /leaderboard/:board/me read",
  },
  rating: {
    "standing.read": "GET /rating/games/:game/me read",
  },
  ledger: {
    "transactions.list": "GET /ledger/:currency/transactions read",
    "balance.read": "GET /ledger/:currency read",
  },
  support: {
    "feedback.write": "POST /support/feedback sends",
    "feedback.list": "GET /support/feedback read",
    "feedback.read": "GET /support/feedback/:id read",
  },
};

const tools = appTools(kitComposition().groups);

describe("the kit's app MCP tools", () => {
  test("every published operation names the route and effect it was published with", () => {
    const actual: Record<string, Record<string, string>> = {};
    for (const tool of tools) {
      actual[tool.capability] ??= {};
      (actual[tool.capability] as Record<string, string>)[tool.operation] =
        `${tool.method} ${tool.path} ${tool.effect ?? "read"}`;
    }
    expect(actual).toEqual(PUBLISHED);
  });

  test("every tool's name is <capability>_<operation> through the control-plane normalizer", () => {
    for (const tool of tools) expect(tool.name).toBe(controlPlaneToolName(tool.capability, tool.operation));
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });

  test("every tool carries the route's own summary and a JSON Schema object input", () => {
    for (const tool of tools) {
      expect(tool.summary.length, tool.name).toBeGreaterThan(0);
      expect(tool.inputSchema, tool.name).toMatchObject({ type: "object", additionalProperties: false });
    }
  });
});
