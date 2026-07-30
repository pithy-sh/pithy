// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, it } from "vitest";
import { VectorIndexConfig } from "../config/config";
import { deleteVectors, queryVectors, upsertVectors, type VectorStore, type VectorUpsert } from "./index";
import { MAX_METADATA_BYTES, MAX_NAME_BYTES, MAX_UPSERT_BATCH, MAX_VECTOR_ID_BYTES } from "./limits";

const index = VectorIndexConfig.parse({ model: "@cf/baai/bge-base-en-v1.5", dimensions: 4 });

/** Records what reached the binding, so a test can assert what was sent as well as what came back. */
function fakeStore(overrides: Partial<VectorStore> = {}) {
  const calls: { upserts: VectorUpsert[][]; queries: { vector: number[]; options?: Record<string, unknown> }[] } = {
    upserts: [],
    queries: [],
  };
  const store: VectorStore = {
    upsert: async (vectors) => {
      calls.upserts.push(vectors);
      return { mutationId: "m1" };
    },
    query: async (vector, options) => {
      calls.queries.push({ vector, options });
      return { count: 1, matches: [{ id: "a", score: 0.9 }] };
    },
    deleteByIds: async () => ({ mutationId: "m2" }),
    ...overrides,
  };
  return { store, calls };
}

/** The code a thrown PithyError carries. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PithyError) return error.payload.code;
    throw error;
  }
  throw new Error("expected a PithyError");
}

const vector = (id: string, values = [1, 2, 3, 4]): VectorUpsert => ({ id, values });

describe("upsertVectors", () => {
  it("returns the mutation id — an acknowledgement, not a completed write", async () => {
    const { store, calls } = fakeStore();
    expect(await upsertVectors(store, index, [vector("a")])).toBe("m1");
    expect(calls.upserts[0]).toHaveLength(1);
  });

  it("rejects a vector whose length does not match the index's dimensions", async () => {
    const { store } = fakeStore();
    expect(await codeOf(() => upsertVectors(store, index, [vector("a", [1, 2, 3])]))).toBe("vector/dimension_mismatch");
  });

  it("rejects an id over 64 bytes — the index could never address it", async () => {
    const { store } = fakeStore();
    expect(await codeOf(() => upsertVectors(store, index, [vector("x".repeat(MAX_VECTOR_ID_BYTES + 1))]))).toBe(
      "validation/invalid_input",
    );
  });

  it("counts an id in bytes, not characters", async () => {
    const { store } = fakeStore();
    // 64 characters, 128 bytes.
    expect(await codeOf(() => upsertVectors(store, index, [vector("é".repeat(64))]))).toBe("validation/invalid_input");
  });

  it("accepts an id of exactly 64 bytes", async () => {
    const { store } = fakeStore();
    await expect(upsertVectors(store, index, [vector("x".repeat(MAX_VECTOR_ID_BYTES))])).resolves.toBe("m1");
  });

  describe("the 10 KiB metadata ceiling is exclusive", () => {
    /** Metadata whose compact JSON is exactly `size` bytes. The envelope `{"blob":""}` is 11 bytes. */
    const metadataOfSize = (size: number) => ({ blob: "x".repeat(size - 11) });

    it("the envelope arithmetic is right", () => {
      expect(JSON.stringify(metadataOfSize(MAX_METADATA_BYTES)).length).toBe(MAX_METADATA_BYTES);
    });

    it("accepts 10,239 bytes", async () => {
      const { store } = fakeStore();
      const metadata = metadataOfSize(MAX_METADATA_BYTES - 1);
      await expect(upsertVectors(store, index, [{ ...vector("a"), metadata }])).resolves.toBe("m1");
    });

    it("rejects 10,240 bytes — the limit is 'under 10 KiB', not 'at most'", async () => {
      const { store } = fakeStore();
      const metadata = metadataOfSize(MAX_METADATA_BYTES);
      expect(await codeOf(() => upsertVectors(store, index, [{ ...vector("a"), metadata }]))).toBe(
        "vector/metadata_too_large",
      );
    });
  });

  it("accepts a batch of exactly the Workers binding's 1,000", async () => {
    const { store } = fakeStore();
    const batch = Array.from({ length: MAX_UPSERT_BATCH }, (_, i) => vector(`v${i}`));
    await expect(upsertVectors(store, index, batch)).resolves.toBe("m1");
  });

  it("rejects a batch over the Workers binding's 1,000", async () => {
    const { store } = fakeStore();
    const batch = Array.from({ length: MAX_UPSERT_BATCH + 1 }, (_, i) => vector(`v${i}`));
    expect(await codeOf(() => upsertVectors(store, index, batch))).toBe("validation/invalid_input");
  });

  it("rejects an empty batch rather than making a pointless call", async () => {
    const { store } = fakeStore();
    expect(await codeOf(() => upsertVectors(store, index, []))).toBe("validation/invalid_input");
  });

  it("accepts a namespace of exactly 64 bytes", async () => {
    const { store } = fakeStore();
    const namespace = "n".repeat(MAX_NAME_BYTES);
    await expect(upsertVectors(store, index, [{ ...vector("a"), namespace }])).resolves.toBe("m1");
  });

  it("rejects a namespace over 64 bytes", async () => {
    const { store } = fakeStore();
    expect(
      await codeOf(() => upsertVectors(store, index, [{ ...vector("a"), namespace: "n".repeat(MAX_NAME_BYTES + 1) }])),
    ).toBe("validation/invalid_input");
  });

  it("refuses a response it does not recognize instead of returning a bad mutation id", async () => {
    const { store } = fakeStore({ upsert: async () => ({ ok: true }) });
    expect(await codeOf(() => upsertVectors(store, index, [vector("a")]))).toBe("core/internal");
  });
});

describe("queryVectors", () => {
  it("defaults topK to the configured default and asks for no payload", async () => {
    const { store, calls } = fakeStore();
    await queryVectors(store, index, [1, 2, 3, 4]);
    expect(calls.queries[0]?.options).toEqual({ topK: 10, returnValues: false, returnMetadata: false });
  });

  it("passes the namespace and the compiled filter through", async () => {
    const { store, calls } = fakeStore();
    await queryVectors(store, index, [1, 2, 3, 4], { namespace: "acme", filter: { tenantId: { $eq: "acme" } } });
    expect(calls.queries[0]?.options).toMatchObject({ namespace: "acme", filter: { tenantId: { $eq: "acme" } } });
  });

  it("falls back to the index's configured namespace", async () => {
    const scoped = VectorIndexConfig.parse({ model: "m", dimensions: 4, namespace: "tenants" });
    const { store, calls } = fakeStore();
    await queryVectors(store, scoped, [1, 2, 3, 4]);
    expect(calls.queries[0]?.options).toMatchObject({ namespace: "tenants" });
  });

  it("allows topK 100 when neither values nor metadata come back", async () => {
    const { store } = fakeStore();
    await expect(queryVectors(store, index, [1, 2, 3, 4], { topK: 100 })).resolves.toMatchObject({ count: 1 });
  });

  it("rejects topK 101 without payload", async () => {
    const { store } = fakeStore();
    expect(await codeOf(() => queryVectors(store, index, [1, 2, 3, 4], { topK: 101 }))).toBe("vector/topk_exceeded");
  });

  it("allows topK 50 with metadata, and rejects 51 — the payload lowers the ceiling", async () => {
    const { store } = fakeStore();
    await expect(queryVectors(store, index, [1, 2, 3, 4], { topK: 50, returnMetadata: true })).resolves.toMatchObject({
      count: 1,
    });
    expect(await codeOf(() => queryVectors(store, index, [1, 2, 3, 4], { topK: 51, returnMetadata: true }))).toBe(
      "vector/topk_exceeded",
    );
  });

  it("applies the same lowered ceiling when values come back — 50 allowed, 51 not", async () => {
    const { store } = fakeStore();
    await expect(queryVectors(store, index, [1, 2, 3, 4], { topK: 50, returnValues: true })).resolves.toMatchObject({
      count: 1,
    });
    expect(await codeOf(() => queryVectors(store, index, [1, 2, 3, 4], { topK: 51, returnValues: true }))).toBe(
      "vector/topk_exceeded",
    );
  });

  it("rejects a query vector of the wrong length", async () => {
    const { store } = fakeStore();
    expect(await codeOf(() => queryVectors(store, index, [1, 2]))).toBe("vector/dimension_mismatch");
  });

  it("rejects topK below one", async () => {
    const { store } = fakeStore();
    expect(await codeOf(() => queryVectors(store, index, [1, 2, 3, 4], { topK: 0 }))).toBe("validation/invalid_input");
  });

  it("rejects an oversized filter before it reaches Vectorize", async () => {
    const { store } = fakeStore();
    const filter = { tenantId: { $eq: "x".repeat(2048) } };
    expect(await codeOf(() => queryVectors(store, index, [1, 2, 3, 4], { filter }))).toBe("vector/filter_too_large");
  });

  it("refuses a response it does not recognize", async () => {
    const { store } = fakeStore({ query: async () => ({ matches: "nope" }) });
    expect(await codeOf(() => queryVectors(store, index, [1, 2, 3, 4]))).toBe("core/internal");
  });
});

describe("deleteVectors", () => {
  it("returns the mutation id", async () => {
    const { store } = fakeStore();
    expect(await deleteVectors(store, ["a"])).toBe("m2");
  });

  it("throws when the binding cannot delete, rather than silently doing nothing", async () => {
    const { store } = fakeStore();
    const withoutDelete: VectorStore = { upsert: store.upsert, query: store.query };
    expect(await codeOf(() => deleteVectors(withoutDelete, ["a"]))).toBe("core/internal");
  });
});
