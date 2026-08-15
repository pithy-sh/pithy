// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the run's `globalSetup` guarantees, pinned — because a fixture report was added beside a debris
 * sweep that had two hard-won properties, and "I did not mean to break it" is not a gate.
 *
 * The sweep's guarantee, in the words of the defect that produced it: **it runs once per run, before
 * collection, and no suite's gate can switch it off.** Vitest runs no hooks inside a
 * `describe.skipIf(true)`, so the reaper that lived in a `beforeAll` was gated on exactly the credential
 * whose absence lets debris accumulate. Two things follow, and both are asserted here: the sweep runs
 * whenever credentials exist, and a sweep that fails does not fail the run.
 *
 * The report adds a third, and it is the same argument pointed the other way: **it runs even when the
 * credentials do not exist.** A contributor with no account is precisely who needs to be told why the run
 * went quiet, so the explanation must not be gated on the thing it is explaining.
 */

const reportFixtureEstate = vi.hoisted(() => vi.fn());
const resolveFixture = vi.hoisted(() => vi.fn());
const fixtureValue = vi.hoisted(() => vi.fn());
const loadIntegrationCreds = vi.hoisted(() => vi.fn());
const reapAllStaleTestResources = vi.hoisted(() => vi.fn());

vi.mock("./fixtures", () => ({ reportFixtureEstate, resolveFixture, fixtureValue }));
vi.mock("./harness", () => ({ loadIntegrationCreds }));
vi.mock("./reap", () => ({ reapAllStaleTestResources }));

const { default: setup } = await import("./integrationSetup");

const NO_CREDS = { accountId: "", apiToken: "", secretsStoreId: "", r2: null, hasCreds: false };
const CREDS = { accountId: "acct", apiToken: "tok", secretsStoreId: "", r2: null, hasCreds: true };

beforeEach(() => {
  vi.clearAllMocks();
  reapAllStaleTestResources.mockResolvedValue([]);
  resolveFixture.mockReturnValue({ ready: false });
});

describe("the run's globalSetup", () => {
  it("reports the fixture estate even with no credentials, so the silence is explained", async () => {
    loadIntegrationCreds.mockReturnValue(NO_CREDS);
    await setup();
    expect(reportFixtureEstate).toHaveBeenCalledOnce();
    expect(reapAllStaleTestResources).not.toHaveBeenCalled();
  });

  it("reports before it reads credentials, so the report can never be gated on them", async () => {
    const order: string[] = [];
    reportFixtureEstate.mockImplementation(() => {
      order.push("report");
      return [];
    });
    loadIntegrationCreds.mockImplementation(() => {
      order.push("creds");
      return NO_CREDS;
    });
    await setup();
    expect(order).toEqual(["report", "creds"]);
  });

  it("still sweeps once per run when credentials are present", async () => {
    loadIntegrationCreds.mockReturnValue(CREDS);
    await setup();
    expect(reapAllStaleTestResources).toHaveBeenCalledOnce();
    expect(reapAllStaleTestResources).toHaveBeenCalledWith(CREDS, { emailRoutingZoneId: undefined });
  });

  it("hands the sweep a zone only when the fixture named one", async () => {
    // The one zone-scoped kind. A sweep that guessed would be editing mail delivery on a domain nobody
    // pointed it at, so an absent fixture must reach the plan as `undefined` rather than as a default.
    loadIntegrationCreds.mockReturnValue(CREDS);
    resolveFixture.mockReturnValue({ ready: true });
    fixtureValue.mockReturnValue("zone-id");
    await setup();
    expect(reapAllStaleTestResources).toHaveBeenCalledWith(CREDS, { emailRoutingZoneId: "zone-id" });
  });

  it("does not fail the run when the sweep fails", async () => {
    loadIntegrationCreds.mockReturnValue(CREDS);
    reapAllStaleTestResources.mockRejectedValue(new Error("token has no D1 scope"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(setup()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stale test resources could not be swept"));
    warn.mockRestore();
  });
});
