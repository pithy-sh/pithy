// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { testersWorkflows } from "../workflows/specs";
import { optInUrl, requireBaseUrl, TestersConfig } from "./config";

const BASE = { baseUrl: "https://api.example.test" };

describe("defaults", () => {
  test("takes an empty object and lands on Google Play's own numbers", () => {
    const config = TestersConfig.parse({});
    expect(config.cohortDefaults.targetSize).toBe(12);
    expect(config.cohortDefaults.windowDays).toBe(14);
    expect(config.basePath).toBe("/testers");
  });

  test("the roster cap defaults to a hundred as a management judgement, not a store limit", () => {
    // Play's closed-testing ceiling is 2,000 per email list; the widely-repeated 100 is the *internal*
    // track's cap and does not apply here. A hundred is the size of roster one person can chase.
    const config = TestersConfig.parse({});
    expect(config.cohortDefaults.maxRosterSize).toBe(100);
    expect(() => TestersConfig.parse({ cohortDefaults: { maxRosterSize: 2000 } })).not.toThrow();
    expect(() => TestersConfig.parse({ cohortDefaults: { maxRosterSize: 2001 } })).toThrow();
  });

  test("every survival prior and health weight has a default, so none has to be authored", () => {
    const config = TestersConfig.parse({});
    expect(config.survival.healthy).toBe(0.998);
    expect(config.survival.unknown).toBe(0.985);
    expect(config.healthPenalties.darkEightToTen).toBe(45);
    expect(config.healthCredits.engaged).toBe(10);
  });

  test("the daily pass is offset from the other capabilities' hosts", () => {
    // storage 03:00, secrets 03:00, payments 04:00. Four hosts in one account should not contend.
    // Asserted on the spec's own schedule as well as the config default, because the deployed cron is
    // derived from both: checking only the config field would still pass if the spec moved to 03:00.
    expect(TestersConfig.parse({}).snapshotHourUtc).toBe(5);
    expect(testersWorkflows.daily.schedule).toBe("0 5 * * *");
  });

  test("nudges default to a three-day cooldown and allow copy override", () => {
    const config = TestersConfig.parse({});
    expect(config.nudges.cooldownHours).toBe(72);
    expect(config.nudges.allowCopyOverride).toBe(true);
  });
});

describe("cross-field rules", () => {
  test("a target larger than the roster cap is refused", () => {
    // A cohort that can never reach target. The symptom otherwise is a forecast that is quietly
    // meaningless rather than a config that failed.
    expect(() => TestersConfig.parse({ ...BASE, cohortDefaults: { targetSize: 200, maxRosterSize: 100 } })).toThrow(
      /exceeds maxRosterSize/,
    );
  });

  test("a link expiring before the window closes is refused", () => {
    // Otherwise the opt-in route 400s for exactly the people you most need, live, with no clue why.
    expect(() => TestersConfig.parse({ ...BASE, optInLinkTtlDays: 7 })).toThrow(/shorter than windowDays/);
  });

  test("an active window as wide as the test window is refused", () => {
    // Every tester would read as active for the whole window and the early-warning signal would be dead.
    expect(() => TestersConfig.parse({ ...BASE, activeWithinDays: 14 })).toThrow(/must be shorter than windowDays/);
  });

  test("retention shorter than the window is refused", () => {
    // The chart would lose the beginning of the very cohort it is drawing.
    expect(() => TestersConfig.parse({ ...BASE, snapshotRetentionDays: 7 })).toThrow(/pruned out from under/);
  });

  test("the shipped defaults satisfy every one of those rules", () => {
    expect(() => TestersConfig.parse({})).not.toThrow();
  });
});

describe("bounds", () => {
  test("a survival probability outside (0,1] is refused", () => {
    expect(() => TestersConfig.parse({ survival: { healthy: 0 } })).toThrow();
    expect(() => TestersConfig.parse({ survival: { healthy: 1.2 } })).toThrow();
    expect(() => TestersConfig.parse({ survival: { healthy: 1 } })).not.toThrow();
  });

  test("basePath must be rooted, so a relative mount cannot silently produce a broken link", () => {
    expect(() => TestersConfig.parse({ basePath: "testers" })).toThrow();
  });

  test("baseUrl must be an absolute URL", () => {
    expect(() => TestersConfig.parse({ baseUrl: "/api" })).toThrow();
  });
});

describe("building the opt-in URL", () => {
  test("joins the origin, the mount point, and the token", () => {
    expect(optInUrl(TestersConfig.parse(BASE), "abc.def")).toBe("https://api.example.test/testers/opt-in/abc.def");
  });

  test("tolerates a trailing slash on the configured origin", () => {
    const config = TestersConfig.parse({ baseUrl: "https://api.example.test/" });
    expect(optInUrl(config, "t")).toBe("https://api.example.test/testers/opt-in/t");
  });

  test("follows a moved basePath", () => {
    const config = TestersConfig.parse({ ...BASE, basePath: "/beta" });
    expect(optInUrl(config, "t")).toBe("https://api.example.test/beta/opt-in/t");
  });

  test("an unset baseUrl raises the capability's own error with the action attached", () => {
    // Rather than producing a relative link that lands in an inbox and goes nowhere.
    expect(() => requireBaseUrl(TestersConfig.parse({}))).toThrow(/Invitations cannot be sent yet/);
  });
});
