// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { describe, expect, test } from "vitest";
import { DEFAULT_DASHBOARD_ORIGIN } from "./contract";
import { resolveDashboardOrigin } from "./origin";

/**
 * Which dashboard a command talks to — `#614`.
 *
 * `status --verify` built its client from `--origin` alone, so omitting the flag sent it to
 * `app.pithy.sh` to ask about a connection registered against a self-hosted one. It could not reach it,
 * and reported that the *connection* needed reconnecting. The row it printed two lines below the error
 * held the address it should have used.
 */

const CONNECTION = {
  id: "5b0f5a4a-1cf6-4a8e-9a06-3b1f1a2c3d4e",
  environment: "staging",
  issuer: "https://staging.app.pithy.sh",
  workerUrl: "https://staging.app.pithy.sh",
  basePath: "/control-plane",
  managementOrigin: "https://staging.app.pithy.sh",
  scopes: [],
  keys: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as ControlPlaneConnection;

describe("the origin a dashboard command talks to", () => {
  test("a connection is asked about at the dashboard it was registered against", () => {
    expect(resolveDashboardOrigin({ connection: CONNECTION })).toEqual({
      origin: "https://staging.app.pithy.sh",
      source: "recorded",
    });
  });

  test("the flag overrides, which is how a moved dashboard is re-pointed", () => {
    expect(resolveDashboardOrigin({ flag: "https://moved.example", connection: CONNECTION })).toEqual({
      origin: "https://moved.example",
      source: "flag",
    });
  });

  test("a connection registered before the column existed falls back to its issuer", () => {
    // Every row written by a released CLI is this shape. The issuer is what that dashboard signs as,
    // which is not the same fact as where its API answers — near enough to ask, and why the recorded
    // origin exists rather than reading this forever.
    const older = { ...CONNECTION, managementOrigin: null } as unknown as ControlPlaneConnection;

    expect(resolveDashboardOrigin({ connection: older })).toEqual({
      origin: "https://staging.app.pithy.sh",
      source: "issuer",
    });
  });

  test("nothing registered is the hosted dashboard, which is where a first connect goes", () => {
    expect(resolveDashboardOrigin({ connection: null })).toEqual({
      origin: DEFAULT_DASHBOARD_ORIGIN,
      source: "default",
    });
  });

  test("the flag wins before anything is registered, so a first connect reaches a self-hosted one", () => {
    expect(resolveDashboardOrigin({ flag: "https://self.example", connection: null })).toEqual({
      origin: "https://self.example",
      source: "flag",
    });
  });

  test("a trailing slash is not a different dashboard", () => {
    expect(resolveDashboardOrigin({ flag: "https://moved.example/", connection: null }).origin).toBe(
      "https://moved.example",
    );
  });

  test("the flag re-points only when it names somewhere else", () => {
    // What decides whether the recorded origin is rewritten. Same address, no write — a `status` that
    // rewrote a row every time somebody typed the flag would record a change that did not happen.
    expect(resolveDashboardOrigin({ flag: "https://staging.app.pithy.sh", connection: CONNECTION })).toEqual({
      origin: "https://staging.app.pithy.sh",
      source: "flag",
    });
  });
});
