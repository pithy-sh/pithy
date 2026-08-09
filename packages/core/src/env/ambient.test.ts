// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import { ambientEnv, ambientFlag, compositionEnvironment } from "./ambient";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ambientEnv", () => {
  test("is the live process environment, read at call time and never captured at import", () => {
    vi.stubEnv("PITHY_AMBIENT_PROBE", "one");
    expect(ambientEnv().PITHY_AMBIENT_PROBE).toBe("one");
    vi.stubEnv("PITHY_AMBIENT_PROBE", "two");
    expect(ambientEnv().PITHY_AMBIENT_PROBE).toBe("two");
  });
});

describe("ambientFlag", () => {
  test("any non-blank value is set", () => {
    expect(ambientFlag({ FLAG: "1" }, "FLAG")).toBe(true);
    expect(ambientFlag({ FLAG: "true" }, "FLAG")).toBe(true);
    expect(ambientFlag({ FLAG: "false" }, "FLAG")).toBe(true);
    expect(ambientFlag({ FLAG: "0" }, "FLAG")).toBe(true);
  });

  test("absent, empty, and whitespace are no override", () => {
    expect(ambientFlag({}, "FLAG")).toBe(false);
    expect(ambientFlag({ FLAG: undefined }, "FLAG")).toBe(false);
    expect(ambientFlag({ FLAG: "" }, "FLAG")).toBe(false);
    expect(ambientFlag({ FLAG: "   " }, "FLAG")).toBe(false);
  });
});

describe("compositionEnvironment", () => {
  test("is the ENVIRONMENT var this Worker was stamped with", () => {
    expect(compositionEnvironment({ ENVIRONMENT: "dev" })).toBe("dev");
    expect(compositionEnvironment({ ENVIRONMENT: "staging" })).toBe("staging");
    expect(compositionEnvironment({ ENVIRONMENT: "prod" })).toBe("prod");
  });

  test("is undefined where nothing stamped one — never a guessed `dev`", () => {
    expect(compositionEnvironment({})).toBeUndefined();
    expect(compositionEnvironment({ ENVIRONMENT: "" })).toBeUndefined();
    expect(compositionEnvironment({ ENVIRONMENT: "  " })).toBeUndefined();
  });

  test("reads the ambient environment when handed none", () => {
    vi.stubEnv("ENVIRONMENT", "staging");
    expect(compositionEnvironment()).toBe("staging");
  });
});
