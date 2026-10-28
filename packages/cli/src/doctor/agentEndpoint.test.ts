// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { auth, mcp } from "@pithy-sh/auth/src/index";
import { describe, expect, test } from "vitest";
import { agentEndpointHealth } from "./agentEndpoint";

const base = () => auth({ baseURL: "https://app.example.com" });

describe("agentEndpointHealth", () => {
  test("says nothing is composed when the Worker composes no mcp capability", () => {
    expect(agentEndpointHealth([base()])).toEqual({ composed: false, open: null, floor: null });
  });

  test("says the endpoint is open to every signed-in user when that is the floor", () => {
    expect(agentEndpointHealth([base(), mcp({ floor: "signed-in" })])).toEqual({
      composed: true,
      open: true,
      floor: "open to every signed-in user",
    });
  });

  test("names a power or entitlement floor, and says it is not open", () => {
    expect(agentEndpointHealth([base(), mcp({ floor: { power: "agents:use" } })])).toEqual({
      composed: true,
      open: false,
      floor: "open only to callers whose role holds agents:use",
    });
    expect(agentEndpointHealth([mcp({ floor: { entitlement: "pro" } })]).floor).toBe(
      "open only to callers holding the pro entitlement",
    );
  });
});
