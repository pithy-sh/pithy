// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import type { WorkerConfig } from "../project/config";
import { backendRails, defaultRail, parseRail, railsFor, resolveRails, type UiRailPrompt } from "./rails";

/** A Worker composing payments with exactly `rails` turned on, shaped the way the payments capability is. */
function withPayments(rails: Record<string, boolean>): WorkerConfig {
  const payments = Object.assign(defineCapability({ name: "payments", requiredBindings: [] }), {
    paymentsConfig: { rails },
  });
  return { capabilities: [payments] };
}

const SCOPE = { projectDir: "/project", workerDir: "/project/apps/api", worker: "api" };

/** The error a call throws, or a failed test. */
async function refusal(run: () => Promise<unknown>): Promise<PithyError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PithyError);
    return error as PithyError;
  }
  return expect.unreachable("expected a refusal");
}

describe("railsFor", () => {
  test("each platform takes its own store, any hosted rail, or none", () => {
    expect(railsFor("ios")).toEqual(["apple", "stripe", "lemonSqueezy", "paddle", "none"]);
    expect(railsFor("android")).toEqual(["google", "stripe", "lemonSqueezy", "paddle", "none"]);
    expect(railsFor("web")).toEqual(["stripe", "lemonSqueezy", "paddle", "none"]);
  });
});

describe("parseRail", () => {
  test("takes a rail the platform can sell through", () => {
    expect(parseRail("ios", "apple")).toBe("apple");
    expect(parseRail("android", "paddle")).toBe("paddle");
    expect(parseRail("web", "none")).toBe("none");
  });

  test("refuses another platform's store, listing the valid values", async () => {
    const error = await refusal(async () => parseRail("android", "apple"));
    expect(error.payload.code).toBe("validation/invalid_input");
    expect(error.payload.message).toBe('"apple" is not a rail android can sell through.');
    expect(error.payload.action).toBe("Pass --android-rail google, stripe, lemonSqueezy, paddle or none.");
  });

  test("refuses a store on the web, and a name that is no rail at all", async () => {
    expect((await refusal(async () => parseRail("web", "google"))).payload.action).toBe(
      "Pass --web-rail stripe, lemonSqueezy, paddle or none.",
    );
    expect((await refusal(async () => parseRail("ios", "venmo"))).payload.code).toBe("validation/invalid_input");
  });
});

describe("backendRails", () => {
  test("reads which rails the composed payments config turns on", () => {
    expect(backendRails(withPayments({ apple: true, stripe: true }))).toEqual({
      composed: true,
      enabled: { apple: true, google: false, stripe: true, lemonSqueezy: false, paddle: false },
    });
  });

  test("a Worker without payments enables nothing", () => {
    expect(backendRails({ capabilities: [] })).toEqual({
      composed: false,
      enabled: { apple: false, google: false, stripe: false, lemonSqueezy: false, paddle: false },
    });
  });
});

describe("defaultRail", () => {
  test("is the store on a phone and the first hosted rail on the web, when the backend enables them", () => {
    const backend = backendRails(withPayments({ apple: true, google: true, paddle: true, lemonSqueezy: true }));
    expect(defaultRail("ios", backend)).toBe("apple");
    expect(defaultRail("android", backend)).toBe("google");
    expect(defaultRail("web", backend)).toBe("lemonSqueezy");
  });

  test("is none wherever the backend enables no such rail, so a default is never refused", () => {
    const backend = backendRails(withPayments({ stripe: true }));
    expect(defaultRail("ios", backend)).toBe("none");
    expect(defaultRail("android", backend)).toBe("none");
    expect(defaultRail("web", backend)).toBe("stripe");
  });
});

describe("resolveRails", () => {
  const FULL = backendRails(withPayments({ apple: true, google: true, stripe: true }));

  test("no flag and no prompt takes the defaults", async () => {
    expect(await resolveRails({ flags: {}, backend: FULL, scope: SCOPE })).toEqual({
      ios: "apple",
      android: "google",
      web: "stripe",
    });
  });

  test("a flag decides outright, and no prompt is asked for that platform", async () => {
    const prompt = vi.fn(async () => "none" as const);
    const rails = await resolveRails({
      flags: { ios: "stripe", android: "none", web: "none" },
      backend: FULL,
      scope: SCOPE,
      prompt,
    });
    expect(rails).toEqual({ ios: "stripe", android: "none", web: "none" });
    expect(prompt).not.toHaveBeenCalled();
  });

  test("a human is offered only the rails the backend enables, starting from the default", async () => {
    const prompt = vi.fn<UiRailPrompt>(async ({ suggestion }) => suggestion);
    await resolveRails({ flags: {}, backend: FULL, scope: SCOPE, prompt });
    expect(prompt.mock.calls.map(([request]) => request)).toEqual([
      { platform: "ios", choices: ["apple", "stripe", "none"], suggestion: "apple" },
      { platform: "android", choices: ["google", "stripe", "none"], suggestion: "google" },
      { platform: "web", choices: ["stripe", "none"], suggestion: "stripe" },
    ]);
  });

  test("asks nothing when the backend composes no payments: every rail is none", async () => {
    const prompt = vi.fn();
    expect(
      await resolveRails({ flags: {}, backend: backendRails({ capabilities: [] }), scope: SCOPE, prompt }),
    ).toEqual({
      ios: "none",
      android: "none",
      web: "none",
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  test("a flagged rail the backend does not enable is refused by name, with the config key that turns it on", async () => {
    const error = await refusal(() => resolveRails({ flags: { web: "paddle" }, backend: FULL, scope: SCOPE }));
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(error.payload.message).toBe("The paddle rail isn't enabled in api's payments config.");
    expect(error.payload.action).toBe("Enable rails.paddle in apps/api/pithy.config.ts, or pass --web-rail none.");
  });

  test("a flagged rail on a backend with no payments is refused with the add fix", async () => {
    const error = await refusal(() =>
      resolveRails({ flags: { ios: "apple" }, backend: backendRails({ capabilities: [] }), scope: SCOPE }),
    );
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(error.payload.message).toBe("The apple rail needs the payments capability, and api doesn't compose it.");
    expect(error.payload.action).toContain("rails.apple");
    expect(error.payload.action).toContain("--ios-rail none");
  });

  test("a kept rail another platform's store owns is refused, naming the key and the valid values", async () => {
    const error = await refusal(() =>
      resolveRails({
        flags: {},
        backend: FULL,
        scope: SCOPE,
        kept: { ios: "apple", android: "apple", web: "stripe" },
      }),
    );
    expect(error.payload.code).toBe("validation/invalid_input");
    expect(error.payload.message).toBe('rails.android is "apple", which is not a rail android can sell through.');
    expect(error.payload.action).toBe(
      "Set it to google, stripe, lemonSqueezy, paddle or none, or pass --android-rail with one of them.",
    );
  });

  test("an invalid flag is refused before any prompt is asked", async () => {
    const prompt = vi.fn(async () => "none" as const);
    const error = await refusal(() => resolveRails({ flags: { web: "apple" }, backend: FULL, scope: SCOPE, prompt }));
    expect(error.payload.code).toBe("validation/invalid_input");
    expect(prompt).not.toHaveBeenCalled();
  });
});
