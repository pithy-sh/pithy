// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PithyError, ValidationError } from "../error/pithyError";
import { MAX_ENVIRONMENT_NAME } from "./environment";
import { FEATURE_DERIVED_PROJECT_NAME, MAX_CAPABILITY_JOB, WORKFLOW_DERIVED_PROJECT_NAME } from "./limits";
import {
  assertValidProjectName,
  fitSegment,
  hash6,
  isReservedProjectName,
  isValidProjectName,
  kebab,
  MAX_PROJECT_NAME,
  MAX_RESOURCE_NAME,
  RESERVED_TEST_PREFIX,
  resourceName,
} from "./resource";

/** Run `act` and hand back whatever it threw, so a test can assert on the payload rather than the message. */
function thrown(act: () => unknown): unknown {
  try {
    act();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("kebab", () => {
  it("lowercases, collapses non-alphanumeric runs, and trims the edges", () => {
    expect(kebab("Acme")).toBe("acme");
    expect(kebab("Acme Corp")).toBe("acme-corp");
    expect(kebab("acme__corp")).toBe("acme-corp");
    expect(kebab("--acme--corp--")).toBe("acme-corp");
    expect(kebab("Acme.Corp/Games")).toBe("acme-corp-games");
  });

  it("is idempotent — a kebab name passes through unchanged", () => {
    expect(kebab(kebab("Acme Corp!"))).toBe(kebab("Acme Corp!"));
  });
});

describe("hash6", () => {
  it("returns six lowercase hex characters", () => {
    expect(hash6("anything")).toMatch(/^[0-9a-f]{6}$/);
  });

  it("is deterministic in its input alone", () => {
    expect(hash6("storage-credentials")).toBe(hash6("storage-credentials"));
  });

  it("separates inputs that share a long prefix — the truncation case it exists for", () => {
    expect(hash6("a-very-long-capability-name-one")).not.toBe(hash6("a-very-long-capability-name-two"));
  });
});

describe("fitSegment", () => {
  it("passes a segment through when it fits", () => {
    expect(fitSegment("storage", 20)).toBe("storage");
  });

  it("never exceeds the budget", () => {
    for (const budget of [1, 2, 3, 4, 8, 12, 30]) {
      expect(fitSegment("a-very-long-segment-that-will-not-fit", budget).length).toBeLessThanOrEqual(budget);
    }
  });

  it("never trails a hyphen", () => {
    for (const budget of [4, 5, 6, 9, 14, 21]) {
      expect(fitSegment("a-very-long-segment-that-will-not-fit", budget)).not.toMatch(/-$/);
    }
  });

  it("satisfies R2's charset at every budget — alphanumeric at both ends", () => {
    // R2 is the one namespace with a rule about the *edges* of a bucket name, and the thing segment is
    // the only one truncation ever touches, so this is where that rule is either kept or broken.
    for (const segment of ["storage", "a-very-long-segment-that-will-not-fit", "media-bucket-for-user-uploads"]) {
      for (let budget = 1; budget <= 40; budget += 1) {
        const fitted = fitSegment(segment, budget);
        expect(fitted).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
        expect(fitted.length).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("is deterministic in the segment alone", () => {
    expect(fitSegment("some-long-capability-name", 12)).toBe(fitSegment("some-long-capability-name", 12));
  });

  it("keeps two distinct long segments distinct at the same budget", () => {
    const a = fitSegment("an-extremely-long-capability-name-alpha", 16);
    const b = fitSegment("an-extremely-long-capability-name-omega", 16);
    expect(a).not.toBe(b);
  });

  it("returns nothing for a non-positive budget", () => {
    expect(fitSegment("storage", 0)).toBe("");
    expect(fitSegment("storage", -3)).toBe("");
  });
});

describe("resourceName", () => {
  it("composes <project>-<env>-<thing>, project first and environment second", () => {
    expect(resourceName({ project: "acme", env: "prod", thing: "storage" })).toBe("acme-prod-storage");
  });

  it("kebabs every segment, so a human-typed project name still yields a legal name", () => {
    expect(resourceName({ project: "Acme Corp", env: "prod", thing: "Media Sweep" })).toBe(
      "acme-corp-prod-media-sweep",
    );
  });

  it("sorts a project's environments together — the reason the environment is second", () => {
    const names = [
      resourceName({ project: "acme", env: "staging", thing: "storage" }),
      resourceName({ project: "acme", env: "prod", thing: "media" }),
      resourceName({ project: "acme", env: "prod", thing: "storage" }),
      resourceName({ project: "beta", env: "prod", thing: "storage" }),
    ].sort();
    expect(names).toEqual(["acme-prod-media", "acme-prod-storage", "acme-staging-storage", "beta-prod-storage"]);
  });

  it("gives two projects different names for the same capability and environment", () => {
    const a = resourceName({ project: "acme", env: "prod", thing: "storage" });
    const b = resourceName({ project: "beta", env: "prod", thing: "storage" });
    expect(a).not.toBe(b);
  });

  it("takes `global` in the environment slot, so a global secret is not an exception to the rule", () => {
    expect(resourceName({ project: "acme", env: "global", thing: "secrets-manager-cf-api-token" })).toBe(
      "acme-global-secrets-manager-cf-api-token",
    );
  });

  it("stays within the budget by truncating only the thing segment", () => {
    const name = resourceName({
      project: "acme",
      env: "prod",
      thing: "an-extremely-long-capability-name-that-cannot-possibly-fit-inside-the-budget",
    });
    expect(name.length).toBeLessThanOrEqual(MAX_RESOURCE_NAME);
    expect(name.startsWith("acme-prod-")).toBe(true);
  });

  it("never truncates or hashes the project segment, so two projects can never collide on a prefix", () => {
    // A hashed project segment would let two long project names share a prefix, and the token
    // listing filters on exactly that prefix — one project would enumerate another's tokens.
    const long = "acme-multiplayer-games"; // 22, just inside the cap
    const name = resourceName({
      project: long,
      env: "prod",
      thing: "an-overlong-capability-name-that-must-absorb-the-truncation",
    });
    expect(name.startsWith(`${long}-prod-`)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(MAX_RESOURCE_NAME);
  });

  it("refuses a project and environment that cannot fit, naming the limit", () => {
    const project = "x".repeat(MAX_RESOURCE_NAME);
    expect(() => resourceName({ project, env: "prod", thing: "storage" })).toThrowError(PithyError);
    // The environment carries no cap of its own — a project inside {@link MAX_PROJECT_NAME} can still
    // be handed an environment name that leaves the thing segment nothing, and that is refused too.
    const env = "x".repeat(MAX_RESOURCE_NAME);
    expect(() => resourceName({ project: "acme", env, thing: "storage" })).toThrowError(PithyError);
  });

  it("refuses a project longer than every namespace can carry, before anything is provisioned", () => {
    // 33 characters. It composes a legal bucket and a legal database, and then the first host deploy
    // refuses `<project>-prod-media-video-transcribe` — half-provisioned.
    const project = "northwind-traders-mobile-platform";
    expect(() => resourceName({ project, env: "prod", thing: "media" })).toThrowError(ValidationError);
  });

  it("honors a caller-supplied budget, for a namespace with its own limit", () => {
    const name = resourceName({ project: "acme", env: "prod", thing: "storage-credentials" }, 24);
    expect(name.length).toBeLessThanOrEqual(24);
  });

  it("rejects an empty project rather than producing a leading hyphen", () => {
    expect(() => resourceName({ project: "", env: "prod", thing: "storage" })).toThrowError(PithyError);
    expect(() => resourceName({ project: "!!!", env: "prod", thing: "storage" })).toThrowError(PithyError);
  });

  it("rejects an empty environment or thing", () => {
    expect(() => resourceName({ project: "acme", env: "", thing: "storage" })).toThrowError(PithyError);
    expect(() => resourceName({ project: "acme", env: "prod", thing: "" })).toThrowError(PithyError);
  });

  it("refuses a project whose kebabbed form does not start with a letter", () => {
    // `1password-clone` composed a perfectly good `1password-clone-dev-db` here, provisioned it, and
    // then died on the first host-worker deploy — the namer downstream refuses a digit-leading project.
    // One rule or the other: the composer holds the same line, so no project can get half-provisioned.
    expect(() => resourceName({ project: "1password-clone", env: "dev", thing: "db" })).toThrowError(ValidationError);
    expect(() => resourceName({ project: "2026-launch", env: "prod", thing: "storage" })).toThrowError(ValidationError);
  });
});

describe("MAX_PROJECT_NAME", () => {
  it("is the smaller of the two shapes a project name has to survive", () => {
    // The arithmetic of each derivation is pinned in `limits.test.ts`, next to the constants it is
    // written from. What belongs here is the only thing this module decides: that the answer is the
    // *minimum*, not the Workflow shape alone, which is what it used to be.
    expect(MAX_PROJECT_NAME).toBe(Math.min(WORKFLOW_DERIVED_PROJECT_NAME, FEATURE_DERIVED_PROJECT_NAME));
    expect(MAX_CAPABILITY_JOB).toBe("media-audio-transcribe".length);
    expect(MAX_PROJECT_NAME).toBe(26);
  });

  it("leaves the worst Workflow name inside its 64, with room to spare", () => {
    // Room to spare because the feature shape is the tighter of the two. `workflow/naming.test.ts`
    // proves the composed name; this is the budget it rests on.
    expect(MAX_PROJECT_NAME + 1 + MAX_ENVIRONMENT_NAME + 1 + MAX_CAPABILITY_JOB).toBeLessThanOrEqual(64);
  });

  it("still leaves a usable thing segment inside the resource-name budget", () => {
    const name = resourceName({ project: "a".repeat(MAX_PROJECT_NAME), env: "prod", thing: "storage" });
    expect(name.length).toBeLessThanOrEqual(MAX_RESOURCE_NAME);
    expect(name.endsWith("-storage")).toBe(true);
  });
});

describe("isValidProjectName", () => {
  it("accepts a name that kebabs into a legal Cloudflare segment", () => {
    for (const project of ["acme", "acme-corp", "Acme Corp", "PITHY", "a1", "acme2026", "pithy-app", "x"]) {
      expect(isValidProjectName(project)).toBe(true);
    }
  });

  it("accepts a name at exactly the cap and rejects the next character", () => {
    expect(isValidProjectName("a".repeat(MAX_PROJECT_NAME))).toBe(true);
    expect(isValidProjectName("a".repeat(MAX_PROJECT_NAME + 1))).toBe(false);
  });

  it("rejects the long names that used to pass every gate and fail at the first deploy", () => {
    for (const project of [
      "northwind-traders-mobile-platform", // 33
      "northwind-traders-mobile-platform-services-hub", // 46
      "northwind-traders-mobile-platform-services-and-orders", // 53
      "northwind-traders-mobile-platform-services-and-orders-europe", // 60
    ]) {
      expect(isValidProjectName(project)).toBe(false);
    }
  });

  it("measures the kebabbed form, because that is what Cloudflare counts", () => {
    // The raw string never reaches an account, so neither does its length. `Acme … Corp` is 34
    // characters raw and 9 once composed; `Northwind Traders Mobile Platform` is 33 either way.
    expect(kebab("Acme _______________________ Corp")).toBe("acme-corp");
    expect(isValidProjectName("Acme _______________________ Corp")).toBe(true);
    expect(isValidProjectName("Northwind Traders Mobile Platform")).toBe(false);
  });

  it("rejects a name whose kebabbed form does not start with a letter", () => {
    for (const project of ["1password-clone", "2026-launch", "9lives", "0"]) {
      expect(isValidProjectName(project)).toBe(false);
    }
  });

  it("rejects a name with nothing left after kebabbing", () => {
    for (const project of ["", "!!!", "---", "   "]) {
      expect(isValidProjectName(project)).toBe(false);
    }
  });

  it("reads the kebabbed form, because that is what Cloudflare sees", () => {
    // The raw string never reaches an account. `Acme Corp` is legal; `2026 Launch` is not, and neither
    // answer can be read off the raw characters.
    expect(isValidProjectName("Acme Corp")).toBe(true);
    expect(isValidProjectName("2026 Launch")).toBe(false);
  });
});

describe("assertValidProjectName", () => {
  it("passes a legal name through silently", () => {
    expect(() => assertValidProjectName("Acme Corp")).not.toThrow();
  });

  it("throws a ValidationError, not an InternalError — a project name is user input", () => {
    const error = thrown(() => assertValidProjectName("1password-clone"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as PithyError).payload.status).toBe(400);
    expect((error as PithyError).payload.message).toContain("1password-clone");
    expect((error as PithyError).payload.action).toContain("starting with a letter");
  });

  it("names the length limit when the name is merely too long", () => {
    // The adopter typed this, so the answer has to be the number and the fix, not "invalid name".
    const error = thrown(() => assertValidProjectName("northwind-traders-mobile-platform"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as PithyError).payload.status).toBe(400);
    expect((error as PithyError).payload.message).toContain("northwind-traders-mobile-platform");
    expect((error as PithyError).payload.message).toContain(String(MAX_PROJECT_NAME));
    expect((error as PithyError).payload.action).toContain(String(MAX_PROJECT_NAME));
  });

  it("passes a name at exactly the cap", () => {
    expect(() => assertValidProjectName("a".repeat(MAX_PROJECT_NAME))).not.toThrow();
  });
});

describe("isReservedProjectName", () => {
  it("accepts a name a real project could plausibly carry", () => {
    for (const project of [
      "acme",
      "pithy",
      "pithy-app",
      "pithysh",
      "pithy-internal",
      "pithy-integration",
      "pithy-interview-tool",
      "int",
      "my-pithy-int-app",
      "Acme Corp",
      "PITHY",
    ]) {
      expect(isReservedProjectName(project)).toBe(false);
    }
  });

  it("rejects a name inside the reservation", () => {
    for (const project of ["pithy-int-test", "pithy-int-anything", RESERVED_TEST_PREFIX]) {
      expect(isReservedProjectName(project)).toBe(true);
    }
  });

  it("rejects a name that only kebabs into the reservation", () => {
    // The first trap: `Pithy Int Ruse` is not prefixed by `pithy-int-`, and Cloudflare never sees the
    // raw string — it sees what the composer made of it.
    expect(isReservedProjectName("Pithy Int Ruse")).toBe(true);
    expect(isReservedProjectName("PITHY_INT_x")).toBe(true);
    expect(resourceName({ project: "Pithy Int Ruse", env: "prod", thing: "db" })).toMatch(/^pithy-int-/);
  });

  it("rejects the exact prefix without its hyphen, because the composer adds one", () => {
    // The second trap: `pithy-int` is not prefixed by `pithy-int-`, and it composes `pithy-int-dev-db`.
    expect(isReservedProjectName("pithy-int")).toBe(true);
    expect(resourceName({ project: "pithy-int", env: "dev", thing: "db" })).toMatch(/^pithy-int-/);
  });

  it("agrees with the names a project actually composes, in both directions", () => {
    for (const project of ["acme", "pithy", "pithy-integration", "pithy-int", "Pithy Int Ruse", "pithy-int-test"]) {
      for (const env of ["dev", "staging", "production", "global"]) {
        const reserved = resourceName({ project, env, thing: "db" }).startsWith(RESERVED_TEST_PREFIX);
        expect(reserved).toBe(isReservedProjectName(project));
      }
    }
  });
});
