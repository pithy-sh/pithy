// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import { appEnvironment, originFor, projectionFor } from "../templates/src/pithy-config";

const origins = { dev: "http://localhost:8787", staging: "https://staging.example.com", prod: null };

describe("appEnvironment", () => {
  test("is dev when the build names none, and the one it names otherwise", () => {
    expect(appEnvironment(undefined)).toBe("dev");
    expect(appEnvironment("")).toBe("dev");
    expect(appEnvironment("staging")).toBe("staging");
    expect(appEnvironment("prod")).toBe("prod");
  });

  test("a name that is not an environment is refused, naming the variable and the three it takes", () => {
    expect(() => appEnvironment("production")).toThrow(/EXPO_PUBLIC_PITHY_ENV.*"production".*dev, staging or prod/);
  });
});

describe("originFor", () => {
  test("is the origin of the environment the build names", () => {
    expect(originFor(origins, "staging", "ios")).toBe("https://staging.example.com");
    expect(originFor(origins, "dev", "ios")).toBe("http://localhost:8787");
    expect(originFor(origins, "dev", "web")).toBe("http://localhost:8787");
  });

  test("an Android emulator reaches this machine's loopback through 10.0.2.2", () => {
    expect(originFor(origins, "dev", "android")).toBe("http://10.0.2.2:8787");
    expect(originFor({ dev: "http://127.0.0.1:8791" }, "dev", "android")).toBe("http://10.0.2.2:8791");
    expect(originFor({ dev: "http://192.168.1.20:8787" }, "dev", "android")).toBe("http://192.168.1.20:8787");
  });

  test("an environment with no origin is refused, saying where to set one", () => {
    expect(() => originFor(origins, "prod", "ios")).toThrow(/origins\.prod.*pithy-config\.generated\.ts/);
    expect(() => originFor({ dev: "http://localhost:8787" }, "staging", "ios")).toThrow(/origins\.staging/);
  });

  test("a phone sends its bearer credential to staging and prod over https only", () => {
    const plain = { dev: "http://localhost:8787", staging: "http://staging.example.com", prod: "http://example.com" };
    expect(() => originFor(plain, "staging", "ios")).toThrow(/origins\.staging.*https/);
    expect(() => originFor(plain, "prod", "android")).toThrow(/origins\.prod.*https/);
    expect(originFor({ dev: "http://192.168.1.20:8787" }, "dev", "ios")).toBe("http://192.168.1.20:8787");
  });

  test("the web build calls relative paths, so it needs no origin and is not refused for want of one", () => {
    expect(originFor(origins, "prod", "web")).toBe("");
    expect(originFor({ dev: "http://localhost:8787" }, "staging", "web")).toBe("");
  });
});

describe("projectionFor", () => {
  const sitekeys = {
    dev: { enabled: true, sitekey: "dev-key" },
    staging: { enabled: true, sitekey: "staging-key" },
    prod: { enabled: true, sitekey: "prod-key" },
  };

  test("is the projection of the environment the build names", () => {
    expect(projectionFor(sitekeys, "turnstile", "prod")).toEqual({ enabled: true, sitekey: "prod-key" });
    expect(projectionFor(sitekeys, "turnstile", "staging")).toEqual({ enabled: true, sitekey: "staging-key" });
    expect(projectionFor(sitekeys, "turnstile", "dev")).toEqual({ enabled: true, sitekey: "dev-key" });
  });

  test("an environment with no projection is refused, naming the field and where it would be", () => {
    expect(() => projectionFor({ dev: sitekeys.dev }, "turnstile", "prod")).toThrow(
      /turnstile\.prod.*pithy-config\.generated\.ts/,
    );
  });
});

describe("the app's config, as a build reads it", () => {
  const generated = {
    origins: { dev: "http://localhost:8787", staging: "https://staging.example.com", prod: "https://api.example.com" },
    appScheme: "demo",
    universalLinkOrigin: null,
    rails: { ios: "none", android: "none", web: "none" },
    google: { webClientId: null, iosClientId: null },
    auth: { dev: { enabled: false }, staging: { enabled: false }, prod: { enabled: false } },
    i18n: { dev: { enabled: false }, staging: { enabled: false }, prod: { enabled: false } },
    payments: { dev: { enabled: false }, staging: { enabled: false }, prod: { enabled: false } },
    turnstile: {
      dev: { enabled: true, sitekey: "1x00000000000000000000AA", action: "login", mode: "visible", token: {} },
      staging: { enabled: true, sitekey: "1x00000000000000000000AA", action: "login", mode: "visible", token: {} },
      prod: { enabled: true, sitekey: "0x4AAAAAAAprod", action: "login", mode: "visible", token: {} },
    },
    consent: {
      dev: { enabled: true, basePath: "/privacy" },
      staging: { enabled: false },
      prod: { enabled: true, basePath: "/privacy" },
    },
  };

  /** The template module, evaluated as a build for `environment` evaluates it, over `config`. */
  async function built(environment: string, config: Record<string, unknown> = generated) {
    vi.resetModules();
    vi.stubEnv("EXPO_PUBLIC_PITHY_ENV", environment);
    vi.doMock("../templates/src/pithy-config.generated", () => ({ default: config }));
    return import("../templates/src/pithy-config");
  }

  afterEach(() => {
    vi.doUnmock("../templates/src/pithy-config.generated");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("a prod build renders prod's sitekey, not dev's", async () => {
    expect((await built("prod")).turnstileConfig.sitekey).toBe("0x4AAAAAAAprod");
    expect((await built("dev")).turnstileConfig.sitekey).toBe("1x00000000000000000000AA");
  });

  test("consent's base path is the one the build's environment composed, and its default where none is", async () => {
    expect((await built("prod")).consentConfig.basePath).toBe("/privacy");
    expect((await built("staging")).consentConfig).toEqual({ enabled: false, basePath: "/consent" });
  });

  test("a build naming an environment the file has no projection for fails, naming the field", async () => {
    const { prod: _prod, ...devAndStaging } = generated.turnstile;
    await expect(built("prod", { ...generated, turnstile: devAndStaging })).rejects.toThrow(/turnstile\.prod/);
  });
});
