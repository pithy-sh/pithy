// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { isTurnstileCapability, turnstile } from "./capability";
import type { TurnstileConfigInput } from "./config/config";
import { TURNSTILE_SECRET_NAME, turnstileSecretsRegistry } from "./secret/registry";

const sitekeys = { dev: "d", staging: "s", prod: "p" };

describe("turnstile capability", () => {
  test("is stateless — no bindings of its own (its secret is read through @pithy-sh/secrets)", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } } });
    expect(cap.name).toBe("turnstile");
    expect(cap.requiredBindings).toEqual([]);
    expect(cap.databases).toBeUndefined();
    expect(cap.routes).toBeUndefined();
    expect(cap.middleware).toBeUndefined();
  });

  test("attaches the resolved config with brand defaults", () => {
    const cap = turnstile({ widgets: { invisible: { sitekeys } } });
    expect(cap.turnstileConfig.protect).toEqual({ login: "visible" });
    expect(cap.turnstileConfig.widgets.invisible?.sitekeys.prod).toBe("p");
  });

  test("exposes its config schema for composition validation", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } } });
    expect(cap.config).toBeDefined();
  });

  test("isTurnstileCapability narrows to the carrier", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } } });
    expect(isTurnstileCapability(cap)).toBe(true);
    expect(isTurnstileCapability({ name: "auth", requiredBindings: [] })).toBe(false);
  });
});

// The client projection is a security boundary: the sitekey is public, the widget secret never is.
describe("turnstile client projection", () => {
  test("projects exactly the four keys that render the login widget", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } } });
    const projection = resolveClientProjection(cap, { environment: "prod" });
    expect(Object.keys(projection).sort()).toEqual(["enabled", "mode", "sitekey", "token"]);
    expect(projection).toEqual({
      enabled: true,
      mode: "visible",
      sitekey: "p",
      token: { field: "cf-turnstile-response", header: null },
    });
  });

  test("resolves the sitekey per environment", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } } });
    expect(resolveClientProjection(cap, { environment: "dev" }).sitekey).toBe("d");
    expect(resolveClientProjection(cap, { environment: "staging" }).sitekey).toBe("s");
    expect(resolveClientProjection(cap, { environment: "prod" }).sitekey).toBe("p");
  });

  test("carries the token placement so the front end posts where the middleware reads", () => {
    const cap = turnstile({
      widgets: { invisible: { sitekeys } },
      protect: { login: "invisible" },
      token: { field: "captcha", header: "x-captcha" },
    });
    expect(resolveClientProjection(cap, { environment: "dev" })).toEqual({
      enabled: true,
      mode: "invisible",
      sitekey: "d",
      token: { field: "captcha", header: "x-captcha" },
    });
  });

  test("is disabled when no login gate is configured", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } }, protect: {} });
    expect(resolveClientProjection(cap, { environment: "prod" })).toEqual({ enabled: false });
  });

  test("is disabled when the widget the login gate names is not configured", () => {
    const cap = turnstile({ widgets: { invisible: { sitekeys } } });
    expect(resolveClientProjection(cap, { environment: "prod" })).toEqual({ enabled: false });
  });

  test("is disabled when this environment has no sitekey", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys: { dev: "d", staging: "s", prod: "" } } } });
    expect(resolveClientProjection(cap, { environment: "prod" })).toEqual({ enabled: false });
    expect(resolveClientProjection(cap, { environment: "preview" })).toEqual({ enabled: false });
  });

  test("no secret, and no other environment's sitekey, reaches the bundle", () => {
    // A sensitive-looking extra field, as an adopter (or a future schema edit) might introduce it.
    const extra = { secret: "0x_widget_secret_never_ship" } as unknown as Partial<TurnstileConfigInput>;
    const cap = turnstile({
      widgets: {
        visible: { sitekeys: { dev: "dev-key", staging: "staging-key", prod: "production-key" } },
        invisible: { sitekeys: { dev: "inv-dev", staging: "inv-staging", prod: "inv-production" } },
      },
      ...extra,
    });
    const serialized = JSON.stringify(resolveClientProjection(cap, { environment: "dev" }));
    for (const secret of [
      "0x_widget_secret_never_ship",
      "staging-key",
      "production-key",
      "inv-dev",
      "inv-staging",
      "inv-production",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("dev-key");
  });
});

describe("pithy.manifest.json — declared secrets", () => {
  const manifest = CapabilityManifest.parse(
    JSON.parse(readFileSync(new URL("../pithy.manifest.json", import.meta.url), "utf8")),
  );

  test("every registry entry is in the manifest, and says where it comes from and how it is replaced", () => {
    // The gate this capability had none of. A client reads the manifest without executing this package,
    // so a secret absent from it reads as *nothing is known* — and this one has a real answer at both
    // ends: Cloudflare issues the widget's secret key, and Cloudflare's own API rotates it.
    //
    // Stated as the invariant, never as a filtered comparison: an entry declaring neither axis drops off
    // both sides of a filtered comparison at once and passes green.
    const entries: [string, SecretRegistryEntry][] = Object.entries(turnstileSecretsRegistry);
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
  });

  test("the widget's secret comes from Cloudflare and rolls through Cloudflare", () => {
    const declared = manifest.secrets.find((secret) => secret.name === TURNSTILE_SECRET_NAME);
    expect(declared?.origin).toMatchObject({ kind: "obtained", issuer: "cloudflare" });
    expect(declared?.rotation).toMatchObject({ kind: "provider", issuer: "cloudflare" });
  });

  test("mints nothing — a generated widget secret validates no token", () => {
    // The test keys dev and staging wire are Cloudflare's published pair, not a minted value: they are
    // known to Cloudflare, which is the whole of why they verify.
    expect(manifest.devSecrets).toEqual([]);
  });
});
