// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { UI_REACT_VERSION } from "./version";

test("the version is the one this package's manifest declares", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(UI_REACT_VERSION).toBe(manifest.version);
  expect(UI_REACT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
