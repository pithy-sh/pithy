// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consent } from "@pithy-sh/consent/src/capability";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { turnstile } from "@pithy-sh/turnstile/src/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appSchemeFor, buildGeneratedConfig, devOrigin, originsFor, universalLinkOriginFor } from "./nativeConfig";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-native-config-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/** A `.dev.config.json` pinning `workers`. */
async function pin(workers: Record<string, { port: number; origin: string }>): Promise<void> {
  await writeFile(
    join(projectDir, ".dev.config.json"),
    JSON.stringify({ version: 1, branch: "main", ports: { index: 0, base: 8787, size: 20 }, workers }),
  );
}

describe("devOrigin", () => {
  test("is the origin pithy dev pinned for the worker's deployed name", async () => {
    await pin({ "acme-api": { port: 8791, origin: "http://localhost:8791" } });
    expect(await devOrigin(projectDir, "acme-api")).toBe("http://localhost:8791");
  });

  test("is the first dev port when nothing is pinned, or nothing is pinned for this worker", async () => {
    expect(await devOrigin(projectDir, "acme-api")).toBe("http://localhost:8787");
    await pin({ "acme-web": { port: 8788, origin: "http://localhost:8788" } });
    expect(await devOrigin(projectDir, "acme-api")).toBe("http://localhost:8787");
    expect(await devOrigin(projectDir, undefined)).toBe("http://localhost:8787");
  });

  test("a dev config that does not parse is no pin, not a failure", async () => {
    await writeFile(join(projectDir, ".dev.config.json"), "{ not json");
    expect(await devOrigin(projectDir, "acme-api")).toBe("http://localhost:8787");
  });
});

describe("appSchemeFor", () => {
  test("is the app's name, prefixed when it does not start with a letter", () => {
    expect(appSchemeFor("mobile")).toBe("mobile");
    expect(appSchemeFor("acme-app")).toBe("acme-app");
    expect(appSchemeFor("2048")).toBe("app2048");
  });
});

describe("universalLinkOriginFor", () => {
  test("is the production domain, then the staging one, then none", () => {
    const prod = { pattern: "api.acme.dev", zone: "acme.dev" };
    const staging = { pattern: "staging.acme.dev", zone: "acme.dev" };
    expect(universalLinkOriginFor({ capabilities: [], domains: { prod, staging } })).toBe("https://api.acme.dev");
    expect(universalLinkOriginFor({ capabilities: [], domains: { staging } })).toBe("https://staging.acme.dev");
    expect(universalLinkOriginFor({ capabilities: [] })).toBeNull();
  });
});

describe("originsFor", () => {
  test("is the local origin, and each deployed environment's declared domain, route or BASE_URL, else null", async () => {
    const workerDir = join(projectDir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      JSON.stringify({ name: "acme-api", env: { staging: { vars: { BASE_URL: "https://staging.acme.dev" } } } }),
    );
    const config = { capabilities: [], domains: { prod: { pattern: "api.acme.dev", zone: "acme.dev" } } };
    expect(await originsFor({ projectDir, workerDir, config, environments: ["staging", "prod"] })).toEqual({
      dev: "http://localhost:8787",
      staging: "https://staging.acme.dev",
      prod: "https://api.acme.dev",
    });
    expect(await originsFor({ projectDir, workerDir, config: { capabilities: [] }, environments: ["prod"] })).toEqual({
      dev: "http://localhost:8787",
      prod: null,
    });
  });
});

/** A capability another one depends on, composed for its name alone. */
const peer = (name: string) => defineCapability({ name, requiredBindings: [] });

describe("buildGeneratedConfig", () => {
  test("projects each capability for dev, and a capability not composed as disabled", () => {
    const echo = defineCapability({
      name: "turnstile",
      requiredBindings: [],
      client: ({ environment }) => ({ enabled: true, environment }),
    });
    const config = buildGeneratedConfig({
      config: { capabilities: [echo] },
      app: "app",
      origins: { dev: "http://localhost:8787" },
      rails: { ios: "none", android: "none", web: "none" },
    });
    expect(config.turnstile).toEqual({ dev: { enabled: true, environment: "dev" } });
    expect(config.auth).toEqual({ dev: { enabled: false } });
    expect(config.consent).toEqual({ dev: { enabled: false } });
    expect(config.google).toEqual({ webClientId: null, iosClientId: null });
  });

  test("projects each capability for every environment the project deploys to: prod carries prod's sitekey", () => {
    const widget = turnstile({
      widgets: { visible: { sitekeys: { dev: "dev-key", staging: "staging-key", prod: "prod-key" } } },
    });
    const config = buildGeneratedConfig({
      config: { capabilities: [peer("secrets"), widget] },
      app: "app",
      origins: { dev: "http://localhost:8787", prod: "https://api.acme.dev" },
      rails: { ios: "none", android: "none", web: "none" },
    });
    expect(config.turnstile.dev).toMatchObject({ enabled: true, sitekey: "dev-key" });
    expect(config.turnstile.prod).toMatchObject({ enabled: true, sitekey: "prod-key" });
    // The project does not deploy to staging, so the file carries no projection for it.
    expect(Object.keys(config.turnstile)).toEqual(["dev", "prod"]);
  });

  test("an environment whose origin Pithy could not find still gets its projection", () => {
    const config = buildGeneratedConfig({
      config: { capabilities: [peer("auth"), consent({ basePath: "/privacy" })] },
      app: "app",
      origins: { dev: "http://localhost:8787", staging: null, prod: null },
      rails: { ios: "none", android: "none", web: "none" },
    });
    expect(config.consent).toEqual({
      dev: { enabled: true, basePath: "/privacy" },
      staging: { enabled: true, basePath: "/privacy" },
      prod: { enabled: true, basePath: "/privacy" },
    });
  });

  test("lists every base path the Worker's route table answers under, wherever a capability mounted it", () => {
    const organization = defineCapability({
      name: "organization",
      requiredBindings: [],
      routes: (app) => {
        app.get("/teams/:id", (c) => c.json({}));
        app.post("/teams", (c) => c.json({}));
      },
    });
    const consent = defineCapability({
      name: "consent",
      requiredBindings: [],
      routes: (app) => {
        app.get("/privacy/purposes", (c) => c.json({}));
      },
    });
    const config = buildGeneratedConfig({
      config: { capabilities: [organization, consent] },
      app: "app",
      origins: { dev: "http://localhost:8787" },
      rails: { ios: "none", android: "none", web: "none" },
    });
    expect(config.workerPaths).toEqual(["/health", "/privacy", "/teams"]);
  });

  test("an origin that is not a bare http(s) origin is refused", () => {
    expect(() =>
      buildGeneratedConfig({
        config: { capabilities: [] },
        app: "app",
        origins: { dev: "http://localhost:8787/api" },
        rails: { ios: "none", android: "none", web: "none" },
      }),
    ).toThrow("The config for apps/app is not one an Expo app can read.");
  });
});
