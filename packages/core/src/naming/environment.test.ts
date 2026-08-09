// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type PithyError, ValidationError } from "../error/pithyError";
import {
  assertValidEnvironment,
  DEFAULT_ENVIRONMENTS,
  DeclaredEnvironments,
  ENVIRONMENTS,
  GLOBAL_SCOPE,
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
