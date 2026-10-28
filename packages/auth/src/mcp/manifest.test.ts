// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { describe, expect, test } from "vitest";
import { McpConfig, mcp } from "./capability";

const manifest = CapabilityManifest.parse(
  JSON.parse(readFileSync(new URL("../../pithy.mcp.manifest.json", import.meta.url), "utf8")),
);

describe("pithy.mcp.manifest.json", () => {
  test("names the capability, the package it ships in, and its migration namespace", () => {
    const capability = mcp({ floor: "signed-in" });
    expect(manifest.name).toBe(capability.name);
    expect(manifest.package).toBe(capability.package);
    expect(manifest.migrationNamespace).toBe("mcp");
  });

  test("mirrors the runtime dependsOn as peerCapabilities", () => {
    expect(manifest.peerCapabilities).toEqual(mcp({ floor: "signed-in" }).dependsOn);
  });

  test("binds the database the provider's tables live in", () => {
    expect(manifest.requiredBindings).toMatchObject([
      { type: "d1", name: McpConfig.parse({ floor: "signed-in" }).database },
    ]);
  });

  test("offers every config field, each with the default mcp() takes", () => {
    const defaults = McpConfig.parse({ floor: "signed-in" }) as Record<string, unknown>;
    expect(manifest.configOptions.map((option) => option.key).sort()).toEqual(Object.keys(McpConfig.shape).sort());
    for (const option of manifest.configOptions) {
      if (option.key === "floor") continue;
      expect(option.default, option.key).toEqual(defaults[option.key]);
    }
  });

  test("states no default floor, so pithy add asks for one", () => {
    expect(manifest.configOptions.find((option) => option.key === "floor")?.default).toBeUndefined();
  });
});
