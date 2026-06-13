import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { availableManifests, loadManifest } from "./manifests";

describe("loadManifest", () => {
  test("an unknown capability fails with its name and a Phase 0 explanation", async () => {
    await expect(loadManifest("auth")).rejects.toThrow(PithyError);
    await expect(loadManifest("auth")).rejects.toThrow(/auth/);
  });
});

describe("availableManifests", () => {
  test("Phase 0 ships no capabilities — the registry is empty", () => {
    expect(availableManifests()).toEqual([]);
  });
});
