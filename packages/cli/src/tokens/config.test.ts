import { describe, expect, test } from "vitest";
import type { ProjectConfig } from "../project/config";
import { tokenOverrideResolver } from "./config";

describe("tokenOverrideResolver", () => {
  test("returns a profile's configured override", () => {
    const config: ProjectConfig = {
      tokens: { overrides: { "ci-deploy": { permissions: ["workers:write"], store: "secrets-store" } } },
    };
    const resolve = tokenOverrideResolver(config);
    expect(resolve("ci-deploy")).toEqual({ permissions: ["workers:write"], store: "secrets-store" });
  });

  test("returns undefined for a profile with no override, and when no token config exists", () => {
    expect(tokenOverrideResolver({ tokens: { overrides: {} } })("ci-deploy")).toBeUndefined();
    expect(tokenOverrideResolver({})("remote-migrate")).toBeUndefined();
  });
});
