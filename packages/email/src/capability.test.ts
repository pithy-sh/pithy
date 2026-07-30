// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { describe, expect, test } from "vitest";
import { EMAIL_MIGRATION_ORDER, email, isEmailCapability } from "./capability";

const config = { fromAddress: "noreply@pithy.sh", baseUrl: "https://api.example.com" };

describe("email capability", () => {
  test("contributes its tables, bindings, routes, and inbound handler", () => {
    const cap = email(config);
    expect(cap.name).toBe("email");
    expect(cap.requiredBindings).toEqual([
      { type: "d1", name: "DB", optional: false },
      { type: "d1", name: "EMAIL_SUPPRESSIONS", optional: false },
      { type: "workflow", name: "EMAIL_SENDER", optional: false },
    ]);
    expect(cap.databases?.app).toMatchObject({ binding: "DB", migrationOrder: EMAIL_MIGRATION_ORDER });
    expect(Object.keys(cap.databases?.app?.tables ?? {})).toEqual(["pithyEmailJobs", "pithyEmailEvents"]);
    expect(cap.databases?.emailSuppressions).toMatchObject({ binding: "EMAIL_SUPPRESSIONS" });
    expect(Object.keys(cap.databases?.emailSuppressions?.tables ?? {})).toEqual(["pithyEmailSuppressions"]);
    expect(typeof cap.routes).toBe("function");
    expect(typeof cap.email).toBe("function");
  });

  test("resolves config defaults and the brand theme", () => {
    const cap = email(config);
    expect(cap.emailConfig).toMatchObject({
      fromAddress: "noreply@pithy.sh",
      fromName: "Pithy",
      baseUrl: "https://api.example.com",
      schedulerEnabled: true,
      theme: { appName: "Pithy", accent: "#D4A017" },
    });
    expect(isEmailCapability(cap)).toBe(true);
  });

  test("a missing required field is rejected at construction", () => {
    expect(() => email({ baseUrl: "https://x" } as never)).toThrow();
  });

  test("a named preset bootstraps the palette, and customTheme deep-merges over it", () => {
    const base = email({ ...config, theme: "midnight" });
    expect(base.emailConfig.theme.accent).toBe("#3B82F6");
    expect(base.emailConfig.theme.light.background).toBe("#F4F6FB");

    const overridden = email({
      ...config,
      theme: "midnight",
      customTheme: { accent: "#FF0000", dark: { text: "#FFFFFF" } },
    });
    expect(overridden.emailConfig.theme.accent).toBe("#FF0000");
    // The deep-merge overrides one dark color but keeps the rest of the preset's dark palette.
    expect(overridden.emailConfig.theme.dark.text).toBe("#FFFFFF");
    expect(overridden.emailConfig.theme.dark.background).toBe("#0B1120");
  });

  test("its migration composes into the app database registry under the email namespace", () => {
    const cap = email(config);
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: cap.name,
        order: EMAIL_MIGRATION_ORDER,
        migrations: cap.databases?.app?.migrations ?? {},
      },
    ]);
    expect(registry.app).toBeDefined();
  });
});
