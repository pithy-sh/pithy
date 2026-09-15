// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type PithyError, ValidationError } from "../error/pithyError";
import {
  assertValidEnvironment,
  DEFAULT_ENVIRONMENTS,
  DeclaredEnvironments,
  ENVIRONMENTS,
  FEATURE_ENVIRONMENT,
  featureMarker,
  GLOBAL_SCOPE,
  isFeatureMarker,
  isValidEnvironment,
  MAX_ENVIRONMENT_NAME,
} from "./environment";

/** Run `act` and hand back whatever it threw, so a test can assert on the payload rather than the message. */
function thrown(act: () => unknown): unknown {
  try {
    act();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("ENVIRONMENTS", () => {
  it("is dev, staging, prod — and `production` is not one of them", () => {
    expect([...ENVIRONMENTS]).toEqual(["dev", "staging", "prod"]);
    expect(ENVIRONMENTS).not.toContain("production");
  });

  it("caps an environment at the longest canonical one", () => {
    // The cap is the derivation input for every project-name budget, so it is read off the list
    // rather than typed twice.
    expect(MAX_ENVIRONMENT_NAME).toBe(Math.max(...ENVIRONMENTS.map((env) => env.length)));
    expect(MAX_ENVIRONMENT_NAME).toBe("staging".length);
  });
});

describe("isValidEnvironment", () => {
  it("accepts every canonical environment", () => {
    for (const env of ENVIRONMENTS) expect(isValidEnvironment(env)).toBe(true);
  });

  it("accepts a short custom environment", () => {
    for (const env of ["qa", "preview", "sandbox", "e2e", "dev2", "pr-7"]) {
      expect(isValidEnvironment(env)).toBe(true);
    }
  });

  it("rejects `production`, the name this scheme replaced", () => {
    expect(isValidEnvironment("production")).toBe(false);
  });

  it("rejects anything past the cap, at exactly the boundary", () => {
    expect(isValidEnvironment("a".repeat(MAX_ENVIRONMENT_NAME))).toBe(true);
    expect(isValidEnvironment("a".repeat(MAX_ENVIRONMENT_NAME + 1))).toBe(false);
  });

  it("rejects `global`, which is the scope reserved beside the environments", () => {
    // `global` occupies the same slot in a composed name. An environment of that name would give a
    // project one set of names for two different scopes.
    expect(isValidEnvironment(GLOBAL_SCOPE)).toBe(false);
  });

  it("rejects anything that is not already a legal name segment", () => {
    // An environment is typed into `--env` and into a config, and it lands in a Cloudflare name
    // verbatim. It is refused rather than kebabbed, so what you typed is what you get.
    for (const env of ["Prod", "PROD", "my env", "dev_1", "-dev", "dev-", "a--b", "1dev", "", "dev.1"]) {
      expect(isValidEnvironment(env)).toBe(false);
    }
  });
});

/**
 * **An environment never starts where a feature's name does (#587).**
 *
 * A feature takes the environment's slot with `f<issue>`, and its Worker is `<project>-f<issue>-<slug>-<app>`
 * with no suffix. A declared `f1-demo` composes `<project>-f1-demo-<worker>`, which is feature 1-demo's Worker
 * character for character, and `pithy feature destroy` on `feature/1-demo` deletes it. So does `f1`, with a
 * Worker called `demo-api`. The rule is exact: a declared name can only equal a feature's when its first
 * segment is a marker, and that is the one thing refused.
 */
describe("an environment and a feature's marker", () => {
  it("composes the marker a feature name carries from the issue, and recognizes every one it composes", () => {
    for (const issue of ["0", "1", "01", "69", "123456"]) {
      expect(featureMarker(issue)).toBe(`f${issue}`);
      expect(isFeatureMarker(featureMarker(issue))).toBe(true);
    }
  });

  it("recognizes a marker as a whole segment, never a prefix of one", () => {
    for (const segment of ["f", "fa", "f1a", "feature", "af1", "F1", ""]) expect(isFeatureMarker(segment)).toBe(false);
  });

  it("refuses an environment whose first segment is a feature's marker", () => {
    for (const env of ["f1", "f12", "f01", "f1-demo", "f12-ab", "f123-x", "f0-a"]) {
      expect(isValidEnvironment(env), env).toBe(false);
    }
  });

  it("keeps every environment that merely starts with an f", () => {
    for (const env of ["feature", "fr", "fr-1", "f-1", "fa1", "f1a", "fix-f1"]) {
      expect(isValidEnvironment(env), env).toBe(true);
    }
  });

  it("says why, in the refusal a declaration carries", () => {
    const error = thrown(() => assertValidEnvironment("f1-demo"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as PithyError).payload.message).toContain("f1-demo");
    const parsed = DeclaredEnvironments.safeParse(["f1-demo", "prod"]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join(" ")).toContain("feature");
  });
});

describe("assertValidEnvironment", () => {
  it("passes a canonical environment through silently", () => {
    for (const env of ENVIRONMENTS) expect(() => assertValidEnvironment(env)).not.toThrow();
  });

  it("throws a ValidationError — an environment is something a human typed", () => {
    const error = thrown(() => assertValidEnvironment("Prod"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as PithyError).payload.status).toBe(400);
    expect((error as PithyError).payload.message).toContain("Prod");
  });

  it("answers `production` with the name that replaced it", () => {
    const error = thrown(() => assertValidEnvironment("production"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as PithyError).payload.action).toContain("prod");
  });

  it("names the length limit when the name is merely too long", () => {
    const error = thrown(() => assertValidEnvironment("integration"));
    expect((error as PithyError).payload.message).toContain(String(MAX_ENVIRONMENT_NAME));
  });
});

describe("DeclaredEnvironments", () => {
  it("defaults to staging and prod — the set a project has until it says otherwise", () => {
    expect([...DEFAULT_ENVIRONMENTS]).toEqual(["staging", "prod"]);
    expect(DeclaredEnvironments.parse([...DEFAULT_ENVIRONMENTS])).toEqual(["staging", "prod"]);
  });

  it("keeps the declared order — it is the order provisioning walks", () => {
    expect(DeclaredEnvironments.parse(["prod", "staging"])).toEqual(["prod", "staging"]);
  });

  it("takes an environment core never heard of, so long as the naming rule accepts it", () => {
    expect(DeclaredEnvironments.parse(["staging", "live"])).toEqual(["staging", "live"]);
  });

  it("refuses an empty declaration — a project with no environments cannot deploy at all", () => {
    const parsed = DeclaredEnvironments.safeParse([]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join(" ")).toContain("at least one");
  });

  it("refuses `dev` — it is local, always present, and never declared", () => {
    const parsed = DeclaredEnvironments.safeParse(["dev", "prod"]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join(" ")).toContain("dev");
  });

  it("refuses `global` — the scope beside the environments, by the same rule as everywhere else", () => {
    expect(DeclaredEnvironments.safeParse([GLOBAL_SCOPE]).success).toBe(false);
  });

  /**
   * **`feature` is a legal environment name and an illegal declaration, and the two are not in tension.**
   *
   * It has to be legal: it is a real `env.feature` wrangler key, so every rule that governs a stanza key
   * governs it. It cannot be declared, because a declared environment's ids are source — written into the
   * tracked `wrangler.jsonc` — while a feature's are a build artifact under `.wrangler/`. A project
   * declaring it would own two files claiming one stanza, and `wranglerConfigPath` resolves that name to
   * the generated one, so a migrate would read bytes the provision never wrote.
   *
   * This is what makes "`pithy provision --env` cannot reach a feature's environment" true by
   * construction rather than by a check: `--env` admits only what the project declared.
   */
  it("refuses `feature` — a branch's environment is a stanza no project declares", () => {
    const parsed = DeclaredEnvironments.safeParse([FEATURE_ENVIRONMENT, "prod"]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join(" ")).toContain(FEATURE_ENVIRONMENT);
    // And still a legal name, because it is a stanza key wrangler reads.
    expect(isValidEnvironment(FEATURE_ENVIRONMENT)).toBe(true);
  });

  it("refuses a duplicate — two of one environment is two of one set of resource names", () => {
    const parsed = DeclaredEnvironments.safeParse(["prod", "prod"]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join(" ")).toContain("twice");
  });

  it("refuses a name the naming rule refuses, with that rule's own sentence", () => {
    for (const bad of ["production", "Prod", "integration", "2prod", ""]) {
      expect(DeclaredEnvironments.safeParse(["staging", bad]).success).toBe(false);
    }
  });
});
