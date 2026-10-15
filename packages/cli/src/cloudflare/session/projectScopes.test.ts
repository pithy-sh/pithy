// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_BASE_SCOPES } from "@pithy-sh/cloudflare/src/oauth/scopes";
import type { TokenProfile } from "@pithy-sh/cloudflare/src/tokens/profiles";
import { describe, expect, test } from "vitest";
import { deriveSessionScopes, projectSessionScopes } from "./projectScopes";

const profile = (name: string, permissions: TokenProfile["permissions"]): TokenProfile => ({
  name,
  permissions,
  secret: `${name}_TOKEN`,
  description: name,
});

describe("deriveSessionScopes", () => {
  test("is the base plus every permission every profile carries, in every environment", () => {
    const scopes = deriveSessionScopes({
      environments: ["dev", "prod"],
      profilesFor: (env): Record<string, TokenProfile> =>
        env === "prod"
          ? {
              "ci-system": profile("ci-system", ["workers:write", "d1:write"]),
              vec: profile("vec", ["vectorize:read"]),
            }
          : { "ci-system": profile("ci-system", ["workers:write"]) },
      declaresDomain: () => false,
      override: () => undefined,
    });
    expect(scopes).toEqual([...SESSION_BASE_SCOPES, "workers-scripts.write", "d1.write", "vectorize.read"]);
  });

  test("asks for route writes only where an environment declares a domain, because only then does a mint carry them", () => {
    const base = {
      environments: ["dev", "prod"],
      profilesFor: () => ({ "ci-system": profile("ci-system", ["workers:write"]) }),
      override: () => undefined,
    };
    expect(deriveSessionScopes({ ...base, declaresDomain: () => false })).not.toContain("workers-routes.write");
    expect(deriveSessionScopes({ ...base, declaresDomain: (env) => env === "prod" })).toContain("workers-routes.write");
  });

  test("an adopter's override of a profile's permissions is what the session must cover, not the default", () => {
    const scopes = deriveSessionScopes({
      environments: ["dev"],
      profilesFor: () => ({ "ci-system": profile("ci-system", ["workers:write"]) }),
      declaresDomain: () => false,
      override: (name) => (name === "ci-system" ? { permissions: ["workers:write", "kv:write"] } : undefined),
    });
    expect(scopes).toContain("workers-kv-storage.write");
  });
});

describe("projectSessionScopes", () => {
  test("no pithy.config.ts here is no project: the scopes a project with no capabilities would need", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pithy-scopes-"));
    const { scopes, project } = await projectSessionScopes(dir);
    expect(project).toBe(false);
    expect(scopes).toContain("workers-scripts.write");
  });

  test("a pithy.config.ts that will not load is refused, never read as no project and a narrower request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pithy-scopes-"));
    writeFileSync(join(dir, "pithy.config.ts"), "export default {{ broken");
    await expect(projectSessionScopes(dir)).rejects.toThrow();
  });
});
