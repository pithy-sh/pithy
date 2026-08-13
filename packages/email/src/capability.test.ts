// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { EMAIL_MIGRATION_ORDER, email, isEmailCapability } from "./capability";
import { EMAIL_LINK_SIGNING_KEY, emailSigningRegistry } from "./crypto/signingKey";

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

  test("ships one migration per database", () => {
    // One per database, with the control-plane listing indexes folded into it. Nothing has been
    // released, so an additive index migration would be pure overhead — a second file to run, order, and
    // test for a table no adopter has ever created.
    const cap = email(config);
    expect(Object.keys(cap.databases?.app?.migrations ?? {})).toEqual(["0001_init"]);
    expect(Object.keys(cap.databases?.emailSuppressions?.migrations ?? {})).toEqual(["0001_suppressions"]);
  });

  test("advertises its management surface under the configured basePath", () => {
    expect((email(config).adminRoutes ?? []).map((route) => route.path)).toEqual([
      "/email/jobs",
      "/email/jobs/:id",
      "/email/jobs/:id/retry",
      "/email/suppressions",
      "/email/suppressions",
      "/email/suppressions/remove",
    ]);
    // The callbacks do not move with it — those URLs are already minted into mail nobody can recall.
    expect(email({ ...config, basePath: "/mail" }).emailConfig.baseUrl).toBe(config.baseUrl);
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

describe("pithy.manifest.json", () => {
  const manifest = CapabilityManifest.parse(
    JSON.parse(readFileSync(new URL("../pithy.manifest.json", import.meta.url), "utf8")),
  );

  test("its devSecrets are exactly the registry entries that declare a devValue — nothing else checks", () => {
    // `pithy add` reads the manifest without executing this package, so the manifest carries the
    // projection. Both directions: a registry entry marked generatable and left out of the manifest is
    // never minted, and a manifest name the registry does not mark is a value written for nothing.
    const entries: [string, SecretRegistryEntry][] = Object.entries(emailSigningRegistry);
    const declared = entries
      .filter(([, entry]) => entry.devValue)
      .map(([name, entry]) => ({ name, devValue: entry.devValue }));
    expect(manifest.devSecrets).toEqual(declared);
    expect(manifest.devSecrets).toEqual([{ name: EMAIL_LINK_SIGNING_KEY, devValue: "random" }]);
  });

  test("every registry entry is in the manifest, and says where it comes from and how it is replaced", () => {
    // Same route as `devSecrets`, and it must be: a client reads the manifest without executing this
    // package. A declaration the manifest omits is a declaration nothing downstream can act on.
    //
    // Stated as the invariant, not as a filtered comparison. The filtered version could not fail for the
    // one case it existed to catch: an entry declaring neither axis is dropped from the expected list and
    // is absent from the manifest, so it vanishes from both sides and the comparison passes.
    const entries: [string, SecretRegistryEntry][] = Object.entries(emailSigningRegistry);
    expect(manifest.secrets.map((secret) => secret.name)).toEqual(entries.map(([name]) => name));
    for (const [name, entry] of entries) {
      expect(entry.origin, `${name} declares no origin`).toBeDefined();
      expect(entry.rotation, `${name} declares no rotation`).toBeDefined();
      expect(manifest.secrets.find((secret) => secret.name === name)).toEqual({
        name,
        origin: entry.origin,
        rotation: entry.rotation,
      });
    }
    expect(manifest.secrets).toEqual([
      {
        name: EMAIL_LINK_SIGNING_KEY,
        origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
        rotation: { kind: "local" },
      },
    ]);
  });

  test("claims nothing for EMAIL_SENDER — a Workflow binding has no local stand-in to mint", () => {
    expect(manifest.devSecrets.map((secret) => secret.name)).not.toContain("EMAIL_SENDER");
  });

  test("its EMAIL_SENDER binding names the same job and class this capability registers", () => {
    // `pithy add` runs offline against the manifest and never executes this package, so the job and the
    // class name are mirrored there — and a mirror drifts. They are what the CLI composes the deployed
    // `<project>-<env>-email-send` name and the `class_name` from, so a manifest that fell out of step
    // would write a `workflows` entry pointing at a Workflow nothing deploys: a config that loads, a
    // Worker that boots, and a send that fails in production. #258.
    const send = email(config).workflows?.send;
    const binding = manifest.requiredBindings.find((entry) => entry.name === "EMAIL_SENDER");
    expect(binding).toMatchObject({ type: "workflow", job: "send", className: send?.className });
    expect(send?.binding).toBe(binding?.name);
  });
});
