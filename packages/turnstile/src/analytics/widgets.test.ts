// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { TURNSTILE_EVENTS } from "@pithy-sh/cloudflare/src/analytics/datasets";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import { TurnstileConfig, type TurnstileConfigInput } from "../config/config";
import { TurnstileWidgetsResponse } from "../http/responses";
import { TURNSTILE_TEST_KEYS } from "../provision/testKeys";
import { readWidgets, type WidgetSource } from "./widgets";

const DAY = 86_400_000;
const now = new Date("2026-10-18T12:00:00.000Z");
const LIMITS = { enabled: true, maxDuration: 2_764_800, notOlderThan: 7_948_800, maxPageSize: 10_000 };

const pass = TURNSTILE_TEST_KEYS.sitekey.visiblePass;
const sitekeys = { dev: pass, staging: pass, prod: "0x4AAAAreal" };

function source(overrides: Partial<WidgetSource> = {}): WidgetSource {
  return {
    datasetLimits: vi.fn(async () => ({ [TURNSTILE_EVENTS]: LIMITS })),
    turnstileEvents: vi.fn(
      async () =>
        new Map([
          [
            "0x4AAAAreal",
            new Map([
              ["challenge_issued", 10],
              ["challenge_non_interactive_solved", 9],
            ]),
          ],
        ]),
    ),
    ...overrides,
  };
}

function deps(
  environment: string | null,
  from: WidgetSource,
  config: TurnstileConfigInput = { widgets: { visible: { sitekeys } } },
) {
  return { config: TurnstileConfig.parse(config), environment, source: vi.fn(async () => from), now: () => now };
}

/** What a read threw, as a PithyError. */
async function failure(run: Promise<unknown>): Promise<PithyError> {
  return (await run.catch((error) => error)) as PithyError;
}

describe("readWidgets (#731)", () => {
  test("a real widget reports its sitekey and its outcomes, read from Cloudflare filtered by that sitekey", async () => {
    const from = source();
    const report = await readWidgets(deps("prod", from), {});
    expect(TurnstileWidgetsResponse.parse(report)).toEqual(report);
    expect(report.environment).toBe("prod");
    expect(report.since).toBe(new Date(now.getTime() - 30 * DAY).toISOString());
    expect(report.until).toBe(now.toISOString());
    expect(report.widgets).toEqual([
      {
        state: "reported",
        mode: "visible",
        sitekey: "0x4AAAAreal",
        testKey: false,
        outcomes: {
          issued: 10,
          solved: 9,
          unsolved: 1,
          solveRate: 0.9,
          siteverify: { passed: 0, refused: 0 },
          events: [
            { eventType: "challenge_issued", count: 10 },
            { eventType: "challenge_non_interactive_solved", count: 9 },
          ],
        },
      },
    ]);
    expect(from.turnstileEvents).toHaveBeenCalledWith({
      since: new Date(now.getTime() - 30 * DAY),
      until: now,
      siteKeys: ["0x4AAAAreal"],
    });
  });

  test("a real widget Cloudflare counted nothing for reports zeros, because it was asked", async () => {
    const report = await readWidgets(deps("prod", source({ turnstileEvents: vi.fn(async () => new Map()) })), {});
    expect(report.widgets[0]).toMatchObject({ state: "reported", outcomes: { issued: 0, solveRate: null } });
  });

  test("a test-key environment is deliberately passing, and makes no analytics query at all", async () => {
    const d = deps("staging", source());
    const report = await readWidgets(d, {});
    expect(report.widgets).toEqual([
      {
        state: "test-key",
        mode: "visible",
        sitekey: pass,
        testKey: true,
        verdict: "passes",
        message:
          "This is Cloudflare's always-pass test key, so every challenge here passes. That is deliberate: a test runner cannot solve a live widget.",
      },
    ]);
    expect(d.source).not.toHaveBeenCalled();
  });

  test("a feature build reports the test key it resolves by default (#656)", async () => {
    const d = deps("feature", source());
    const report = await readWidgets(d, {});
    expect(report.widgets[0]).toMatchObject({ state: "test-key", sitekey: pass, verdict: "passes" });
    expect(d.source).not.toHaveBeenCalled();
  });

  test("an environment with no sitekey reports the widget unconfigured, and asks nothing", async () => {
    const d = deps("prod", source(), { widgets: { visible: { sitekeys: { ...sitekeys, prod: "" } } } });
    const report = await readWidgets(d, {});
    expect(report.widgets).toEqual([
      {
        state: "unconfigured",
        mode: "visible",
        message: "No sitekey is stated for prod, so this widget renders nowhere here.",
      },
    ]);
    expect(d.source).not.toHaveBeenCalled();
  });

  test("a Worker that names no environment has no sitekey in force, and says why", async () => {
    const report = await readWidgets(deps(null, source()), {});
    expect(report.environment).toBeNull();
    expect(report.widgets[0]).toEqual({
      state: "unconfigured",
      mode: "visible",
      message: "This Worker names no environment, so no sitekey is in force.",
    });
  });

  test("both widgets are reported, visible first, in one query for the real ones", async () => {
    const from = source();
    const report = await readWidgets(
      deps("prod", from, {
        widgets: { visible: { sitekeys }, invisible: { sitekeys: { ...sitekeys, prod: "0x4BBBBreal" } } },
      }),
      {},
    );
    expect(report.widgets.map((w) => [w.mode, w.state])).toEqual([
      ["visible", "reported"],
      ["invisible", "reported"],
    ]);
    expect(from.turnstileEvents).toHaveBeenCalledTimes(1);
    expect(from.turnstileEvents).toHaveBeenCalledWith(
      expect.objectContaining({ siteKeys: ["0x4AAAAreal", "0x4BBBBreal"] }),
    );
  });

  test("since and until set the window", async () => {
    const from = source();
    const since = new Date("2026-10-01T00:00:00.000Z");
    const until = new Date("2026-10-08T00:00:00.000Z");
    const report = await readWidgets(deps("prod", from), { since, until });
    expect(report.since).toBe(since.toISOString());
    expect(from.turnstileEvents).toHaveBeenCalledWith({ since, until, siteKeys: ["0x4AAAAreal"] });
  });

  test("a window past retention is a named refusal, read from the dataset's own settings", async () => {
    const run = readWidgets(deps("prod", source()), { since: new Date(now.getTime() - 120 * DAY) });
    const error = await failure(run);
    expect(error.payload.code).toBe("turnstile/analytics_window");
    expect(error.payload.message).toBe(
      "That window starts 120 days ago. Cloudflare keeps Turnstile events for 92 days.",
    );
  });

  test("a window that ends before it starts is refused", async () => {
    const error = await failure(
      readWidgets(deps("staging", source()), { since: now, until: new Date(now.getTime() - DAY) }),
    );
    expect(error.payload.code).toBe("turnstile/analytics_window");
  });

  test("a dataset Cloudflare does not serve to the account is a named refusal, never an empty result", async () => {
    for (const limits of [{}, { [TURNSTILE_EVENTS]: { ...LIMITS, enabled: false } }]) {
      const from = source({ datasetLimits: vi.fn(async () => limits) });
      const error = await failure(readWidgets(deps("prod", from), {}));
      expect(error.payload.code).toBe("turnstile/analytics_unavailable");
      expect(from.turnstileEvents).not.toHaveBeenCalled();
    }
  });
});
