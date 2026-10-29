// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  ADOPTER_CHOICES,
  ENVIRONMENT_VARIABLE,
  GENERATED_CONFIG_PATH,
  GeneratedConfig,
  keepAdopterChoices,
  readGeneratedConfig,
  renderGeneratedConfig,
} from "./generatedConfig";
import { TEMPLATE_DIR } from "./templates";

const composed: GeneratedConfig = {
  origins: { dev: "http://localhost:8787", staging: null, prod: "https://api.example.com" },
  appScheme: "demo",
  universalLinkOrigin: "https://app.example.com",
  rails: { ios: "apple", android: "google", web: "stripe" },
  google: { webClientId: null, iosClientId: null },
  auth: { enabled: true, basePath: "/auth", otpLength: 6 },
  i18n: { enabled: false },
  payments: { enabled: false },
  turnstile: { enabled: false },
};

/** Every object schema reachable from `schema`, with the path it sits at. */
function objects(schema: z.ZodType, path = "GeneratedConfig"): { path: string; schema: z.ZodObject }[] {
  if (!(schema instanceof z.ZodObject)) return [];
  const found = [{ path, schema }];
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    found.push(...objects(field, `${path}.${key}`));
  }
  return found;
}

describe("the generated config's shape", () => {
  test("every object and every field says what it is", () => {
    for (const { path, schema } of objects(GeneratedConfig)) {
      expect(schema.description, path).toBeTruthy();
      for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
        expect(field.description, `${path}.${key}`).toBeTruthy();
      }
    }
  });

  test("an origin with a path, or one that is not http(s), is refused", () => {
    for (const bad of ["https://api.example.com/v1", "ftp://api.example.com", "https://api.example.com/"]) {
      expect(GeneratedConfig.safeParse({ ...composed, origins: { ...composed.origins, prod: bad } }).success).toBe(
        false,
      );
      expect(GeneratedConfig.safeParse({ ...composed, origins: { ...composed.origins, dev: bad } }).success).toBe(
        false,
      );
    }
  });

  test("dev always has an origin; staging and prod may be null, or absent when the project does not deploy there", () => {
    expect(GeneratedConfig.safeParse({ ...composed, origins: { staging: null, prod: null } }).success).toBe(false);
    expect(GeneratedConfig.safeParse({ ...composed, origins: { dev: "http://localhost:8787" } }).success).toBe(true);
  });

  test("a universal link must be https: a store will not return to anything else", () => {
    expect(GeneratedConfig.safeParse({ ...composed, universalLinkOrigin: "http://app.example.com" }).success).toBe(
      false,
    );
  });

  test("no universal link is a choice: a sign-in returns on the app's scheme", () => {
    expect(GeneratedConfig.safeParse({ ...composed, universalLinkOrigin: null }).success).toBe(true);
  });

  test("a rail outside the five and none is refused", () => {
    expect(GeneratedConfig.safeParse({ ...composed, rails: { ...composed.rails, web: "paypal" } }).success).toBe(false);
    expect(GeneratedConfig.safeParse({ ...composed, rails: { ...composed.rails, web: "none" } }).success).toBe(true);
  });

  test("a projection keeps every field the Worker projected", () => {
    const parsed = GeneratedConfig.parse(composed);
    expect(parsed.auth).toEqual({ enabled: true, basePath: "/auth", otpLength: 6 });
  });
});

describe("writing and reading the file", () => {
  test("what is written reads back as the same config", () => {
    expect(readGeneratedConfig(renderGeneratedConfig(composed, "api"))).toEqual(composed);
  });

  test("the file names the Worker it came from and says how to change a rail", () => {
    const text = renderGeneratedConfig(composed, "api");
    expect(text).toContain("apps/api");
    expect(text).toContain("`ui sync --app`");
    for (const platform of ["ios", "android", "web"]) expect(text).toContain(`rails.${platform}`);
  });

  test("the file says which variable picks the origin at build time, and how to set one Pithy could not find", () => {
    const text = renderGeneratedConfig(composed, "api");
    expect(ENVIRONMENT_VARIABLE).toBe("EXPO_PUBLIC_PITHY_ENV");
    expect(text).toContain(ENVIRONMENT_VARIABLE);
    expect(text).toContain("`origins.staging`");
    expect(text).toContain("null");
  });

  test("a file that is not one this module wrote reads as null, not a throw", () => {
    expect(readGeneratedConfig("export default {};")).toBeNull();
    expect(
      readGeneratedConfig(renderGeneratedConfig(composed, "api").replace('ios: "apple"', 'ios: "paypal"')),
    ).toBeNull();
  });

  test("the template is a file this module writes, so the scaffold and the sync agree", async () => {
    const text = await readFile(join(TEMPLATE_DIR, GENERATED_CONFIG_PATH), "utf8");
    const config = readGeneratedConfig(text);
    expect(config).not.toBeNull();
    expect(renderGeneratedConfig(config as GeneratedConfig, "__PITHY_WORKER__")).toBe(text);
  });
});

describe("a sync", () => {
  test("keeps what the adopter chose and takes everything else from the Worker", () => {
    const edited: GeneratedConfig = {
      ...composed,
      appScheme: "mine",
      universalLinkOrigin: "https://links.example.com",
      rails: { ios: "none", android: "google", web: "paddle" },
      google: { webClientId: "web.apps.googleusercontent.com", iosClientId: null },
    };
    const next: GeneratedConfig = {
      ...composed,
      origins: { ...composed.origins, prod: "https://api2.example.com" },
      i18n: { enabled: true },
    };
    const kept = keepAdopterChoices(edited, next);
    expect(kept.origins.prod).toBe("https://api2.example.com");
    expect(kept.i18n).toEqual({ enabled: true });
    for (const key of ADOPTER_CHOICES) expect(kept[key]).toEqual(edited[key]);
  });

  test("keeps an origin the adopter set where the Worker names none, and a dev origin off this machine", () => {
    const edited: GeneratedConfig = {
      ...composed,
      origins: {
        dev: "http://192.168.1.20:8787",
        staging: "https://staging.example.net",
        prod: "https://old.example.com",
      },
    };
    const next: GeneratedConfig = {
      ...composed,
      origins: { dev: "http://localhost:8791", staging: null, prod: "https://api.example.com" },
    };
    expect(keepAdopterChoices(edited, next).origins).toEqual({
      dev: "http://192.168.1.20:8787",
      staging: "https://staging.example.net",
      prod: "https://api.example.com",
    });
  });

  test("a loopback dev origin follows the port the Worker is pinned to, and an environment the project dropped goes", () => {
    const edited: GeneratedConfig = {
      ...composed,
      origins: { dev: "http://127.0.0.1:8787", staging: "https://staging.example.net", prod: null },
    };
    const next: GeneratedConfig = { ...composed, origins: { dev: "http://localhost:8791", prod: null } };
    expect(keepAdopterChoices(edited, next).origins).toEqual({ dev: "http://localhost:8791", prod: null });
  });

  test("with nothing written yet, the composed config is the answer", () => {
    expect(keepAdopterChoices(null, composed)).toEqual(composed);
  });
});

describe("reading a file an adopter edited", () => {
  const value = (literal: string): string =>
    renderGeneratedConfig(composed, "api").replace(/= \{[\s\S]*\};\n/, `= ${literal};\n`);

  test("takes single quotes, comments, trailing commas and keys with or without quotes", () => {
    const edited = value(`{
  // Where the Worker answers.
  origins: { 'dev': 'http://localhost:8787', "staging": null, prod: 'https://api.example.com', },
  appScheme: 'demo', /* the app's own */
  universalLinkOrigin: "https://app.example.com",
  rails: { ios: "apple", android: 'google', web: "stripe" },
  google: { webClientId: null, iosClientId: null },
  auth: { enabled: true, basePath: "/auth", otpLength: 6 },
  i18n: { enabled: false },
  payments: { enabled: false, note: 'it\\'s "here"' },
  turnstile: { enabled: false },
}`);
    expect(readGeneratedConfig(edited)).toEqual({ ...composed, payments: { enabled: false, note: `it's "here"` } });
  });

  test("refuses anything that would have to run to be read", () => {
    for (const literal of [
      "{ ...base }",
      "{ origins: process.env.ORIGINS }",
      "{ appScheme: `demo` }",
      "{ appScheme: 'demo' + 'x' }",
      "{ origins: {} } extra",
    ]) {
      expect(readGeneratedConfig(value(literal)), literal).toBeNull();
    }
  });
});
