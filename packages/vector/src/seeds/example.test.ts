// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { describe, expect, it } from "vitest";
import { VectorDocument } from "../data/document";
import { VECTOR_DOCUMENTS_TABLE } from "../data/tables";
import { vectorExampleSeed } from "./example";

describe("vectorExampleSeed", () => {
  it("is an example set, never targeting production", () => {
    expect(vectorExampleSeed.example).toBe(true);
    expect(vectorExampleSeed.environments).toEqual(["dev", "staging"]);
  });

  it("writes into the corpus table on the app database", () => {
    expect(vectorExampleSeed.d1?.[0]?.database).toBe("app");
    expect(vectorExampleSeed.d1?.[0]?.table).toBe(VECTOR_DOCUMENTS_TABLE);
  });

  it("belongs to the shared example cast, so a seeded backend is connected rather than isolated", () => {
    const owners = (vectorExampleSeed.d1?.[0]?.rows ?? []).map(
      (row) => (row as { metadata: { ownerId: string } }).metadata.ownerId,
    );
    expect(owners).toEqual([EXAMPLE_ADA.id, EXAMPLE_GRACE.id, EXAMPLE_ALAN.id]);
  });

  it("leaves every row unembedded — a seed cannot call Workers AI, and reprocess is the next step", () => {
    for (const row of vectorExampleSeed.d1?.[0]?.rows ?? []) {
      expect((row as { model: string | null }).model).toBeNull();
      expect((row as { content: string | null }).content).toBeTypeOf("string");
    }
  });

  it("round-trips every row through the table's codecs", () => {
    for (const row of vectorExampleSeed.d1?.[0]?.rows ?? []) {
      const value = row as VectorDocument;
      expect(VectorDocument.parse(VectorDocument.encode(value))).toEqual(value);
    }
  });
});
