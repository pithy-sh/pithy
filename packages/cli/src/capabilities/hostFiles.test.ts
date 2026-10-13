// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { hostConfigFile, hostEntryFile } from "./hostFiles";

describe("the files a kit deploy writes beside a worker module", () => {
  test("are dotted and named for the environment, so one deploy's never meets another's", () => {
    expect(hostConfigFile("staging")).toBe(".wrangler.staging.json");
    expect(hostEntryFile("staging")).toBe(".pithy-host.staging.ts");
    expect(hostConfigFile("prod")).not.toBe(hostConfigFile("staging"));
  });
});
