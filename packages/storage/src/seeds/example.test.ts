import { composeSeeds } from "@pithy-sh/core/src/seed/compose";
import { describe, expect, it } from "vitest";
import { storage } from "../capability";
import { StorageObject } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE } from "../data/tables";
import { storageExampleSeed } from "./example";

describe("storageExampleSeed", () => {
  it("is flagged as an example, and never lists production", () => {
    expect(storageExampleSeed.example).toBe(true);
    expect(storageExampleSeed.environments).toEqual(["dev", "staging"]);
  });

  it("seeds rows for the canonical cast into the app database", () => {
    const [group] = storageExampleSeed.d1 ?? [];
    expect(group?.database).toBe("app");
    expect(group?.table).toBe(STORAGE_OBJECTS_TABLE);
    expect(group?.rows).toHaveLength(3);
    const owners = group?.rows.map((row) => (row as { ownerId: string }).ownerId) ?? [];
    expect(owners).toEqual(["example-ada", "example-grace", "example-ada"]);
  });

  it("every row encodes cleanly — a bad fixture fails here, not at write time", () => {
    for (const row of storageExampleSeed.d1?.[0]?.rows ?? []) {
      expect(() => StorageObject.encode(row as StorageObject)).not.toThrow();
    }
  });

  it("seeds the bytes too, so a fresh environment can actually serve a demo download", () => {
    const objects = storageExampleSeed.r2 ?? [];
    expect(objects).toHaveLength(3);
    expect(objects.every((object) => object.binding === "STORAGE_BUCKET")).toBe(true);
  });

  it("every seeded row's key has a seeded object, and every object has a row", () => {
    const rowKeys = (storageExampleSeed.d1?.[0]?.rows ?? []).map((row) => (row as { key: string }).key).sort();
    const objectKeys = (storageExampleSeed.r2 ?? []).map((object) => object.key).sort();
    // A row with no object is exactly the divergence the sweep exists to reconcile; a fixture must
    // not ship one.
    expect(rowKeys).toEqual(objectKeys);
  });

  it("each row's declared size is the byte length of the object actually seeded", () => {
    const bodies = new Map(
      (storageExampleSeed.r2 ?? []).map((object) => [
        object.key,
        typeof object.body === "string" ? new TextEncoder().encode(object.body).length : object.body.length,
      ]),
    );
    for (const row of storageExampleSeed.d1?.[0]?.rows ?? []) {
      const { key, size } = row as { key: string; size: number };
      expect(size).toBe(bodies.get(key));
    }
  });

  it("includes one public file, so the unauthenticated read path is in the demo data", () => {
    const visibilities = (storageExampleSeed.d1?.[0]?.rows ?? []).map(
      (row) => (row as { visibility: string }).visibility,
    );
    expect(visibilities).toContain("public");
    expect(visibilities.filter((visibility) => visibility === "private")).toHaveLength(2);
  });
});

describe("storage() with seed.includeExamples", () => {
  it("composes the example set only when includeExamples is on", () => {
    const capability = storage();

    expect(composeSeeds([capability], { env: "dev", includeExamples: false }).sets).toHaveLength(0);
    const withExamples = composeSeeds([capability], { env: "dev", includeExamples: true });
    expect(withExamples.sets).toHaveLength(1);
    expect(withExamples.sets[0]?.key).toContain("storage");
  });

  it("never composes the example set for production, even with includeExamples on", () => {
    const result = composeSeeds([storage()], { env: "production", includeExamples: true });
    expect(result.sets).toHaveLength(0);
    expect(result.skippedByEnv.length).toBeGreaterThan(0);
  });

  it("sorts at 230 — after auth's users (100), which own these files", () => {
    expect(storageExampleSeed.order).toBe(230);
  });
});
