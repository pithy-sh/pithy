// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, expect, test, vi } from "vitest";
import { CI_ENV, isContinuousIntegration } from "./ci";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("the var is named `CI` — the one every runner sets without configuration", () => {
  expect(CI_ENV).toBe("CI");
});

test("any non-blank value is CI, whatever the runner spells it", () => {
  // GitHub Actions and GitLab say `true`; Buildkite and some images say `1`; a human debugging a job
  // says whatever they type. None of them are asserting "not CI", so none of them are read as one.
  expect(isContinuousIntegration({ CI: "true" })).toBe(true);
  expect(isContinuousIntegration({ CI: "1" })).toBe(true);
  expect(isContinuousIntegration({ CI: "false" })).toBe(true);
  expect(isContinuousIntegration({ CI: "0" })).toBe(true);
  expect(isContinuousIntegration({ CI: "woodpecker" })).toBe(true);
});

test("absent, empty, and whitespace are not CI — the same rule PITHY_OFFLINE settled", () => {
  expect(isContinuousIntegration({})).toBe(false);
  expect(isContinuousIntegration({ CI: undefined })).toBe(false);
  expect(isContinuousIntegration({ CI: "" })).toBe(false);
  expect(isContinuousIntegration({ CI: " \t " })).toBe(false);
});

test("reads the ambient environment when handed none", () => {
  vi.stubEnv("CI", "true");
  expect(isContinuousIntegration()).toBe(true);
  vi.stubEnv("CI", "");
  expect(isContinuousIntegration()).toBe(false);
});
