// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test } from "vitest";
import { sinkSecretsRegistry } from "./secrets";
import { AuditSinks } from "./sinks";

describe("sinkSecretsRegistry", () => {
  test("declares each sink's token once, a per-environment d1 text secret obtained by hand", () => {
    const sinks = AuditSinks.parse({
      a: { profile: "webhook", url: "https://a.example.com/x", secret: "shared-token" },
      b: { profile: "splunk-hec", url: "https://b.example.com/x", secret: "shared-token" },
      c: { profile: "datadog-logs", url: "https://c.example.com/x", secret: "dd-key" },
    });
    const registry = sinkSecretsRegistry(sinks);
    expect(Object.keys(registry)).toEqual(["shared-token", "dd-key"]);
    expect(registry["dd-key"]).toMatchObject({
      backend: "d1",
      scope: "environment",
      valueType: "text",
      rotatable: false,
      origin: { kind: "obtained" },
      rotation: { kind: "manual" },
    });
  });

  test("declares nothing when nothing ships", () => {
    expect(sinkSecretsRegistry({})).toEqual({});
  });
});
