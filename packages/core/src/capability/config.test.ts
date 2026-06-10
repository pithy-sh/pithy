import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "./capability";
import { composeConfig, loadConfig } from "./config";

const auth = defineCapability({
  name: "auth",
  config: z.object({ providers: z.array(z.string()) }),
  requiredBindings: [],
});
const turnstile = defineCapability({
  name: "turnstile",
  config: z.object({ siteKey: z.string() }),
  requiredBindings: [],
});
const noConfigCap = defineCapability({ name: "audit", requiredBindings: [] });

describe("composeConfig / loadConfig", () => {
  test("composes only capabilities that declare config", () => {
    const schema = composeConfig([auth, turnstile, noConfigCap]);
    const shape = Object.keys(schema.shape);
    expect(shape).toEqual(["auth", "turnstile"]);
  });

  test("loadConfig validates and returns typed config", () => {
    const cfg = loadConfig([auth, turnstile], {
      auth: { providers: ["magic-link"] },
      turnstile: { siteKey: "k" },
    });
    expect(cfg.auth?.providers).toEqual(["magic-link"]);
  });

  test("loadConfig throws on invalid config", () => {
    expect(() => loadConfig([auth], { auth: { providers: "nope" } })).toThrow();
  });
});
