import { composeSeeds } from "@pithy-sh/core/src/seed/compose";
import { EXAMPLE_IDENTITIES } from "@pithy-sh/core/src/seed/exampleIdentities";
import { describe, expect, it } from "vitest";
import { auth } from "../capability";
import { authExampleSeed } from "./example";

describe("authExampleSeed", () => {
  it("is flagged as an example", () => {
    expect(authExampleSeed.example).toBe(true);
  });

  it("never lists production — an example fixture is dev/staging only", () => {
    expect(authExampleSeed.environments).not.toContain("production");
    expect(authExampleSeed.environments).toEqual(["dev", "staging"]);
  });

  it("seeds the canonical demo identities into the app database", () => {
    expect(authExampleSeed.d1).toHaveLength(1);
    const [group] = authExampleSeed.d1 ?? [];
    expect(group?.database).toBe("app");
    expect(group?.table).toBe("pithyAuthUsers");
    expect(group?.rows).toHaveLength(3);
    const ids = (group?.rows ?? []).map((row) => (row as { id: string }).id);
    expect(ids).toEqual(EXAMPLE_IDENTITIES.map((identity) => identity.id));
  });
});

describe("auth() with seed.includeExamples", () => {
  it("composes the example set only when includeExamples is on", () => {
    const capability = auth({ baseURL: "https://api.example.com" });

    const withoutExamples = composeSeeds([capability], { env: "dev", includeExamples: false });
    expect(withoutExamples.sets).toHaveLength(0);

    const withExamples = composeSeeds([capability], { env: "dev", includeExamples: true });
    expect(withExamples.sets).toHaveLength(1);
    expect(withExamples.sets[0]?.key).toContain("auth");
  });

  it("never composes the example set for production, even with includeExamples on", () => {
    const capability = auth({ baseURL: "https://api.example.com" });

    const result = composeSeeds([capability], { env: "production", includeExamples: true });
    expect(result.sets).toHaveLength(0);
    expect(result.skippedByEnv.length).toBeGreaterThan(0);
  });
});
